/** 后端错误码。适配器把 HTTP 状态与响应体里的 error 字段归一化为这些码。 */

export type BackendErrorCode =
  | 'no_seat'
  | 'already_seated'
  | 'invite_expired'
  | 'invite_consumed'
  | 'invite_unknown'
  | 'wall_closed'
  | 'invalid_body'
  | 'invalid_uuid'
  | 'invalid_hash'
  | 'invalid_token'
  | 'throttled'
  | 'unauthorized'
  | 'network'
  | 'http'
  | 'unknown'

export class BackendError extends Error {
  readonly code: BackendErrorCode

  constructor(code: BackendErrorCode, detail?: string) {
    super(detail ?? code)
    this.name = 'BackendError'
    this.code = code
  }
}

export function isBackendError(error: unknown): error is BackendError {
  if (error instanceof BackendError) return true
  // 跨模块实例（测试重置模块、独立 bundle）时 instanceof 会失效，改用结构判定。
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; code?: unknown }
  return candidate.name === 'BackendError' && typeof candidate.code === 'string'
}

/** 网络不可用或服务端暂时不可达：用于决定"回落 queued"而不是报错。 */
export function isTransient(error: unknown): boolean {
  return isBackendError(error) && (error.code === 'network' || error.code === 'http')
}

export const KNOWN_BACKEND_ERRORS: readonly BackendErrorCode[] = [
  'no_seat',
  'already_seated',
  'invite_expired',
  'invite_consumed',
  'invite_unknown',
  'wall_closed',
  'invalid_body',
  'invalid_uuid',
  'invalid_hash',
  'invalid_token',
  'throttled',
  'unauthorized',
  'network',
  'http',
  'unknown',
]

export function toBackendErrorCode(raw: unknown): BackendErrorCode {
  return typeof raw === 'string' && (KNOWN_BACKEND_ERRORS as readonly string[]).includes(raw)
    ? (raw as BackendErrorCode)
    : 'unknown'
}
