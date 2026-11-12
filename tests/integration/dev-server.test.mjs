/**
 * local 后端 HTTP 契约验收（docs/CONTRACT.md §3 / §4.4）。
 *
 * 每个用例都只通过 HTTP 与真实 dev server 子进程交互；文件库场景另开 SQLite 连接做
 * 运维级断言（邀请过期、外键 RESTRICT、多登录凭据注销）。测试端口一律由系统分配（PORT=0）。
 */

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, it } from 'node:test'
import { createApi, sleep, startBackend } from './helpers.mjs'

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const todayUtc = () => new Date().toISOString().slice(0, 10)
const addDaysUtc = (isoDate, days) => {
  const [year, month, day] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}
const B64URL_32 = /^[A-Za-z0-9_-]{32}$/

let backend
let api

before(async () => {
  backend = await startBackend()
  api = createApi(backend.baseUrl)
})

after(async () => {
  await backend?.stop()
})

async function anonymousSession() {
  const response = await api.anonymous()
  assert.equal(response.status, 201, `anonymous 应返回 201，实际 ${response.status}`)
  return response.json
}

/** 建一堵墙 + 一名接受者，返回双人上下文。 */
async function pairedWall() {
  const creator = await anonymousSession()
  const creatorHash = sha256(`creator-${randomUUID()}`)
  const created = await api.createWall(creator.access_token, creatorHash)
  assert.equal(created.status, 200, JSON.stringify(created.json))
  const inviteToken = created.json.snapshot.invite.token

  const acceptor = await anonymousSession()
  const acceptorHash = sha256(`acceptor-${randomUUID()}`)
  const accepted = await api.acceptInvite(acceptor.access_token, inviteToken, acceptorHash)
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json))

  return {
    creator,
    creatorHash,
    acceptor,
    acceptorHash,
    inviteToken,
    snapshot: accepted.json.snapshot,
  }
}

async function post(token, body, writtenOn = todayUtc()) {
  return api.postEntry(token, { client_uuid: randomUUID(), body, written_on: writtenOn })
}

function openDb(dbFile) {
  const db = new DatabaseSync(dbFile)
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

/** 0003 之前 local 后端的 seat 表结构（user_id 全局 UNIQUE、无 released_at）。 */
const LEGACY_SCHEMA = `
CREATE TABLE users (id TEXT PRIMARY KEY, created_on TEXT NOT NULL DEFAULT (date('now')));
CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, access_hash TEXT NOT NULL UNIQUE, refresh_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE dyad (id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'nascent' CHECK (state IN ('nascent','open','closed')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE seat (dyad_id TEXT NOT NULL REFERENCES dyad(id) ON DELETE CASCADE, slot TEXT NOT NULL CHECK (slot IN ('a','b')), user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT, recovery_hash TEXT NOT NULL CHECK (length(recovery_hash)=64), joined_on TEXT NOT NULL, PRIMARY KEY (dyad_id, slot));
CREATE TABLE entry (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, dyad_id TEXT NOT NULL REFERENCES dyad(id) ON DELETE CASCADE, slot TEXT NOT NULL CHECK (slot IN ('a','b')), body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000), written_on TEXT NOT NULL, client_uuid TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE (dyad_id, client_uuid), FOREIGN KEY (dyad_id, slot) REFERENCES seat(dyad_id, slot));
CREATE INDEX entry_dyad_seq ON entry (dyad_id, seq);
CREATE TABLE invite (dyad_id TEXT PRIMARY KEY REFERENCES dyad(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, expires_on TEXT NOT NULL, consumed_at TEXT);
CREATE TABLE rebind_attempt (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX rebind_attempt_user_time ON rebind_attempt (user_id, created_at);
`

// —————————————————————————————————————————————————————————————
// 健康检查 / 传输层
// —————————————————————————————————————————————————————————————

it('GET /api/health 返回 {ok:true}，并带 cache-control: no-store', async () => {
  const response = await api.health()
  assert.equal(response.status, 200)
  assert.deepEqual(response.json, { ok: true })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
})

it('不存在的路径返回 404 {error:"unknown"}；方法不符返回 405 {error:"http"}', async () => {
  const missing = await api.get('/api/nope')
  assert.equal(missing.status, 404)
  assert.deepEqual(missing.json, { error: 'unknown' })

  const wrongMethod = await api.post('/api/health', { body: {} })
  assert.equal(wrongMethod.status, 405)
  assert.deepEqual(wrongMethod.json, { error: 'http' })
})

it('非法 JSON 返回 400 {error:"http"}', async () => {
  const response = await api.post('/api/auth/anonymous', { rawBody: '{oops' })
  assert.equal(response.status, 400)
  assert.deepEqual(response.json, { error: 'http' })
})

it('除 auth/health 外的请求必须携带有效 Bearer token', async () => {
  const missing = await api.wallState(null)
  assert.equal(missing.status, 401)
  assert.deepEqual(missing.json, { error: 'unauthorized' })

  const bogus = await api.wallState('not-a-real-token')
  assert.equal(bogus.status, 401)
  assert.deepEqual(bogus.json, { error: 'unauthorized' })
})

// —————————————————————————————————————————————————————————————
// 匿名登录凭据与 refresh
// —————————————————————————————————————————————————————————————

it('匿名登录凭据返回 {user_id, access_token, refresh_token}，refresh 轮换后旧 token 失效', async () => {
  const session = await anonymousSession()
  assert.deepEqual(Object.keys(session).sort(), ['access_token', 'refresh_token', 'user_id'])
  assert.match(session.user_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.ok(session.access_token.length >= 32)
  assert.ok(session.refresh_token.length >= 32)

  const refreshed = await api.post('/api/auth/refresh', {
    body: { refresh_token: session.refresh_token },
  })
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.json.user_id, session.user_id)
  assert.notEqual(refreshed.json.access_token, session.access_token)
  assert.notEqual(refreshed.json.refresh_token, session.refresh_token)

  const oldAccess = await api.wallState(session.access_token)
  assert.equal(oldAccess.status, 401)
  assert.deepEqual(oldAccess.json, { error: 'unauthorized' })

  const oldRefresh = await api.post('/api/auth/refresh', {
    body: { refresh_token: session.refresh_token },
  })
  assert.equal(oldRefresh.status, 401)
  assert.deepEqual(oldRefresh.json, { error: 'invalid_token' })

  // 新 access token 可用
  const withNewToken = await api.createWall(
    refreshed.json.access_token,
    sha256(`refresh-${randomUUID()}`),
  )
  assert.equal(withNewToken.status, 200)

  const badRefresh = await api.post('/api/auth/refresh', { body: { refresh_token: 'nope' } })
  assert.equal(badRefresh.status, 401)
  assert.deepEqual(badRefresh.json, { error: 'invalid_token' })
})

// —————————————————————————————————————————————————————————————
// 建墙 / 邀请
// —————————————————————————————————————————————————————————————

it('create_wall 生成 nascent 墙：seat a、32 字符邀请 token、7 天过期', async () => {
  const creator = await anonymousSession()
  const response = await api.createWall(creator.access_token, sha256('create-wall-key'))
  assert.equal(response.status, 200)
  assert.deepEqual(Object.keys(response.json), ['snapshot'])

  const snapshot = response.json.snapshot
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'dyad_id',
    'invite',
    'my_slot',
    'seats',
    'state',
  ])
  assert.equal(snapshot.state, 'nascent')
  assert.equal(snapshot.my_slot, 'a')
  assert.equal(snapshot.seats.length, 1)
  assert.deepEqual(Object.keys(snapshot.seats[0]).sort(), ['joined_on', 'slot'])
  assert.equal(snapshot.seats[0].slot, 'a')
  assert.equal(snapshot.seats[0].joined_on, todayUtc())

  assert.deepEqual(Object.keys(snapshot.invite).sort(), ['expires_on', 'token'])
  assert.match(snapshot.invite.token, B64URL_32)
  assert.equal(snapshot.invite.expires_on, addDaysUtc(todayUtc(), 7))

  // 服务端只存哈希：之后的 wall_state 无法回显明文邀请 token（已向 Lead 报备的语义裁定）。
  const state = await api.wallState(creator.access_token)
  assert.equal(state.status, 200)
  assert.equal(state.json.snapshot.invite, null)
  assert.equal(state.json.snapshot.dyad_id, snapshot.dyad_id)
})

