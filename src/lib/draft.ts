/**
 * 未寄出文字的本地草稿。只存本设备 localStorage，永不跨越座位边界、永不上行
 * （A3 / SPEC §3.2 的实现约束，而非体验优化）。
 */

import { KEYS, readString, removeKey, writeString } from './storage'

/** 输入到写入 localStorage 的节流间隔（毫秒）。 */
export const DRAFT_SAVE_DELAY_MS = 300

/** 读取本设备草稿；没有或不可读时返回空串。 */
export function loadDraft(): string {
  return readString(KEYS.draft) ?? ''
}

/** 写入草稿；空串等价于清除（不留下空键）。 */
export function saveDraft(body: string): void {
  if (body.length === 0) {
    removeKey(KEYS.draft)
    return
  }
  writeString(KEYS.draft, body)
}

/** 清除草稿（寄出成功后同步调用）。 */
export function clearDraft(): void {
  removeKey(KEYS.draft)
}
