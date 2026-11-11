/** 邀请 token：只存在于 URL fragment；读取后立即清除，不进入服务器日志/Referer/缓存键。 */

import { copy } from '../copy'

/** fragment 中读取 `#i=<token>`。任何情况下读到 i= 参数都立刻 replaceState 清除历史。 */
export function takeInviteTokenFromUrl(): string | null {
  const hash = window.location.hash
  if (!hash || !hash.includes('i=')) return null

  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const raw = params.get('i')
  // 无论是否合法都清除 fragment：不把邀请留在历史记录与截图里
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  return raw
}

/** 邀请链接：token 置于 fragment，无查询参数、无路径信息。 */
export function buildInviteUrl(token: string): string {
  const { origin, pathname } = window.location
  return `${origin}${pathname}#i=${token}`
}

/** 32 字符 base64url = 192 位熵。 */
export function isPlausibleInviteToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(token)
}

export function inviteTokenErrorLine(token: string): string {
  return isPlausibleInviteToken(token) ? copy.inviteExpired : copy.inviteTokenInvalid
}