it('create_wall：已在座 409 already_seated；recovery_hash 非 64 位小写 hex 为 400 invalid_hash', async () => {
  const creator = await anonymousSession()
  const first = await api.createWall(creator.access_token, sha256('hash-one'))
  assert.equal(first.status, 200)

  const again = await api.createWall(creator.access_token, sha256('hash-two'))
  assert.equal(again.status, 409)
  assert.deepEqual(again.json, { error: 'already_seated' })

  const fresh = await anonymousSession()
  for (const badHash of ['', 'abc', sha256('x').toUpperCase(), 'z'.repeat(64)]) {
    const response = await api.createWall(fresh.access_token, badHash)
    assert.equal(response.status, 400, `hash=${badHash}`)
    assert.deepEqual(response.json, { error: 'invalid_hash' })
  }
})

it('accept_invite：占 b、墙置 open、邀请单次消费；未知 token 404、二次消费 409', async () => {
  const creator = await anonymousSession()
  const created = await api.createWall(creator.access_token, sha256('invite-owner'))
  const inviteToken = created.json.snapshot.invite.token

  const acceptor = await anonymousSession()
  const accepted = await api.acceptInvite(acceptor.access_token, inviteToken, sha256('invite-b'))
  assert.equal(accepted.status, 200)
  const snapshot = accepted.json.snapshot
  assert.equal(snapshot.state, 'open')
  assert.equal(snapshot.my_slot, 'b')
  assert.deepEqual(
    snapshot.seats.map((seat) => seat.slot),
    ['a', 'b'],
  )
  assert.equal(snapshot.invite, null)

  // 第二个陌生人消费同一 token → 409 invite_consumed
  const stranger = await anonymousSession()
  const second = await api.acceptInvite(stranger.access_token, inviteToken, sha256('invite-c'))
  assert.equal(second.status, 409)
  assert.deepEqual(second.json, { error: 'invite_consumed' })

  // 已占座者再接受 → already_seated
  const seated = await api.acceptInvite(acceptor.access_token, inviteToken, sha256('invite-b2'))
  assert.equal(seated.status, 409)
  assert.deepEqual(seated.json, { error: 'already_seated' })

  // 不存在的 token → 404 invite_unknown
  const unknown = await api.acceptInvite(stranger.access_token, 'A'.repeat(32), sha256('invite-x'))
  assert.equal(unknown.status, 404)
  assert.deepEqual(unknown.json, { error: 'invite_unknown' })
})

