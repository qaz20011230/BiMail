/**
 * 离线队列：localStorage 持久化、只做本地增删排序，**不发任何网络请求**
 * （寄出由上层 store 负责，SPEC §2.4 / §3.3）。
 */

import { KEYS, readJSON, writeJSON } from './storage'
import type { QueuedEntry } from '../types'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** 生成 v4 UUID：优先 crypto.randomUUID，缺失时手写（crypto.getRandomValues 降级 Math.random）。 */
export function newClientUuid(): string {
  const webCrypto: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    try {
      return webCrypto.randomUUID()
    } catch {
      /* 非安全上下文等场景：继续手写 v4 */
    }
  }
  return fallbackUuidV4()
}

function fallbackUuidV4(): string {
  const bytes = new Uint8Array(16)
  const webCrypto: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function isQueuedEntry(value: unknown): value is QueuedEntry {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.client_uuid === 'string' &&
    typeof candidate.body === 'string' &&
    typeof candidate.written_on === 'string' &&
    candidate.body.trim().length > 0
  )
}

/** 读取队列；缺失、损坏或形状不符时返回空数组（不抛错）。 */
export function loadQueue(): QueuedEntry[] {
  const raw = readJSON<unknown>(KEYS.queue)
  if (!Array.isArray(raw)) return []
  return raw.filter(isQueuedEntry)
}

/** 持久化队列（只用 localStorage）。 */
export function saveQueue(queue: readonly QueuedEntry[]): void {
  writeJSON(KEYS.queue, queue)
}

/** 稳定排序：按写作者本地日期升序，同日保持入队顺序。 */
export function sortQueue(queue: readonly QueuedEntry[]): QueuedEntry[] {
  return [...queue].sort((left, right) => {
    if (left.written_on < right.written_on) return -1
    if (left.written_on > right.written_on) return 1
    return 0
  })
}

/** 入队（纯函数）。同一 client_uuid 幂等：已存在时不重复追加。 */
export function enqueue(queue: readonly QueuedEntry[], entry: QueuedEntry): QueuedEntry[] {
  if (queue.some((item) => item.client_uuid === entry.client_uuid)) return sortQueue(queue)
  return sortQueue([...queue, entry])
}

/** 按 client_uuid 移出队列（纯函数，幂等）。 */
export function removeQueued(queue: readonly QueuedEntry[], clientUuid: string): QueuedEntry[] {
  return queue.filter((item) => item.client_uuid !== clientUuid)
}

/** 是否为合法 v4 UUID（测试与上层校验共用）。 */
export function isUuidV4(value: string): boolean {
  return UUID_V4.test(value)
}
