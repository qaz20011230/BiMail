/**
 * Supabase 生产适配器：手写匿名 Auth + PostgREST/RPC 客户端（不引入 supabase-js）。
 *
 * 契约：docs/CONTRACT.md §4.2；错误码见 src/lib/errors.ts。
 * - 匿名登录 POST /auth/v1/signup；JWT 过期前 60s 用 refresh_token 轮换。
 * - RPC POST /rest/v1/rpc/<name>；401 刷新一次后重试。
 * - listEntries 直接读 v_entry 视图（字段白名单，绝不查基表、绝不 select *）。
 * - 业务错误：PostgREST 4xx 的 body.message 命中错误码即映射；此外 SQL 迁移中
 *   rebind_seat 为保住限流计数而以 200 + {"error":"<code>"} 返回（见 0002 文件头），
 *   这里对 200 响应里的 error 字段做同样映射。
 */

import { ENTRY_PAGE_SIZE, type Backend, type CommitInput } from './adapter'
import { BackendError, toBackendErrorCode } from './errors'
import { KEYS, readJSON, removeKey, writeJSON } from './storage'
import type { Entry, EntryPage, PostedEntry, Session, Slot, WallSnapshot } from '../types'

const REFRESH_SKEW_SECONDS = 60
const MAX_PAGE_SIZE = 120
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type JsonRecord = Record<string, unknown>

async function parseJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

function readStoredSession(): Session | null {
  const stored = readJSON<Session>(KEYS.session)
  if (
    !stored ||
    typeof stored.user_id !== 'string' ||
    typeof stored.access_token !== 'string' ||
    typeof stored.refresh_token !== 'string'
  ) {
    return null
  }
  return stored
}

function saveSession(session: Session): void {
  writeJSON(KEYS.session, session)
}

/** 解析 JWT payload 的 exp（秒）；解析失败返回 null（按未过期处理，交给服务端）。 */
function readJwtExpiry(token: string): number | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const payload = JSON.parse(atob(padded)) as JsonRecord
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

/** recovery_hash（64 位小写 hex，客户端 SHA-256）→ PostgREST bytea 字面量（\x + hex）。 */
function encodeRecoveryHash(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new BackendError('invalid_hash')
  return `\\x${hash}`
}

function messageOf(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data !== null && typeof data === 'object') {
    const record = data as JsonRecord
    if (typeof record.message === 'string') return record.message
    if (typeof record.error === 'string') return record.error
  }
  return null
}

function toEntry(raw: unknown): Entry {
  const row = (raw ?? {}) as JsonRecord
  const valid =
    typeof row.id === 'string' &&
    typeof row.seq === 'number' &&
    (row.slot === 'a' || row.slot === 'b') &&
    typeof row.body === 'string' &&
    typeof row.written_on === 'string'
  if (!valid) throw new BackendError('unknown')
  return {
    id: row.id as string,
    seq: row.seq as number,
    slot: row.slot as Slot,
    body: row.body as string,
    written_on: row.written_on as string,
  }
}

function requireSnapshot(data: unknown): WallSnapshot {
  const snapshot = (data as { snapshot?: unknown } | null)?.snapshot
  if (snapshot === null || typeof snapshot !== 'object') throw new BackendError('unknown')
  return snapshot as WallSnapshot
}

export class SupabaseBackend implements Backend {
  readonly mode = 'supabase' as const

  private readonly baseUrl: string
  private session: Session | null
  private ensurePromise: Promise<Session> | null = null
  private refreshPromise: Promise<Session> | null = null

  constructor(
    readonly url: string,
    readonly anonKey: string,
  ) {
    this.baseUrl = url.replace(/\/+$/, '')
    this.session = readStoredSession()
  }

  // ——— 登录凭据 ———

  ensureSession(): Promise<Session> {
    if (!this.ensurePromise) {
      this.ensurePromise = this.resolveSession().finally(() => {
        this.ensurePromise = null
      })
    }
    return this.ensurePromise
  }