it('accept_invite：recovery_hash 格式非法 → 400 invalid_hash', async () => {
  const creator = await anonymousSession()
  const created = await api.createWall(creator.access_token, sha256('invite-hash-owner'))
  const inviteToken = created.json.snapshot.invite.token
  const stranger = await anonymousSession()
  const response = await api.acceptInvite(stranger.access_token, inviteToken, 'not-a-hash')
  assert.equal(response.status, 400)
  assert.deepEqual(response.json, { error: 'invalid_hash' })
})

// —————————————————————————————————————————————————————————————
// 读：T1 零行、分页、字段集
// —————————————————————————————————————————————————————————————

it('T1：无座位第三方 list_entries 返回空页、post_entry 409 no_seat、wall_state 409 no_seat', async () => {
  const { creator } = await pairedWall()
  const stranger = await anonymousSession()

  const list = await api.listEntries(stranger.access_token)
  assert.equal(list.status, 200)
  assert.deepEqual(list.json, { entries: [], has_more: false })

  const created = await post(stranger.access_token, 'third party write')
  assert.equal(created.status, 409)
  assert.deepEqual(created.json, { error: 'no_seat' })

  const state = await api.wallState(stranger.access_token)
  assert.equal(state.status, 409)
  assert.deepEqual(state.json, { error: 'no_seat' })

  // 有座者能写（对照组）
  const mine = await post(creator.access_token, 'creator write')
  assert.equal(mine.status, 200)
})

it('双人完整生命周期：封缄的信按 seq 与日期呈现，双方都可读', async () => {
  const creator = await anonymousSession()
  const creatorHash = sha256(`lifecycle-a-${randomUUID()}`)
  const created = await api.createWall(creator.access_token, creatorHash)
  const inviteToken = created.json.snapshot.invite.token

  const sealedOne = await post(creator.access_token, '封缄一', addDaysUtc(todayUtc(), -1))
  assert.equal(sealedOne.status, 200)
  const sealedTwo = await post(creator.access_token, '封缄二')
  assert.equal(sealedTwo.status, 200)

  const acceptor = await anonymousSession()
  const acceptorHash = sha256(`lifecycle-b-${randomUUID()}`)
  const accepted = await api.acceptInvite(acceptor.access_token, inviteToken, acceptorHash)
  assert.equal(accepted.status, 200)
  const reply = await post(acceptor.access_token, '回信')
  assert.equal(reply.status, 200)

  const page = await api.listEntries(acceptor.access_token)
  assert.deepEqual(Object.keys(page.json).sort(), ['entries', 'has_more'])
  assert.deepEqual(
    page.json.entries.map((entry) => entry.body),
    ['封缄一', '封缄二', '回信'],
  )
  assert.deepEqual(
    page.json.entries.map((entry) => entry.slot),
    ['a', 'a', 'b'],
  )
  assert.deepEqual(
    page.json.entries.map((entry) => entry.seq),
    [...page.json.entries.map((entry) => entry.seq)].sort((left, right) => left - right),
  )
  for (const entry of page.json.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['body', 'id', 'seq', 'slot', 'written_on'])
    assert.equal(typeof entry.seq, 'number')
  }

  // 任何响应体都不得泄露 created_at / client_uuid / 过程字段
  for (const response of [created, accepted, page, sealedOne, reply]) {
    const raw = JSON.stringify(response.json)
    for (const forbidden of ['created_at', 'client_uuid', 'last_seen', 'online', 'typing', 'read_at']) {
      assert.equal(raw.includes(forbidden), false, `响应体不得包含 ${forbidden}`)
    }
  }
})

it('分页：升序返回、before_seq 向前翻页、limit 上限 120', async () => {
  const creator = await anonymousSession()
  const created = await api.createWall(creator.access_token, sha256(`paging-${randomUUID()}`))
  assert.equal(created.status, 200)

  for (let index = 0; index < 125; index += 1) {
    const response = await post(creator.access_token, `分页-${index}`)
    assert.equal(response.status, 200, JSON.stringify(response.json))
  }

  const latest = await api.listEntries(creator.access_token, null, 1000)
  assert.equal(latest.status, 200)
  assert.equal(latest.json.entries.length, 120, 'limit 应被钳制到 120')
  assert.equal(latest.json.has_more, true)
  assert.deepEqual(
    latest.json.entries.map((entry) => entry.body),
    Array.from({ length: 120 }, (_, index) => `分页-${index + 5}`),
  )

  const oldestSeq = latest.json.entries[0].seq
  const older = await api.listEntries(creator.access_token, oldestSeq, 10)
  assert.equal(older.status, 200)
  assert.equal(older.json.entries.length, 5)
  assert.equal(older.json.has_more, false)
  assert.ok(older.json.entries.every((entry) => entry.seq < oldestSeq))
  assert.deepEqual(
    older.json.entries.map((entry) => entry.body),
    Array.from({ length: 5 }, (_, index) => `分页-${index}`),
  )

  const exhausted = await api.listEntries(creator.access_token, older.json.entries[0].seq, 120)
  assert.equal(exhausted.json.entries.length, 0)
  assert.equal(exhausted.json.has_more, false)

  // 非法 limit 回落到默认 120
  const fallback = await api.listEntries(creator.access_token, null, 0)
  assert.equal(fallback.json.entries.length, 120)
})

