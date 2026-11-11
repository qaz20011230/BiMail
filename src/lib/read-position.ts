/**
 * 阅读位置：上次离开处的 seq。仅存本设备 localStorage，绝不上行。
 * 位置本身即唯一提示——不加"新"标记。
 */

import type { Entry } from '../types'
import { KEYS, readString, writeString } from './storage'

function parseSeq(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value < 0) return null
  return value
}

export function readLastSeen(): number | null {
  const raw = readString(KEYS.lastSeen)
  if (raw === null) return null
  return parseSeq(raw)
}

export function writeLastSeen(seq: number): void {
  if (!Number.isInteger(seq) || seq < 0) return
  writeString(KEYS.lastSeen, String(seq))
}

/**
 * 锚点 seq：取 seq ≤ lastSeen 的最后一条；若全都更新则取最旧一条。
 * lastSeen 为 null（首次进入）或列表为空时返回 null。
 */
export function resolveAnchorSeq(
  entries: readonly Entry[],
  lastSeen: number | null,
): number | null {
  if (lastSeen === null || entries.length === 0) return null
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry !== undefined && entry.seq <= lastSeen) return entry.seq
  }
  const oldest = entries[0]
  return oldest === undefined ? null : oldest.seq
}