  private async resolveSession(): Promise<Session> {
    const stored = this.session ?? readStoredSession()
    if (!stored) return this.signInAnonymously()

    const expiry = readJwtExpiry(stored.access_token)
    const expiresSoon = expiry !== null && expiry - Date.now() / 1000 < REFRESH_SKEW_SECONDS
    if (expiresSoon) {
      try {
        return await this.refresh(stored.refresh_token)
      } catch (error) {
        // 刷新被服务端拒绝（token 失效/被注销）→ 建立新的匿名身份；
        // 座位由恢复密钥换回（flows 的 lost 屏兜底）。网络错误必须向上抛出。
        if (error instanceof BackendError && error.code === 'network') throw error
        return this.signInAnonymously()
      }
    }
    this.session = stored
    return stored
  }

  private async signInAnonymously(): Promise<Session> {
    const response = await this.authFetch('/auth/v1/signup', {})
    const data = await parseJson(response)
    if (!response.ok) throw this.errorFrom(response.status, data)
    return this.adoptSession(data)
  }

  private refresh(refreshToken: string): Promise<Session> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh(refreshToken).finally(() => {
        this.refreshPromise = null
      })
    }
    return this.refreshPromise
  }

  private async doRefresh(refreshToken: string): Promise<Session> {
    const response = await this.authFetch('/auth/v1/token?grant_type=refresh_token', {
      refresh_token: refreshToken,
    })
    const data = await parseJson(response)
    if (!response.ok) {
      if (response.status === 401) {
        this.clearSession()
        throw new BackendError('unauthorized')
      }
      throw this.errorFrom(response.status, data)
    }
    return this.adoptSession(data)
  }

  private adoptSession(data: unknown): Session {
    const record = (data ?? {}) as JsonRecord
    const user = (record.user ?? {}) as JsonRecord
    const session: Session = {
      user_id: typeof user.id === 'string' ? user.id : '',
      access_token: typeof record.access_token === 'string' ? record.access_token : '',
      refresh_token: typeof record.refresh_token === 'string' ? record.refresh_token : '',
    }
    if (!session.user_id || !session.access_token || !session.refresh_token) {
      throw new BackendError('unknown')
    }
    this.session = session
    saveSession(session)
    return session
  }

  private clearSession(): void {
    this.session = null
    removeKey(KEYS.session)
  }

  private async authFetch(path: string, body: unknown): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          apikey: this.anonKey,
          authorization: `Bearer ${this.anonKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body ?? {}),
      })
    } catch {
      throw new BackendError('network')
    }
  }

  // ——— 错误映射 ———

  private errorFrom(status: number, data: unknown): BackendError {
    if (status === 401) {
      this.clearSession()
      return new BackendError('unauthorized')
    }
    const message = messageOf(data)
    const mapped = toBackendErrorCode(message)
    if (mapped !== 'unknown') return new BackendError(mapped)
    if (status === 429) return new BackendError('throttled')
    if (status >= 500) return new BackendError('http')
    if (typeof message === 'string') {
      if (/uuid/i.test(message)) return new BackendError('invalid_uuid')
      if (/bytea|hex/i.test(message)) return new BackendError('invalid_hash')
      if (/invalid input syntax for type date/i.test(message)) return new BackendError('invalid_body')
    }
    return new BackendError('http')
  }

  // ——— RPC / REST ———

  private async rpcFetch(name: string, args: JsonRecord, accessToken: string): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          apikey: this.anonKey,
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(args),
      })
    } catch {
      throw new BackendError('network')
    }
  }

  private async rpc<T>(name: string, args: JsonRecord): Promise<T> {
    const session = await this.ensureSession()
    let response = await this.rpcFetch(name, args, session.access_token)
    if (response.status === 401) {
      const refreshed = await this.refresh(session.refresh_token)
      response = await this.rpcFetch(name, args, refreshed.access_token)
    }
    const data = await parseJson(response)
    if (!response.ok) throw this.errorFrom(response.status, data)
    // rebind_seat 的错误用 200 + {error} 返回（见 migration 0002 文件头）。
    if (data !== null && typeof data === 'object' && typeof (data as JsonRecord).error === 'string') {
      throw new BackendError(toBackendErrorCode((data as JsonRecord).error))
    }
    return data as T
  }

  private async viewFetch(path: string, accessToken: string): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          apikey: this.anonKey,
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
      })
    } catch {
      throw new BackendError('network')
    }
  }

  // ——— Backend 契约 ———

  async createWall(recoveryHash: string): Promise<WallSnapshot> {
    const payload = await this.rpc<unknown>('create_wall', {
      recovery_hash: encodeRecoveryHash(recoveryHash),
    })
    return requireSnapshot(payload)
  }

  async acceptInvite(token: string, recoveryHash: string): Promise<WallSnapshot> {
    const payload = await this.rpc<unknown>('accept_invite', {
      token,
      recovery_hash: encodeRecoveryHash(recoveryHash),
    })
    return requireSnapshot(payload)
  }

  async wallSnapshot(): Promise<WallSnapshot> {
    return requireSnapshot(await this.rpc<unknown>('wall_state', {}))
  }

  async listEntries(beforeSeq: number | null, limit: number = ENTRY_PAGE_SIZE): Promise<EntryPage> {
    const pageSize =
      Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_PAGE_SIZE) : ENTRY_PAGE_SIZE
    const params = new URLSearchParams({
      select: 'id,seq,slot,body,written_on',
      order: 'seq.desc',
      limit: String(pageSize + 1),
    })
    if (typeof beforeSeq === 'number' && Number.isFinite(beforeSeq)) {
      params.set('seq', `lt.${beforeSeq}`)
    }
    const path = `/rest/v1/v_entry?${params.toString()}`

    const session = await this.ensureSession()
    let response = await this.viewFetch(path, session.access_token)
    if (response.status === 401) {
      const refreshed = await this.refresh(session.refresh_token)
      response = await this.viewFetch(path, refreshed.access_token)
    }
    const data = await parseJson(response)
    if (!response.ok) throw this.errorFrom(response.status, data)
    if (!Array.isArray(data)) throw new BackendError('unknown')

    const rows = data as unknown[]
    const hasMore = rows.length > pageSize
    const page = (hasMore ? rows.slice(0, pageSize) : rows).reverse()
    return { entries: page.map(toEntry), has_more: hasMore }
  }

  async postEntry(input: CommitInput): Promise<PostedEntry> {
    if (!UUID_RE.test(input.client_uuid)) throw new BackendError('invalid_uuid')
    const payload = await this.rpc<PostedEntry>('post_entry', {
      client_uuid: input.client_uuid,
      body: input.body,
      written_on: input.written_on,
    })
    if (payload === null || typeof payload !== 'object' || !payload.entry) {
      throw new BackendError('unknown')
    }
    return { entry: toEntry(payload.entry), duplicate: payload.duplicate === true }
  }

  async rebindSeat(recoveryHash: string): Promise<WallSnapshot> {
    const payload = await this.rpc<unknown>('rebind_seat', {
      recovery_hash: encodeRecoveryHash(recoveryHash),
    })
    return requireSnapshot(payload)
  }

  async revokeOtherSessions(): Promise<void> {
    const session = await this.ensureSession()
    let response = await this.logoutFetch(session.access_token)
    if (response.status === 401) {
      const refreshed = await this.refresh(session.refresh_token)
      response = await this.logoutFetch(refreshed.access_token)
    }
    if (!response.ok) throw this.errorFrom(response.status, await parseJson(response))
  }

  private async logoutFetch(accessToken: string): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}/auth/v1/logout?scope=others`, {
        method: 'POST',
        headers: {
          apikey: this.anonKey,
          authorization: `Bearer ${accessToken}`,
        },
      })
    } catch {
      throw new BackendError('network')
    }
  }

  async closeAndErase(): Promise<void> {
    await this.rpc<unknown>('close_and_erase', {})
  }

  async leaveClosedWall(): Promise<void> {
    await this.rpc<unknown>('leave_closed_wall', {})
  }
}