// —————————————————————————————————————————————————————————————
// 写：幂等、日期钳制、长度
// —————————————————————————————————————————————————————————————

it('幂等：同一 client_uuid 重放返回 duplicate:true；并发两次只落一行', async () => {
  const creator = await anonymousSession()
  const created = await api.createWall(creator.access_token, sha256(`idem-${randomUUID()}`))
  assert.equal(created.status, 200)

  const clientUuid = randomUUID()
  const input = { client_uuid: clientUuid, body: '只寄一次', written_on: todayUtc() }
  const first = await api.postEntry(creator.access_token, input)
  assert.equal(first.status, 200)
  assert.equal(first.json.duplicate, false)

  const replay = await api.postEntry(creator.access_token, {
    ...input,
    body: '重放文本不应改写',
  })
  assert.equal(replay.status, 200)
  assert.equal(replay.json.duplicate, true)
  assert.equal(replay.json.entry.id, first.json.entry.id)
  assert.equal(replay.json.entry.body, '只寄一次')

  const concurrentUuid = randomUUID()
  const concurrentInput = {
    client_uuid: concurrentUuid,
    body: '并发',
    written_on: todayUtc(),
  }
  const [left, right] = await Promise.all([
    api.postEntry(creator.access_token, concurrentInput),
    api.postEntry(creator.access_token, concurrentInput),
  ])
  assert.equal(left.status, 200)
  assert.equal(right.status, 200)
  assert.equal([left, right].filter((response) => response.json.duplicate === false).length, 1)

  const page = await api.listEntries(creator.access_token)
  assert.equal(page.json.entries.length, 2, '重放与并发都不得产生多余行')
  assert.deepEqual(
    page.json.entries.map((entry) => entry.body),
    ['只寄一次', '并发'],
  )
  assert.ok(page.json.entries[0].seq < page.json.entries[1].seq)
})

it('written_on 钳制：±2 天内保留，越界/非法回落到服务端 UTC 日期', async () => {
  const creator = await anonymousSession()
  const created = await api.createWall(creator.access_token, sha256(`dates-${randomUUID()}`))
  assert.equal(created.status, 200)
  const today = todayUtc()

  const cases = [
    { writtenOn: addDaysUtc(today, -2), expected: addDaysUtc(today, -2) },
    { writtenOn: addDaysUtc(today, 2), expected: addDaysUtc(today, 2) },
    { writtenOn: addDaysUtc(today, -3), expected: today },
    { writtenOn: addDaysUtc(today, 3), expected: today },
    { writtenOn: '2000-01-01', expected: today },
    { writtenOn: '2026-02-30', expected: today },
    { writtenOn: 'not-a-date', expected: today },
    { writtenOn: undefined, expected: today },
  ]
  for (const { writtenOn, expected } of cases) {
    const response = await api.postEntry(creator.access_token, {
      client_uuid: randomUUID(),
      body: `date ${String(writtenOn)}`,
      written_on: writtenOn,
    })
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.equal(response.json.entry.written_on, expected, `written_on=${String(writtenOn)}`)
    assert.match(response.json.entry.written_on, /^\d{4}-\d{2}-\d{2}$/)
  }
})

it('body 边界：8000 码点可寄出、8001 与空白拒绝、正文原样保存', async () => {
  const creator = await anonymousSession()
  const created = await api.createWall(creator.access_token, sha256(`body-${randomUUID()}`))
  assert.equal(created.status, 200)

  const astral = '😀'
  const eightThousand = astral.repeat(8000)
  assert.equal([...eightThousand].length, 8000)
  const ok = await post(creator.access_token, eightThousand)
  assert.equal(ok.status, 200, JSON.stringify(ok.json).slice(0, 200))
  assert.equal(ok.json.entry.body, eightThousand)

  const tooLong = await post(creator.access_token, astral.repeat(8001))
  assert.equal(tooLong.status, 400)
  assert.deepEqual(tooLong.json, { error: 'invalid_body' })

  for (const blank of ['', ' ', '\n\t\n']) {
    const response = await post(creator.access_token, blank)
    assert.equal(response.status, 400, `body=${JSON.stringify(blank)}`)
    assert.deepEqual(response.json, { error: 'invalid_body' })
  }

  const bodyPreserved = await post(creator.access_token, '  行尾空格  \n第二行  ')
  assert.equal(bodyPreserved.status, 200)
  assert.equal(bodyPreserved.json.entry.body, '  行尾空格  \n第二行  ')
})

it('client_uuid 非法 → 400 invalid_uuid', async () => {
  const creator = await anonymousSession()
  const created = await api.createWall(creator.access_token, sha256(`uuid-${randomUUID()}`))
  assert.equal(created.status, 200)

  for (const clientUuid of ['not-a-uuid', '', 42, null]) {
    const response = await api.postEntry(creator.access_token, {
      client_uuid: clientUuid,
      body: 'x',
      written_on: todayUtc(),
    })
    assert.equal(response.status, 400, `client_uuid=${String(clientUuid)}`)
    assert.deepEqual(response.json, { error: 'invalid_uuid' })
  }
})

// —————————————————————————————————————————————————————————————
// T5 恢复钥匙换座 / 限流
// —————————————————————————————————————————————————————————————

