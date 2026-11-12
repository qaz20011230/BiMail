/**
 * BiMail local dev backend — zero-dependency SQLite store（node:sqlite）。
 *
 * 只服务本地开发与集成测试：实现 docs/CONTRACT.md §3 与 SPEC §5.2/§5.3 的数据层约束。
 * 安全要点：
 * - 登录凭据只存 token 的 SHA-256，不存明文。
 * - 邀请 token 服务端只存 SHA-256，明文只在创建响应里出现一次。
 * - 恢复哈希只以 64 位小写 hex（客户端 SHA-256）形式入库。
 * - entry.created_at / client_uuid 仅供排序与幂等，绝不出现在任何响应里。
 * - seat.released_at：墙 closed 后主体可「离开」并释放座位（保留历史行）；
 *   活跃座位由部分唯一索引保证一人一墙（A1），released 行不参与唯一性。
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 业务错误：status 是 HTTP 状态，code ∈ src/lib/errors.ts 的 BackendErrorCode。 */
export class HttpError extends Error {
  constructor(status, code) {
    super(code)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

const RECOVERY_HASH_RE = /^[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY_CODEPOINTS = 8000
const MAX_PAGE_SIZE = 120
const DEFAULT_PAGE_SIZE = 120
const INVITE_TTL_DAYS = 7
const WRITTEN_ON_SKEW_DAYS = 2
const REBIND_LIMIT = 5
const REBIND_WINDOW = '-1 hour'

const SEAT_TABLE_COLUMNS = `(
  dyad_id TEXT NOT NULL REFERENCES dyad(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('a', 'b')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recovery_hash TEXT NOT NULL CHECK (length(recovery_hash) = 64),
  joined_on TEXT NOT NULL,
  released_at INTEGER,
  PRIMARY KEY (dyad_id, slot)
)`

function seatTableSql(tableName, ifNotExists = false) {
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} ${SEAT_TABLE_COLUMNS}`
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_on TEXT NOT NULL DEFAULT (date('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS dyad (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'nascent' CHECK (state IN ('nascent', 'open', 'closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A1「一人一墙」= active 座位（released_at IS NULL）内 user_id 唯一（部分唯一索引）；
-- ON DELETE RESTRICT = A4 的数据库级保护（历史座位同样阻挡删除）。
-- released_at 非 null 表示已离开该墙：保留历史行，slot / joined_on 不变。
${seatTableSql('seat', true)};

CREATE UNIQUE INDEX IF NOT EXISTS seat_active_user_uidx
  ON seat (user_id) WHERE released_at IS NULL;

-- seq 严格单调（AUTOINCREMENT 不复用）；created_at/client_uuid 永不出库。
CREATE TABLE IF NOT EXISTS entry (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  dyad_id TEXT NOT NULL REFERENCES dyad(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('a', 'b')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  written_on TEXT NOT NULL,
  client_uuid TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (dyad_id, client_uuid),
  FOREIGN KEY (dyad_id, slot) REFERENCES seat(dyad_id, slot)
);

CREATE INDEX IF NOT EXISTS entry_dyad_seq ON entry (dyad_id, seq);

CREATE TABLE IF NOT EXISTS invite (
  dyad_id TEXT PRIMARY KEY REFERENCES dyad(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_on TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS rebind_attempt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS rebind_attempt_user_time ON rebind_attempt (user_id, created_at);
`

function sha256hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function newOpaqueToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 服务端 UTC 日期 YYYY-MM-DD。 */
export function utcDate(now = new Date()) {
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`
}

function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number)
  return utcDate(new Date(Date.UTC(year, month - 1, day + days)))
}

function isServerDateDeltaWithin(raw, today, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const written = Date.UTC(year, month - 1, day)
  const check = new Date(written)
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return false
  }
  const [ty, tm, td] = today.split('-').map(Number)
  const delta = Math.round((written - Date.UTC(ty, tm - 1, td)) / 86_400_000)
  return Math.abs(delta) <= days
}

/** 非法 / 超出 ±2 日 → 服务端 UTC 日期（CONTRACT §3 post_entry）。 */
function clampWrittenOn(raw, today) {
  return typeof raw === 'string' && isServerDateDeltaWithin(raw, today, WRITTEN_ON_SKEW_DAYS)
    ? raw
    : today
}

function clampPageLimit(raw) {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return DEFAULT_PAGE_SIZE
  return Math.min(raw, MAX_PAGE_SIZE)
}

function entryView(row) {
  return {
    id: row.id,
    seq: row.seq,
    slot: row.slot,
    body: row.body,
    written_on: row.written_on,
  }
}

function sqliteIdentifier(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('unexpected SQLite identifier')
  return `"${name}"`
}

function hasTable(db, name) {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  )
}

function tableColumns(db, name) {
  return db
    .prepare(`PRAGMA table_info(${sqliteIdentifier(name)})`)
    .all()
    .map((row) => row.name)
}

function hasSingleColumnUniqueIndex(db, table, column) {
  const indexes = db.prepare(`PRAGMA index_list(${sqliteIdentifier(table)})`).all()
  for (const index of indexes) {
    if (index.unique !== 1 || index.origin !== 'u') continue
    const columns = db
      .prepare(`PRAGMA index_info(${sqliteIdentifier(index.name)})`)
      .all()
      .map((row) => row.name)
    if (columns.length === 1 && columns[0] === column) return true
  }
  return false
}

/**
 * 旧文件库迁移：seat.user_id 若仍是全局 UNIQUE（或缺少 released_at），
 * 重建 seat 表并保留全部行（released_at = null），再建 active 部分唯一索引。
 * 全新库 / 已迁移库为空操作。
 */
function migrateSeatSchema(db) {
  if (!hasTable(db, 'seat')) return
  const columns = tableColumns(db, 'seat')
  const legacyUnique = hasSingleColumnUniqueIndex(db, 'seat', 'user_id')
  if (columns.includes('released_at') && !legacyUnique) return

  const releasedSource = columns.includes('released_at') ? 'released_at' : 'NULL'
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DROP TABLE IF EXISTS seat__new')
      db.exec(seatTableSql('seat__new'))
      db.exec(
        `INSERT INTO seat__new (dyad_id, slot, user_id, recovery_hash, joined_on, released_at)
         SELECT dyad_id, slot, user_id, recovery_hash, joined_on, ${releasedSource} FROM seat`,
      )
      db.exec('DROP TABLE seat')
      db.exec('ALTER TABLE seat__new RENAME TO seat')
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS seat_active_user_uidx ON seat (user_id) WHERE released_at IS NULL',
      )
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 回滚失败时保留原始错误 */
      }
      throw error
    }
    const violations = db.prepare('PRAGMA foreign_key_check').all()
    if (violations.length > 0) throw new Error('seat 表迁移后外键校验失败')
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

export class Store {
  #db

  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
    this.#db = new DatabaseSync(filename)
    this.#db.exec('PRAGMA foreign_keys = ON')
    this.#db.exec('PRAGMA busy_timeout = 5000')
    if (filename !== ':memory:') {
      try {
        this.#db.exec('PRAGMA journal_mode = WAL')
      } catch {
        /* WAL 不可用（只读介质等）时退化为普通日志，不影响契约 */
      }
    }
    migrateSeatSchema(this.#db)
    this.#db.exec(SCHEMA)
  }

  close() {
    this.#db.close()
  }

  #tx(fn) {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK')
      } catch {
        /* 回滚失败时保留原始错误 */
      }
      throw error
    }
  }

  /** 当前 active 座位（已离开的墙不算在座）。 */
  #seatFor(userId) {
    return (
      this.#db
        .prepare('SELECT dyad_id, slot FROM seat WHERE user_id = ? AND released_at IS NULL')
        .get(userId) ?? null
    )
  }

  #dyadState(dyadId) {
    return this.#db.prepare('SELECT state FROM dyad WHERE id = ?').get(dyadId)?.state ?? null
  }

  /**
   * 唯一读快照构造。invite 只在 create_wall 的响应里出现一次：
   * 服务端只存 token 哈希，之后无法回显明文（CONTRACT §3 + SPEC §5.5）。
   */
  #snapshot(seat, invite = null) {
    const dyad = this.#db.prepare('SELECT id, state FROM dyad WHERE id = ?').get(seat.dyad_id)
    if (!dyad) throw new HttpError(500, 'unknown')
    const seats = this.#db
      .prepare('SELECT slot, joined_on FROM seat WHERE dyad_id = ? ORDER BY slot')
      .all(seat.dyad_id)
    return {
      dyad_id: dyad.id,
      state: dyad.state,
      my_slot: seat.slot,
      seats: seats.map((row) => ({ slot: row.slot, joined_on: row.joined_on })),
      invite,
    }
  }

  // ——— 匿名登录凭据 ———

  createAnonymousSession() {
    const userId = randomUUID()
    const accessToken = newOpaqueToken()
    const refreshToken = newOpaqueToken()
    this.#tx(() => {
      this.#db.prepare('INSERT INTO users (id) VALUES (?)').run(userId)
      this.#db
        .prepare('INSERT INTO sessions (user_id, access_hash, refresh_hash) VALUES (?, ?, ?)')
        .run(userId, sha256hex(accessToken), sha256hex(refreshToken))
    })
    return { user_id: userId, access_token: accessToken, refresh_token: refreshToken }
  }

  /** refresh token 轮换 access + refresh（旧 token 即时失效）；无效返回 null。 */
  refreshSession(refreshToken) {
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) return null
    const row = this.#db
      .prepare('SELECT id, user_id FROM sessions WHERE refresh_hash = ?')
      .get(sha256hex(refreshToken))
    if (!row) return null
    const accessToken = newOpaqueToken()
    const nextRefreshToken = newOpaqueToken()
    this.#db
      .prepare('UPDATE sessions SET access_hash = ?, refresh_hash = ? WHERE id = ?')
      .run(sha256hex(accessToken), sha256hex(nextRefreshToken), row.id)
    return {
      user_id: row.user_id,
      access_token: accessToken,
      refresh_token: nextRefreshToken,
    }
  }

  /** 解析 Bearer access token（只比对 SHA-256）。 */
  authenticate(accessToken) {
    if (typeof accessToken !== 'string' || accessToken.length === 0) return null
    const row = this.#db
      .prepare('SELECT id AS session_id, user_id FROM sessions WHERE access_hash = ?')
      .get(sha256hex(accessToken))
    if (!row) return null
    return { userId: row.user_id, sessionId: row.session_id }
  }

  /** 注销该 user 除当前 session 外的全部登录凭据；幂等。 */
  revokeOtherSessions(userId, sessionId) {
    this.#db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?')
      .run(userId, sessionId)
    return {}
  }

  // ——— 墙 ———

  createWall(userId, recoveryHash) {
    if (this.#seatFor(userId)) throw new HttpError(409, 'already_seated')
    if (typeof recoveryHash !== 'string' || !RECOVERY_HASH_RE.test(recoveryHash)) {
      throw new HttpError(400, 'invalid_hash')
    }
    return this.#tx(() => {
      const dyadId = randomUUID()
      const today = utcDate()
      const token = newOpaqueToken(24) // 24 字节 → 32 字符 base64url
      const expiresOn = addDays(today, INVITE_TTL_DAYS)
      this.#db.prepare('INSERT INTO dyad (id, state) VALUES (?, ?)').run(dyadId, 'nascent')
      this.#db
        .prepare('INSERT INTO seat (dyad_id, slot, user_id, recovery_hash, joined_on) VALUES (?, ?, ?, ?, ?)')
        .run(dyadId, 'a', userId, recoveryHash, today)
      this.#db
        .prepare('INSERT INTO invite (dyad_id, token_hash, expires_on) VALUES (?, ?, ?)')
        .run(dyadId, sha256hex(token), expiresOn)
      const seat = { dyad_id: dyadId, slot: 'a' }
      return this.#snapshot(seat, { token, expires_on: expiresOn })
    })
  }

  acceptInvite(userId, token, recoveryHash) {
    if (this.#seatFor(userId)) throw new HttpError(409, 'already_seated')
    if (typeof recoveryHash !== 'string' || !RECOVERY_HASH_RE.test(recoveryHash)) {
      throw new HttpError(400, 'invalid_hash')
    }
    const tokenHash = sha256hex(typeof token === 'string' ? token : '')
    return this.#tx(() => {
      const invite = this.#db
        .prepare('SELECT dyad_id, expires_on, consumed_at FROM invite WHERE token_hash = ?')
        .get(tokenHash)
      if (!invite) throw new HttpError(404, 'invite_unknown')
      if (invite.consumed_at) throw new HttpError(409, 'invite_consumed')
      const today = utcDate()
      if (invite.expires_on < today) throw new HttpError(410, 'invite_expired')
      const state = this.#dyadState(invite.dyad_id)
      if (state !== 'nascent') throw new HttpError(409, 'invite_consumed')
      const seatCount = this.#db
        .prepare('SELECT COUNT(*) AS n FROM seat WHERE dyad_id = ?')
        .get(invite.dyad_id).n
      if (seatCount >= 2) throw new HttpError(409, 'invite_consumed')
      this.#db
        .prepare('INSERT INTO seat (dyad_id, slot, user_id, recovery_hash, joined_on) VALUES (?, ?, ?, ?, ?)')
        .run(invite.dyad_id, 'b', userId, recoveryHash, today)
      this.#db.prepare("UPDATE dyad SET state = 'open' WHERE id = ?").run(invite.dyad_id)
      this.#db
        .prepare('UPDATE invite SET consumed_at = ? WHERE dyad_id = ?')
        .run(new Date().toISOString(), invite.dyad_id)
      return this.#snapshot({ dyad_id: invite.dyad_id, slot: 'b' })
    })
  }

  wallState(userId) {
    const seat = this.#seatFor(userId)
    if (!seat) throw new HttpError(409, 'no_seat')
    return this.#snapshot(seat)
  }

  listEntries(userId, beforeSeq, pageLimit) {
    const seat = this.#seatFor(userId)
    if (!seat) return { entries: [], has_more: false }
    const limit = clampPageLimit(pageLimit)
    const before =
      typeof beforeSeq === 'number' && Number.isFinite(beforeSeq) ? beforeSeq : null
    const rows =
      before === null
        ? this.#db
            .prepare(
              'SELECT id, seq, slot, body, written_on FROM entry WHERE dyad_id = ? ORDER BY seq DESC LIMIT ?',
            )
            .all(seat.dyad_id, limit + 1)
        : this.#db
            .prepare(
              'SELECT id, seq, slot, body, written_on FROM entry WHERE dyad_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
            )
            .all(seat.dyad_id, before, limit + 1)
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    return { entries: page.reverse().map(entryView), has_more: hasMore }
  }

  postEntry(userId, input) {
    const seat = this.#seatFor(userId)
    if (!seat) throw new HttpError(409, 'no_seat')
    const clientUuid = typeof input?.client_uuid === 'string' ? input.client_uuid.toLowerCase() : ''

    // 幂等重放优先于一切：即使墙已 closed 也返回已存在的记录。
    const existing = this.#db
      .prepare(
        'SELECT id, seq, slot, body, written_on FROM entry WHERE dyad_id = ? AND client_uuid = ?',
      )
      .get(seat.dyad_id, clientUuid)
    if (existing) return { entry: entryView(existing), duplicate: true }

    if (this.#dyadState(seat.dyad_id) === 'closed') throw new HttpError(409, 'wall_closed')

    if (!UUID_RE.test(clientUuid)) throw new HttpError(400, 'invalid_uuid')
    const body = input?.body
    if (typeof body !== 'string' || body.trim().length === 0 || [...body].length > MAX_BODY_CODEPOINTS) {
      throw new HttpError(400, 'invalid_body')
    }
    const writtenOn = clampWrittenOn(input?.written_on, utcDate())
    const entryId = randomUUID()
    try {
      this.#db
        .prepare(
          'INSERT INTO entry (id, dyad_id, slot, body, written_on, client_uuid) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(entryId, seat.dyad_id, seat.slot, body, writtenOn, clientUuid)
    } catch (error) {
      // 并发/重放窗口：唯一约束命中后返回已存在的那一行。
      if (String(error?.code ?? '').startsWith('ERR_SQLITE_ERROR') || /UNIQUE/i.test(String(error?.message))) {
        const row = this.#db
          .prepare(
            'SELECT id, seq, slot, body, written_on FROM entry WHERE dyad_id = ? AND client_uuid = ?',
          )
          .get(seat.dyad_id, clientUuid)
        if (row) return { entry: entryView(row), duplicate: true }
      }
      throw error
    }
    const row = this.#db
      .prepare('SELECT id, seq, slot, body, written_on FROM entry WHERE id = ?')
      .get(entryId)
    return { entry: entryView(row), duplicate: false }
  }

  rebindSeat(userId, recoveryHash) {
    // 限流先于一切处理：失败与通过都计（CONTRACT §3 rebind_seat）。
    const attempts = this.#db
      .prepare(
        "SELECT COUNT(*) AS n FROM rebind_attempt WHERE user_id = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)",
      )
      .get(userId, REBIND_WINDOW).n
    if (attempts >= REBIND_LIMIT) throw new HttpError(429, 'throttled')
    this.#db.prepare('INSERT INTO rebind_attempt (user_id) VALUES (?)').run(userId)

    if (this.#seatFor(userId)) throw new HttpError(409, 'already_seated')
    if (typeof recoveryHash !== 'string' || !RECOVERY_HASH_RE.test(recoveryHash)) {
      throw new HttpError(400, 'invalid_hash')
    }
    return this.#tx(() => {
      const target = this.#db
        .prepare('SELECT dyad_id, slot FROM seat WHERE recovery_hash = ? AND released_at IS NULL')
        .get(recoveryHash)
      if (!target) throw new HttpError(400, 'invalid_hash')
      if (this.#dyadState(target.dyad_id) === 'closed') throw new HttpError(409, 'wall_closed')
      this.#db
        .prepare('UPDATE seat SET user_id = ? WHERE dyad_id = ? AND slot = ?')
        .run(userId, target.dyad_id, target.slot)
      return this.#snapshot(target)
    })
  }

  /**
   * 离开已关闭的墙：硬删自己 slot 的留言，标记 released_at（保留历史座位行）。
   * 之后 create_wall 可用；活跃墙仍一人一墙（部分唯一索引）。
   */
  leaveClosedWall(userId) {
    const seat = this.#seatFor(userId)
    if (!seat) throw new HttpError(409, 'no_seat')
    if (this.#dyadState(seat.dyad_id) !== 'closed') {
      throw new HttpError(409, 'wall_not_closed')
    }
    this.#tx(() => {
      this.#db
        .prepare('DELETE FROM entry WHERE dyad_id = ? AND slot = ?')
        .run(seat.dyad_id, seat.slot)
      this.#db
        .prepare('UPDATE seat SET released_at = ? WHERE dyad_id = ? AND slot = ?')
        .run(Date.now(), seat.dyad_id, seat.slot)
    })
    return {}
  }

  closeAndErase(userId) {
    const seat = this.#seatFor(userId)
    if (!seat) throw new HttpError(409, 'no_seat')
    this.#tx(() => {
      this.#db
        .prepare('DELETE FROM entry WHERE dyad_id = ? AND slot = ?')
        .run(seat.dyad_id, seat.slot)
      this.#db.prepare("UPDATE dyad SET state = 'closed' WHERE id = ?").run(seat.dyad_id)
      this.#db.prepare('DELETE FROM invite WHERE dyad_id = ?').run(seat.dyad_id)
    })
    return {}
  }
}
