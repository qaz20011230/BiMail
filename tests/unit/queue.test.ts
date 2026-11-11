import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedEntry } from '../../src/types'
import { KEYS } from '../../src/lib/storage'
import {
  enqueue,
  isUuidV4,
  loadQueue,
  newClientUuid,
  removeQueued,
  saveQueue,
  sortQueue,
} from '../../src/lib/queue'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-9222-222222222222'
const UUID_C = '33333333-3333-4333-a333-333333333333'

function queued(clientUuid: string, writtenOn = '2026-11-12', body = '未寄出的文字'): QueuedEntry {
  return { client_uuid: clientUuid, body, written_on: writtenOn }
}

describe('newClientUuid', () => {
  it('生成合法的 v4 UUID', () => {
    for (let index = 0; index < 50; index += 1) {
      const uuid = newClientUuid()
      expect(uuid).toMatch(UUID_RE)
      expect(isUuidV4(uuid)).toBe(true)
    }
  })

  it('多次调用互不相同', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newClientUuid()))
    expect(ids.size).toBe(100)
  })

  it('crypto.randomUUID 缺失时降级手写 v4', () => {
    const cryptoRef = globalThis.crypto
    const ownRandomUUID = Object.getOwnPropertyDescriptor(cryptoRef, 'randomUUID')
    Object.defineProperty(cryptoRef, 'randomUUID', { configurable: true, value: undefined })
    try {
      const uuid = newClientUuid()
      expect(uuid).toMatch(UUID_RE)
      expect(uuid[14]).toBe('4')
      expect(['8', '9', 'a', 'b']).toContain(uuid[19].toLowerCase())
    } finally {
      if (ownRandomUUID) Object.defineProperty(cryptoRef, 'randomUUID', ownRandomUUID)
      else delete (cryptoRef as { randomUUID?: unknown }).randomUUID
    }
  })

  it('crypto 全部不可用时仍能生成 v4（Math.random 降级）', () => {
    const cryptoRef = globalThis.crypto
    const ownRandomUUID = Object.getOwnPropertyDescriptor(cryptoRef, 'randomUUID')
    const ownGetRandomValues = Object.getOwnPropertyDescriptor(cryptoRef, 'getRandomValues')
    Object.defineProperty(cryptoRef, 'randomUUID', { configurable: true, value: undefined })
    Object.defineProperty(cryptoRef, 'getRandomValues', { configurable: true, value: undefined })
    const randomSpy = vi.spyOn(Math, 'random')
    try {
      const uuid = newClientUuid()
      expect(uuid).toMatch(UUID_RE)
      expect(randomSpy).toHaveBeenCalled()
    } finally {
      randomSpy.mockRestore()
      if (ownRandomUUID) Object.defineProperty(cryptoRef, 'randomUUID', ownRandomUUID)
      else delete (cryptoRef as { randomUUID?: unknown }).randomUUID
      if (ownGetRandomValues) Object.defineProperty(cryptoRef, 'getRandomValues', ownGetRandomValues)
      else delete (cryptoRef as { getRandomValues?: unknown }).getRandomValues
    }
  })
})

describe('queue 持久化', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('没有队列时返回空数组', () => {
    expect(loadQueue()).toEqual([])
  })

  it('损坏或非数组的存储内容返回空数组', () => {
    window.localStorage.setItem(KEYS.queue, 'not json')
    expect(loadQueue()).toEqual([])
    window.localStorage.setItem(KEYS.queue, '{"a":1}')
    expect(loadQueue()).toEqual([])
  })

  it('保存后能原样读回（键固定为 KEYS.queue）', () => {
    const queue = [queued(UUID_A), queued(UUID_B, '2026-11-13')]
    saveQueue(queue)
    expect(window.localStorage.getItem(KEYS.queue)).toBe(JSON.stringify(queue))
    expect(loadQueue()).toEqual(queue)
  })

  it('读回时过滤形状不符的条目', () => {
    const valid = queued(UUID_A)
    window.localStorage.setItem(
      KEYS.queue,
      JSON.stringify([null, 1, 'x', {}, { client_uuid: UUID_B, body: '   ', written_on: '2026-11-12' }, valid]),
    )
    expect(loadQueue()).toEqual([valid])
  })
})

describe('enqueue / removeQueued / sortQueue', () => {
  it('入队追加并返回新数组，不修改原数组', () => {
    const original = [queued(UUID_A)]
    const next = enqueue(original, queued(UUID_B))
    expect(next.map((item) => item.client_uuid)).toEqual([UUID_A, UUID_B])
    expect(original.map((item) => item.client_uuid)).toEqual([UUID_A])
  })

  it('同一 client_uuid 幂等：重复入队不产生第二条', () => {
    const once = enqueue([], queued(UUID_A))
    const twice = enqueue(once, queued(UUID_A, '2026-11-12', '重复内容'))
    expect(twice).toHaveLength(1)
    expect(twice[0].body).toBe('未寄出的文字')
  })

  it('入队不写 localStorage（持久化由 saveQueue 负责）', () => {
    window.localStorage.clear()
    enqueue([], queued(UUID_A))
    expect(window.localStorage.getItem(KEYS.queue)).toBeNull()
  })

  it('按 written_on 升序排列，同日保持入队顺序', () => {
    const queue = enqueue(
      enqueue(enqueue([], queued(UUID_A, '2026-11-13')), queued(UUID_B, '2026-11-12')),
      queued(UUID_C, '2026-11-13'),
    )
    expect(queue.map((item) => item.client_uuid)).toEqual([UUID_B, UUID_A, UUID_C])
    expect(sortQueue(queue)).toEqual(queue)
  })

  it('移除指定 client_uuid，其余保持顺序，幂等且不修改原数组', () => {
    const original = [queued(UUID_A), queued(UUID_B), queued(UUID_C)]
    const next = removeQueued(original, UUID_B)
    expect(next.map((item) => item.client_uuid)).toEqual([UUID_A, UUID_C])
    expect(removeQueued(next, UUID_B)).toEqual(next)
    expect(removeQueued(original, '44000000-0000-4000-8000-000000000000')).toEqual(original)
    expect(original).toHaveLength(3)
  })
})

describe('queue 不触网', () => {
  const fetchSpy = vi.fn()

  beforeEach(() => {
    fetchSpy.mockClear()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('读写/入队/移除/排序/生成 uuid 全程不发起网络请求', () => {
    window.localStorage.clear()
    saveQueue(enqueue([], queued(UUID_A)))
    removeQueued(loadQueue(), UUID_A)
    sortQueue(loadQueue())
    newClientUuid()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