it('T5：rebind_seat 换座不改变 slot/joined_on，旧 uid 零行；格式错/无匹配 400', async () => {
  const creator = await anonymousSession()
  const creatorHash = sha256(`rebind-a-${randomUUID()}`)
  const created = await api.createWall(creator.access_token, creatorHash)
  assert.equal(created.status, 200)
  const original = created.json.snapshot
  const alive = await post(creator.access_token, '换座前的信')
  assert.equal(alive.status, 200)

  const rescuer = await anonymousSession()
  const rebound = await api.rebindSeat(rescuer.access_token, creatorHash)
  assert.equal(rebound.status, 200, JSON.stringify(rebound.json))
  const snapshot = rebound.json.snapshot
  assert.equal(snapshot.my_slot, 'a')
  assert.equal(snapshot.dyad_id, original.dyad_id)
  assert.equal(snapshot.seats.find((seat) => seat.slot === 'a').joined_on, original.seats[0].joined_on)

  // 旧 uid 的登录凭据仍然有效，但已不在座：零行 / no_seat
  const oldState = await api.wallState(creator.access_token)
  assert.equal(oldState.status, 409)
  assert.deepEqual(oldState.json, { error: 'no_seat' })
  const oldPage = await api.listEntries(creator.access_token)
  assert.deepEqual(oldPage.json, { entries: [], has_more: false })

  const newPage = await api.listEntries(rescuer.access_token)
  assert.deepEqual(
    newPage.json.entries.map((entry) => entry.body),
    ['换座前的信'],
  )

  // 已在座者不能再 rebind
  const seated = await api.rebindSeat(rescuer.access_token, creatorHash)
  assert.equal(seated.status, 409)
  assert.deepEqual(seated.json, { error: 'already_seated' })

  // 无匹配 / 格式错
  const stranger = await anonymousSession()
  for (const badHash of [sha256('no-such-key'), 'ABCDEF', '']) {
    const response = await api.rebindSeat(stranger.access_token, badHash)
    assert.equal(response.status, 400, `hash=${badHash}`)
    assert.deepEqual(response.json, { error: 'invalid_hash' })
  }
})

it('rebind_seat 限流：同一调用者 1 小时 5 次，失败也计入，第 6 次 429 throttled', async () => {
  const caller = await anonymousSession()
  const statuses = []
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await api.rebindSeat(caller.access_token, sha256(`throttle-${attempt}`))
    statuses.push(response.status)
  }
  assert.deepEqual(statuses, [400, 400, 400, 400, 400])

  const throttled = await api.rebindSeat(caller.access_token, sha256('throttle-final'))
  assert.equal(throttled.status, 429)
  assert.deepEqual(throttled.json, { error: 'throttled' })

  // 另一个调用者不受影响
  const other = await anonymousSession()
  const otherResponse = await api.rebindSeat(other.access_token, sha256('throttle-other'))
  assert.equal(otherResponse.status, 400)
  assert.deepEqual(otherResponse.json, { error: 'invalid_hash' })
})

// —————————————————————————————————————————————————————————————
// 销毁 / 关闭
// —————————————————————————————————————————————————————————————

it('close_and_erase：删除自己的留言、墙 closed、不释放座位、对方留言仍可读、重复调用幂等', async () => {
  const { creator, acceptor } = await pairedWall()
  assert.equal((await post(creator.access_token, 'a 的信')).status, 200)
  assert.equal((await post(acceptor.access_token, 'b 的信')).status, 200)
  const replayInput = { client_uuid: randomUUID(), body: 'a 的信 2', written_on: todayUtc() }
  const replayPosted = await api.postEntry(creator.access_token, replayInput)
  assert.equal(replayPosted.status, 200)

  const closed = await api.closeAndErase(acceptor.access_token)
  assert.equal(closed.status, 200)
  assert.deepEqual(closed.json, {})

  const acceptorState = await api.wallState(acceptor.access_token)
  assert.equal(acceptorState.status, 200)
  assert.equal(acceptorState.json.snapshot.state, 'closed')
  assert.equal(acceptorState.json.snapshot.seats.length, 2, '座位不得释放（A1）')
  assert.equal(acceptorState.json.snapshot.invite, null)

  const acceptorPage = await api.listEntries(acceptor.access_token)
  assert.deepEqual(
    acceptorPage.json.entries.map((entry) => entry.body),
    ['a 的信', 'a 的信 2'],
    '自己 slot 的留言被硬删除，对方的保留',
  )

  const creatorState = await api.wallState(creator.access_token)
  assert.equal(creatorState.json.snapshot.state, 'closed')
  const creatorPage = await api.listEntries(creator.access_token)
  assert.equal(creatorPage.json.entries.length, 2)

  const rejected = await post(creator.access_token, 'closed 后不可写')
  assert.equal(rejected.status, 409)
  assert.deepEqual(rejected.json, { error: 'wall_closed' })

  // 幂等重放仍可命中（即使墙 closed）
  const duplicate = await api.postEntry(creator.access_token, replayInput)
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.json.duplicate, true)
  assert.equal(duplicate.json.entry.id, replayPosted.json.entry.id)

  // 重复销毁幂等
  const again = await api.closeAndErase(acceptor.access_token)
  assert.equal(again.status, 200)
  assert.deepEqual(again.json, {})

  // 创建者也可以行使销毁权：墙保持 closed，双方文字清空
  const creatorClosed = await api.closeAndErase(creator.access_token)
  assert.equal(creatorClosed.status, 200)
  const finalPage = await api.listEntries(creator.access_token)
  assert.deepEqual(finalPage.json, { entries: [], has_more: false })
  const finalState = await api.wallState(acceptor.access_token)
  assert.equal(finalState.json.snapshot.state, 'closed')
  assert.equal(finalState.json.snapshot.seats.length, 2)
})

