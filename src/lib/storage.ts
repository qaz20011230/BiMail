/** localStorage 键与安全读写（Safari 无痕等场景下失败不抛错）。 */

export const KEYS = {
  session: 'bimail.session',
  recoveryKey: 'bimail.recovery_key',
  draft: 'bimail.draft',
  queue: 'bimail.queue',
  lastSeen: 'bimail.last_seen_seq',
  firstCommit: 'bimail.first_commit_done',
  pendingRecovery: 'bimail.pending_recovery',
  invite: 'bimail.invite',
} as const

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* 存储不可用时静默降级：功能退化为仅本次会话 */
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* noop */
  }
}

export function readJSON<T>(key: string): T | null {
  const raw = safeGet(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function writeJSON(key: string, value: unknown): void {
  safeSet(key, JSON.stringify(value))
}

export function removeKey(key: string): void {
  safeRemove(key)
}

export function readString(key: string): string | null {
  return safeGet(key)
}

export function writeString(key: string, value: string): void {
  safeSet(key, value)
}
