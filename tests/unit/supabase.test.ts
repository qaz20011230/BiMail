/**
 * src/lib/supabase.ts 单元测试（mock fetch，happy-dom）。
 * 断言：匿名登录 / refresh / RPC / 视图查询的 URL、header、body；错误码映射；
 * listEntries 不查基表、字段白名单、升序与 has_more。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEYS } from '../../src/lib/storage'
import { SupabaseBackend } from '../../src/lib/supabase'
import type { WallSnapshot } from '../../src/types'

const BASE_URL = 'https://example.supabase.co'
const ANON_KEY = 'anon-key-123'
const RECOVERY_HASH = 'ab'.repeat(32)

const SNAPSHOT: WallSnapshot = {
  dyad_id: 'dyad-1',
  state: 'nascent',
  my_slot: 'a',
  seats: [{ slot: 'a', joined_on: '2026-11-12' }],
  invite: { token: 'A'.repeat(32), expires_on: '2026-11-19' },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function emptyResponse(status: number): Response {
  return new Response(null, { status })
}

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeJwt(expSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ exp: expSeconds, sub: 'user-1' }))
  return `${header}.${payload}.signature`
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

function seedSession(options: { accessExp?: number; userId?: string } = {}) {
  const session = {
    user_id: options.userId ?? 'user-1',
    access_token: makeJwt(options.accessExp ?? nowSeconds() + 3600),
    refresh_token: 'refresh-token-initial',
  }
  window.localStorage.setItem(KEYS.session, JSON.stringify(session))
  return session
}

function readStoredSession() {
  const raw = window.localStorage.getItem(KEYS.session)
  return raw ? (JSON.parse(raw) as Record<string, string>) : null
}

type FetchCall = [input: RequestInfo | URL, init?: RequestInit]

function headerOf(call: FetchCall, name: string): string | undefined {
  const headers = (call[1]?.headers ?? {}) as Record<string, string>
  return headers[name]
}

function jsonBodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  window.localStorage.clear()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ensureSession', () => {
  it('无本地登录凭据时匿名登录：POST /auth/v1/signup，带 apikey 与 anon Bearer，保存登录凭据', async () => {
    const accessToken = makeJwt(nowSeconds() + 3600)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: accessToken, refresh_token: 'rt-1', user: { id: 'u-1' } }),
    )

    const backend = new SupabaseBackend(`${BASE_URL}/`, ANON_KEY)
    const session = await backend.ensureSession()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0] as FetchCall
    expect(String(call[0])).toBe(`${BASE_URL}/auth/v1/signup`)
    expect(call[1]?.method).toBe('POST')
    expect(headerOf(call, 'apikey')).toBe(ANON_KEY)
    expect(headerOf(call, 'authorization')).toBe(`Bearer ${ANON_KEY}`)
    expect(headerOf(call, 'content-type')).toBe('application/json')
    expect(call[1]?.body).toBe('{}')

    expect(session).toEqual({ user_id: 'u-1', access_token: accessToken, refresh_token: 'rt-1' })
    expect(readStoredSession()).toEqual(session)
  })

  it('本地登录凭据未过期时直接复用，不发请求', async () => {
    const stored = seedSession()
    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    const session = await backend.ensureSession()
    expect(session).toEqual(stored)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('access token 过期前 60s 内用 refresh_token 轮换（旧 token 不再使用）', async () => {
    seedSession({ accessExp: nowSeconds() - 10 })
    const newAccess = makeJwt(nowSeconds() + 3600)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: newAccess, refresh_token: 'rt-2', user: { id: 'user-1' } }),
    )

    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    const session = await backend.ensureSession()

    const call = fetchMock.mock.calls[0] as FetchCall
    expect(String(call[0])).toBe(`${BASE_URL}/auth/v1/token?grant_type=refresh_token`)
    expect(headerOf(call, 'apikey')).toBe(ANON_KEY)
    expect(headerOf(call, 'authorization')).toBe(`Bearer ${ANON_KEY}`)
    expect(jsonBodyOf(call)).toEqual({ refresh_token: 'refresh-token-initial' })
    expect(session.access_token).toBe(newAccess)
    expect(session.refresh_token).toBe('rt-2')
    expect(readStoredSession()?.refresh_token).toBe('rt-2')
  })

  it('refresh 被拒绝（401）时回落为新的匿名身份；网络错误抛出 network', async () => {
    seedSession({ accessExp: nowSeconds() - 10 })
    const newAccess = makeJwt(nowSeconds() + 3600)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'Invalid Refresh Token' }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: newAccess, refresh_token: 'rt-new', user: { id: 'user-2' } }),
      )

    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    const session = await backend.ensureSession()
    expect(session.user_id).toBe('user-2')
    expect(String((fetchMock.mock.calls[1] as FetchCall)[0])).toBe(`${BASE_URL}/auth/v1/signup`)

    window.localStorage.clear()
    seedSession({ accessExp: nowSeconds() - 10 })
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    const offline = new SupabaseBackend(BASE_URL, ANON_KEY)
    await expect(offline.ensureSession()).rejects.toMatchObject({ code: 'network' })
  })
})

describe('RPC', () => {
  it('create_wall：POST /rest/v1/rpc/create_wall，recovery_hash 以 bytea 字面量（\\x+hex）传参', async () => {
    const stored = seedSession()
    fetchMock.mockResolvedValueOnce(jsonResponse({ snapshot: SNAPSHOT }))

    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    const snapshot = await backend.createWall(RECOVERY_HASH)

    const call = fetchMock.mock.calls[0] as FetchCall
    expect(String(call[0])).toBe(`${BASE_URL}/rest/v1/rpc/create_wall`)
    expect(call[1]?.method).toBe('POST')
    expect(headerOf(call, 'apikey')).toBe(ANON_KEY)
    expect(headerOf(call, 'authorization')).toBe(`Bearer ${stored.access_token}`)
    expect(headerOf(call, 'content-type')).toBe('application/json')
    expect(jsonBodyOf(call)).toEqual({ recovery_hash: `\\x${RECOVERY_HASH}` })
    expect(snapshot).toEqual(SNAPSHOT)
  })

  it('recovery_hash 非 64 位小写 hex 时本地抛 invalid_hash，不发请求', async () => {
    seedSession()
    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    await expect(backend.createWall('ABC')).rejects.toMatchObject({ code: 'invalid_hash' })
    await expect(backend.rebindSeat('zz')).rejects.toMatchObject({ code: 'invalid_hash' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('RPC 401 时刷新一次并重试（新 access token），通过返回', async () => {
    const stored = seedSession()
    const refreshedAccess = makeJwt(nowSeconds() + 3600)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'JWT expired' }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: refreshedAccess, refresh_token: 'rt-2', user: { id: 'user-1' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ snapshot: SNAPSHOT }))

    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    const snapshot = await backend.wallSnapshot()

    expect(snapshot).toEqual(SNAPSHOT)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const calls = fetchMock.mock.calls as FetchCall[]
    expect(String(calls[0][0])).toBe(`${BASE_URL}/rest/v1/rpc/wall_state`)
    expect(headerOf(calls[0], 'authorization')).toBe(`Bearer ${stored.access_token}`)
    expect(String(calls[1][0])).toBe(`${BASE_URL}/auth/v1/token?grant_type=refresh_token`)
    expect(String(calls[2][0])).toBe(`${BASE_URL}/rest/v1/rpc/wall_state`)
    expect(headerOf(calls[2], 'authorization')).toBe(`Bearer ${refreshedAccess}`)
  })

  it('业务错误映射：raise 异常文本 → BackendErrorCode；429 → throttled；5xx → http', async () => {
    seedSession()
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'P0001', message: 'already_seated' }, 400))
    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    await expect(backend.createWall(RECOVERY_HASH)).rejects.toMatchObject({ code: 'already_seated' })

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'invalid input syntax for type uuid: "x"' }, 400))
    await expect(
      backend.postEntry({ client_uuid: 'not-a-uuid', body: 'x', written_on: '2026-11-12' }),
    ).rejects.toMatchObject({ code: 'invalid_uuid' })

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(emptyResponse(429))
    await expect(backend.wallSnapshot()).rejects.toMatchObject({ code: 'throttled' })

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(emptyResponse(500))
    await expect(backend.wallSnapshot()).rejects.toMatchObject({ code: 'http' })
  })

  it('rebind_seat 的 200 + {error} 响应也映射为 BackendError（见 SQL 迁移文件头）', async () => {
    seedSession()
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'throttled' }))
    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    await expect(backend.rebindSeat(RECOVERY_HASH)).rejects.toMatchObject({ code: 'throttled' })

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'wall_closed' }))
    await expect(backend.rebindSeat(RECOVERY_HASH)).rejects.toMatchObject({ code: 'wall_closed' })
  })

  it('网络失败映射为 network', async () => {
    seedSession()
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    await expect(backend.wallSnapshot()).rejects.toMatchObject({ code: 'network' })
  })

  it('postEntry 本地校验 client_uuid，非法时不发请求', async () => {
    seedSession()
    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    await expect(
      backend.postEntry({ client_uuid: 'nope', body: 'x', written_on: '2026-11-12' }),
    ).rejects.toMatchObject({ code: 'invalid_uuid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('listEntries（只读 v_entry 视图）', () => {
  const rows = [
    { id: 'e5', seq: 5, slot: 'b', body: '第三', written_on: '2026-11-05' },
    { id: 'e4', seq: 4, slot: 'a', body: '第二', written_on: '2026-11-04' },
    { id: 'e3', seq: 3, slot: 'a', body: '第一', written_on: '2026-11-03' },
  ]

  it('GET /rest/v1/v_entry：字段白名单、seq.desc、limit+1，返回升序与 has_more', async () => {
    const stored = seedSession()
    fetchMock.mockResolvedValueOnce(jsonResponse(rows))

    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    const page = await backend.listEntries(null, 2)

    const call = fetchMock.mock.calls[0] as FetchCall
    const url = new URL(String(call[0]))
    expect(url.origin + url.pathname).toBe(`${BASE_URL}/rest/v1/v_entry`)
    expect(url.searchParams.get('select')).toBe('id,seq,slot,body,written_on')
    expect(url.searchParams.get('select')).not.toContain('*')
    expect(url.searchParams.get('order')).toBe('seq.desc')
    expect(url.searchParams.get('limit')).toBe('3')
    expect(url.searchParams.has('seq')).toBe(false)
    expect(headerOf(call, 'apikey')).toBe(ANON_KEY)
    expect(headerOf(call, 'authorization')).toBe(`Bearer ${stored.access_token}`)

    expect(page.has_more).toBe(true)
    expect(page.entries.map((entry) => entry.seq)).toEqual([4, 5])
    expect(page.entries.map((entry) => entry.body)).toEqual(['第二', '第三'])
    expect(page.entries[0]).toEqual({
      id: 'e4',
      seq: 4,
      slot: 'a',
      body: '第二',
      written_on: '2026-11-04',
    })
  })

  it('before_seq 追加 seq=lt.<n>；limit 钳制为 120（请求 121 条）', async () => {
    seedSession()
    fetchMock.mockResolvedValueOnce(jsonResponse([]))
    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    const page = await backend.listEntries(42, 1000)

    const url = new URL(String((fetchMock.mock.calls[0] as FetchCall)[0]))
    expect(url.searchParams.get('seq')).toBe('lt.42')
    expect(url.searchParams.get('limit')).toBe('121')
    expect(page).toEqual({ entries: [], has_more: false })
  })

  it('绝不请求基表 entry（拒绝 select *）', async () => {
    seedSession()
    fetchMock.mockResolvedValueOnce(jsonResponse([]))
    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    await backend.listEntries(10, 120)
    const requested = String((fetchMock.mock.calls[0] as FetchCall)[0])
    expect(requested).toContain('/rest/v1/v_entry?')
    expect(requested).not.toMatch(/\/rest\/v1\/entry(\?|$)/)
  })

  it('视图查询 401 时刷新一次并重试', async () => {
    seedSession()
    const refreshedAccess = makeJwt(nowSeconds() + 7200)
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: refreshedAccess, refresh_token: 'rt-2', user: { id: 'user-1' } }),
      )
      .mockResolvedValueOnce(jsonResponse([rows[0]]))

    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    const page = await backend.listEntries(null, 120)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const calls = fetchMock.mock.calls as FetchCall[]
    expect(String(calls[0][0])).toContain('/rest/v1/v_entry?')
    expect(String(calls[1][0])).toBe(`${BASE_URL}/auth/v1/token?grant_type=refresh_token`)
    expect(String(calls[2][0])).toContain('/rest/v1/v_entry?')
    expect((calls[2][1]?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${refreshedAccess}`,
    )
    expect(page.entries).toHaveLength(1)
    expect(readStoredSession()?.access_token).toBe(refreshedAccess)
  })
})

describe('revokeOtherSessions / closeAndErase', () => {
  it('revokeOtherSessions：POST /auth/v1/logout?scope=others，Bearer 当前 access token', async () => {
    const stored = seedSession()
    fetchMock.mockResolvedValueOnce(emptyResponse(204))
    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    await backend.revokeOtherSessions()

    const call = fetchMock.mock.calls[0] as FetchCall
    expect(String(call[0])).toBe(`${BASE_URL}/auth/v1/logout?scope=others`)
    expect(call[1]?.method).toBe('POST')
    expect(headerOf(call, 'authorization')).toBe(`Bearer ${stored.access_token}`)
    expect(headerOf(call, 'apikey')).toBe(ANON_KEY)
  })

  it('closeAndErase：POST /rest/v1/rpc/close_and_erase，返回空对象', async () => {
    seedSession()
    fetchMock.mockResolvedValueOnce(jsonResponse({}))
    const backend = new SupabaseBackend(BASE_URL, ANON_KEY)
    await expect(backend.closeAndErase()).resolves.toBeUndefined()

    const call = fetchMock.mock.calls[0] as FetchCall
    expect(String(call[0])).toBe(`${BASE_URL}/rest/v1/rpc/close_and_erase`)
    expect(jsonBodyOf(call)).toEqual({})
  })
})