it('close_and_erase：无座位 409 no_seat', async () => {
  const stranger = await anonymousSession()
  const response = await api.closeAndErase(stranger.access_token)
  assert.equal(response.status, 409)
  assert.deepEqual(response.json, { error: 'no_seat' })
})

// —————————————————————————————————————————————————————————————
// 离开已关闭的墙（0003 / leave_closed_wall）
// —————————————————————————————————————————————————————————————

it('leave_closed_wall：未关闭 409 wall_not_closed；closed 后离开释放座位、可建新墙、对方仍可读', async () => {
  const { creator, creatorHash, acceptor } = await pairedWall()
  assert.equal((await post(creator.access_token, 'a 的信')).status, 200)
  assert.equal((await post(acceptor.access_token, 'b 的信')).status, 200)

  const before = await api.leaveClosedWall(creator.access_token)
  assert.equal(before.status, 409)
  assert.deepEqual(before.json, { error: 'wall_not_closed' })

  // close_and_erase 语义不变：墙 closed，座位不释放
  assert.equal((await api.closeAndErase(creator.access_token)).status, 200)
  const afterClose = await api.wallState(creator.access_token)
  assert.equal(afterClose.status, 200)
  assert.equal(afterClose.json.snapshot.state, 'closed')
  assert.equal(afterClose.json.snapshot.seats.length, 2, 'close_and_erase 仍不释放座位')

  // 离开：释放座位（保留历史行），旧登录凭据之后零行 / no_seat
  const leave = await api.leaveClosedWall(creator.access_token)
  assert.equal(leave.status, 200)
  assert.deepEqual(leave.json, {})
  const leftState = await api.wallState(creator.access_token)
  assert.equal(leftState.status, 409)
  assert.deepEqual(leftState.json, { error: 'no_seat' })
  assert.deepEqual((await api.listEntries(creator.access_token)).json, {
    entries: [],
    has_more: false,
  })
  const rejectWrite = await post(creator.access_token, '已离开不能写')
  assert.equal(rejectWrite.status, 409)
  assert.deepEqual(rejectWrite.json, { error: 'no_seat' })
  const repeat = await api.leaveClosedWall(creator.access_token)
  assert.equal(repeat.status, 409)
  assert.deepEqual(repeat.json, { error: 'no_seat' })

  // 已释放座位的恢复密钥不能再换回
  const rescuer = await anonymousSession()
  const staleRebind = await api.rebindSeat(rescuer.access_token, creatorHash)
  assert.equal(staleRebind.status, 400)
  assert.deepEqual(staleRebind.json, { error: 'invalid_hash' })

  // 可以建立新墙；仍受一人一墙约束
  const newWall = await api.createWall(creator.access_token, sha256(`leave-new-${randomUUID()}`))
  assert.equal(newWall.status, 200, JSON.stringify(newWall.json))
  assert.equal(newWall.json.snapshot.state, 'nascent')
  assert.equal(newWall.json.snapshot.my_slot, 'a')
  const newAgain = await api.createWall(creator.access_token, sha256('leave-again'))
  assert.equal(newAgain.status, 409)
  assert.deepEqual(newAgain.json, { error: 'already_seated' })

  // 对方仍可读 closed 墙；seats 仍含两位笔友的历史座位
  const partnerState = await api.wallState(acceptor.access_token)
  assert.equal(partnerState.status, 200)
  assert.equal(partnerState.json.snapshot.state, 'closed')
  assert.equal(partnerState.json.snapshot.seats.length, 2)
  const partnerPage = await api.listEntries(acceptor.access_token)
  assert.deepEqual(
    partnerPage.json.entries.map((entry) => entry.body),
    ['b 的信'],
  )

  // T6：创建者已在新墙在座 → 不能接受别墙邀请
  const seatedAccept = await api.acceptInvite(
    creator.access_token,
    newWall.json.snapshot.invite.token,
    sha256('leave-x'),
  )
  assert.equal(seatedAccept.status, 409)
  assert.deepEqual(seatedAccept.json, { error: 'already_seated' })

  // 对方离开后（released 不阻塞新座位）→ 可以接受创建者新墙邀请重新在座
  assert.equal((await api.leaveClosedWall(acceptor.access_token)).status, 200)
  assert.deepEqual((await api.wallState(acceptor.access_token)).json, { error: 'no_seat' })
  const rejoin = await api.acceptInvite(
    acceptor.access_token,
    newWall.json.snapshot.invite.token,
    sha256(`leave-b-${randomUUID()}`),
  )
  assert.equal(rejoin.status, 200, JSON.stringify(rejoin.json))
  assert.equal(rejoin.json.snapshot.state, 'open')
  assert.equal(rejoin.json.snapshot.my_slot, 'b')
})

