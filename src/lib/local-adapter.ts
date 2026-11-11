/** local 后端适配器：把同一契约映射到 /api（零服务开发后端，见 server/dev-server.mjs）。 */

import { ENTRY_PAGE_SIZE, type Backend, type CommitInput } from './adapter'
import { BackendError, toBackendErrorCode, type BackendErrorCode } from './errors'
import { KEYS, readJSON, removeKey, writeJSON } from './storage'
import type { EntryPage, PostedEntry, Session, WallSnapshot } from '../types'

const API_BASE = '/api'

function readSession(): Session | null {
  const session = readJSON<Session>(KEYS.session)
  if (!session || typeof session.access_token !== 'string' || typeof session.user_id !== 'string') {
    return null
  }
  return session
}

function saveSession(session: Session): void {
  writeJSON(KEYS.session, session)
}

async function request<T>(
  path: string,
  options: { body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const session = readSession()
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.auth !== false) {
    if (!session) throw new BackendError('unauthorized')
    headers.authorization = `Bearer ${session.access_token}`
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body ?? {}),
    })
  } catch {
    throw new BackendError('network')
  }

  if (!response.ok) {
    let code: BackendErrorCode = response.status === 401 ? 'unauthorized' : 'http'
    try {
      const data = (await response.json()) as { error?: unknown }
      if (typeof data.error === 'string') code = toBackendErrorCode(data.error)
    } catch {
      /* 无 JSON 响应体 */
    }
    if (code === 'unauthorized') removeKey(KEYS.session)
    throw new BackendError(code)
  }

  return (await response.json()) as T
}

async function createAnonymousSession(): Promise<Session> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}/auth/anonymous`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  } catch {
    throw new BackendError('network')
  }
  if (!response.ok) throw new BackendError('http')
  const session = (await response.json()) as Session
  saveSession(session)
  return session
}

export class LocalBackend implements Backend {
  readonly mode = 'local' as const

  async ensureSession(): Promise<Session> {
    return readSession() ?? createAnonymousSession()
  }

  async createWall(recoveryHash: string): Promise<WallSnapshot> {
    const data = await request<{ snapshot: WallSnapshot }>('/rpc/create_wall', {
      body: { recovery_hash: recoveryHash },
    })
    return data.snapshot
  }

  async acceptInvite(token: string, recoveryHash: string): Promise<WallSnapshot> {
    const data = await request<{ snapshot: WallSnapshot }>('/rpc/accept_invite', {
      body: { token, recovery_hash: recoveryHash },
    })
    return data.snapshot
  }

  async wallSnapshot(): Promise<WallSnapshot> {
    const data = await request<{ snapshot: WallSnapshot }>('/rpc/wall_state')
    return data.snapshot
  }

  async listEntries(beforeSeq: number | null, limit: number = ENTRY_PAGE_SIZE): Promise<EntryPage> {
    return request<EntryPage>('/rpc/list_entries', {
      body: { before_seq: beforeSeq, limit },
    })
  }

  async postEntry(input: CommitInput): Promise<PostedEntry> {
    return request<PostedEntry>('/rpc/post_entry', { body: input })
  }

  async rebindSeat(recoveryHash: string): Promise<WallSnapshot> {
    const data = await request<{ snapshot: WallSnapshot }>('/rpc/rebind_seat', {
      body: { recovery_hash: recoveryHash },
    })
    return data.snapshot
  }

  async revokeOtherSessions(): Promise<void> {
    await request<Record<string, never>>('/rpc/revoke_other_sessions')
  }

  async closeAndErase(): Promise<void> {
    await request<Record<string, never>>('/rpc/close_and_erase')
  }
}