it('leave_closed_wall：无鉴权 401 unauthorized、无座位 409 no_seat', async () => {
  const unauth = await api.post('/api/rpc/leave_closed_wall', { body: {} })
  assert.equal(unauth.status, 401)
  assert.deepEqual(unauth.json, { error: 'unauthorized' })

  const stranger = await anonymousSession()
  const noSeat = await api.leaveClosedWall(stranger.access_token)
  assert.equal(noSeat.status, 409)
  assert.deepEqual(noSeat.json, { error: 'no_seat' })
})

it('旧版 SQLite 文件库启动时迁移 seat：数据保留 + released_at + active 部分唯一索引', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bimail-legacy-'))
  const dbFile = join(dir, 'bimail.db')
  const userId = randomUUID()
  const partnerId = randomUUID()
  const dyadId = randomUUID()
  const accessToken = `legacy-access-${randomUUID()}`
  const today = todayUtc()

  const legacy = new DatabaseSync(dbFile)
  try {
    legacy.exec(LEGACY_SCHEMA)
    legacy.prepare('INSERT INTO users (id) VALUES (?)').run(userId)
    legacy.prepare('INSERT INTO users (id) VALUES (?)').run(partnerId)
    legacy
      .prepare('INSERT INTO sessions (user_id, access_hash, refresh_hash) VALUES (?, ?, ?)')
      .run(userId, sha256(accessToken), sha256(`refresh-${accessToken}`))
    legacy.prepare("INSERT INTO dyad (id, state) VALUES (?, 'open')").run(dyadId)
    legacy
      .prepare('INSERT INTO seat (dyad_id, slot, user_id, recovery_hash, joined_on) VALUES (?, ?, ?, ?, ?)')
      .run(dyadId, 'a', userId, sha256('legacy-a'), today)
    legacy
      .prepare('INSERT INTO seat (dyad_id, slot, user_id, recovery_hash, joined_on) VALUES (?, ?, ?, ?, ?)')
      .run(dyadId, 'b', partnerId, sha256('legacy-b'), today)
    for (const slot of ['a', 'b']) {
      legacy
        .prepare(
          'INSERT INTO entry (id, dyad_id, slot, body, written_on, client_uuid) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), dyadId, slot, `legacy-${slot}`, today, randomUUID())
    }
  } finally {
    legacy.close()
  }

  const legacyBackend = await startBackend({ dbFile })
  try {
    const legacyApi = createApi(legacyBackend.baseUrl)
    const state = await legacyApi.wallState(accessToken)
    assert.equal(state.status, 200, JSON.stringify(state.json))
    assert.equal(state.json.snapshot.state, 'open')
    assert.equal(state.json.snapshot.seats.length, 2)
    const page = await legacyApi.listEntries(accessToken)
    assert.deepEqual(
      page.json.entries.map((entry) => entry.body),
      ['legacy-a', 'legacy-b'],
    )
    // 旧库可直接走 close → leave → 新建墙
    assert.equal((await legacyApi.closeAndErase(accessToken)).status, 200)
    assert.equal((await legacyApi.leaveClosedWall(accessToken)).status, 200)
    const created = await legacyApi.createWall(accessToken, sha256('legacy-new'))
    assert.equal(created.status, 200, JSON.stringify(created.json))
    assert.equal(created.json.snapshot.state, 'nascent')
  } finally {
    await legacyBackend.stop()
  }

  const check = openDb(dbFile)
  try {
    const columns = check.prepare('PRAGMA table_info(seat)').all().map((row) => row.name)
    assert.ok(columns.includes('released_at'), '迁移后 seat 必须有 released_at')
    const indexes = check.prepare('PRAGMA index_list(seat)').all()
    assert.ok(
      indexes.some(
        (index) => index.name === 'seat_active_user_uidx' && index.unique === 1 && index.partial === 1,
      ),
      '迁移后必须有 active 部分唯一索引',
    )
    assert.equal(check.prepare('PRAGMA foreign_key_check').all().length, 0)
    const seatRows = check.prepare('SELECT slot, released_at FROM seat ORDER BY dyad_id, slot').all()
    assert.equal(seatRows.length, 3, '旧墙 2 个历史座位 + 新墙 1 个 active 座位')
    assert.equal(seatRows.filter((row) => row.released_at !== null).length, 1)
    const bodies = check
      .prepare('SELECT body FROM entry ORDER BY seq')
      .all()
      .map((row) => row.body)
    assert.deepEqual(bodies, ['legacy-b'], 'close_and_erase 删除自己的留言，对方的保留')

    // active 部分唯一索引生效：同一主体不能同时拥有两个 active 座位
    const otherDyad = randomUUID()
    check.prepare("INSERT INTO dyad (id, state) VALUES (?, 'nascent')").run(otherDyad)
    assert.throws(
      () =>
        check
          .prepare(
            'INSERT INTO seat (dyad_id, slot, user_id, recovery_hash, joined_on) VALUES (?, ?, ?, ?, ?)',
          )
          .run(otherDyad, 'a', userId, sha256('legacy-dup'), today),
      /UNIQUE|constraint/i,
    )
  } finally {
    check.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// —————————————————————————————————————————————————————————————
// 文件库场景：邀请过期、多登录凭据注销、外键 RESTRICT
// —————————————————————————————————————————————————————————————

it('文件库：邀请过期 410 invite_expired，且已消费优先于过期', async () => {
  const fileBackend = await startBackend({ tempFile: true })
  const fileApi = createApi(fileBackend.baseUrl)
  try {
    const creator = (await fileApi.anonymous()).json
    const created = await fileApi.createWall(creator.access_token, sha256(`expiry-${randomUUID()}`))
    assert.equal(created.status, 200)
    const inviteToken = created.json.snapshot.invite.token
    const inviteHash = sha256(inviteToken)

    const db = openDb(fileBackend.dbFile)
    try {
      db.prepare('UPDATE invite SET expires_on = ? WHERE token_hash = ?').run(
        addDaysUtc(todayUtc(), -1),
        inviteHash,
      )
    } finally {
      db.close()
    }

    const stranger = (await fileApi.anonymous()).json
    const expired = await fileApi.acceptInvite(
      stranger.access_token,
      inviteToken,
      sha256(`expiry-b-${randomUUID()}`),
    )
    assert.equal(expired.status, 410)
    assert.deepEqual(expired.json, { error: 'invite_expired' })

    // 同时标记已消费 + 已过期：已消费优先
    const db2 = openDb(fileBackend.dbFile)
    try {
      db2
        .prepare('UPDATE invite SET consumed_at = ?, expires_on = ? WHERE token_hash = ?')
        .run(new Date().toISOString(), addDaysUtc(todayUtc(), -1), inviteHash)
    } finally {
      db2.close()
    }
    const consumed = await fileApi.acceptInvite(
      stranger.access_token,
      inviteToken,
      sha256(`expiry-c-${randomUUID()}`),
    )
    assert.equal(consumed.status, 409)
    assert.deepEqual(consumed.json, { error: 'invite_consumed' })
  } finally {
    await fileBackend.stop()
  }
})

it('revoke_other_sessions：删除该主体除当前登录凭据外的全部登录凭据（幂等）', async () => {
  const fileBackend = await startBackend({ tempFile: true })
  const fileApi = createApi(fileBackend.baseUrl)
  try {
    const user = (await fileApi.anonymous()).json
    const created = await fileApi.createWall(user.access_token, sha256(`revoke-${randomUUID()}`))
    assert.equal(created.status, 200)

    // 运维/多设备场景：为同一 user 直接写入第二个登录凭据（本 API 不暴露建登录凭据）
    const secondAccess = 'second-access-token-for-test'
    const db = openDb(fileBackend.dbFile)
    try {
      db.prepare('INSERT INTO sessions (user_id, access_hash, refresh_hash) VALUES (?, ?, ?)').run(
        user.user_id,
        sha256(secondAccess),
        sha256('second-refresh-token-for-test'),
      )
    } finally {
      db.close()
    }
    assert.equal((await fileApi.wallState(secondAccess)).status, 200)

    const revoked = await fileApi.revokeOtherSessions(user.access_token)
    assert.equal(revoked.status, 200)
    assert.deepEqual(revoked.json, {})

    const secondAfter = await fileApi.wallState(secondAccess)
    assert.equal(secondAfter.status, 401)
    assert.deepEqual(secondAfter.json, { error: 'unauthorized' })

    // 当前登录凭据不受影响；幂等
    assert.equal((await fileApi.wallState(user.access_token)).status, 200)
    const again = await fileApi.revokeOtherSessions(user.access_token)
    assert.equal(again.status, 200)
    assert.deepEqual(again.json, {})
    assert.equal((await fileApi.wallState(user.access_token)).status, 200)
  } finally {
    await fileBackend.stop()
  }
})

it('T7 数据层：seat.user_id ON DELETE RESTRICT 阻止删除匿名主体（A4）', async () => {
  const fileBackend = await startBackend({ tempFile: true })
  const fileApi = createApi(fileBackend.baseUrl)
  try {
    const user = (await fileApi.anonymous()).json
    const created = await fileApi.createWall(user.access_token, sha256(`fk-${randomUUID()}`))
    assert.equal(created.status, 200)

    const db = openDb(fileBackend.dbFile)
    try {
      assert.throws(
        () => db.prepare('DELETE FROM users WHERE id = ?').run(user.user_id),
        /FOREIGN KEY|constraint/i,
      )
    } finally {
      db.close()
    }
  } finally {
    await fileBackend.stop()
  }
})

it('服务端进程不在 stderr 泄露 token / 正文（A3 / §8）', async () => {
  const probes = ['敏感正文-不应出现在日志', 'sk-live-token-abcdefghijklmnop']
  const creator = await anonymousSession()
  const created = await api.createWall(creator.access_token, sha256(`logs-${randomUUID()}`))
  assert.equal(created.status, 200)
  for (const probe of probes) {
    const response = await post(creator.access_token, probe)
    assert.equal(response.status, 200)
  }
  await api.wallState(creator.access_token)
  await api.listEntries(creator.access_token)
  await sleep(100)

  const stderr = backend.stderr()
  for (const secret of [creator.access_token, creator.refresh_token, ...probes]) {
    assert.equal(stderr.includes(secret), false, 'stderr 不得包含 token 或正文')
  }
})

// —————————————————————————————————————————————————————————————
// 优雅退出
// —————————————————————————————————————————————————————————————

it('SIGTERM 优雅退出（exit code 0）', async () => {
  const shortLived = await startBackend()
  const health = await createApi(shortLived.baseUrl).health()
  assert.equal(health.status, 200)
  await shortLived.stop()
  assert.equal(shortLived.exitCode(), 0)
})
