import { beforeEach, describe, expect, it } from 'vitest'
import type { Entry } from '../../src/types'
import { KEYS } from '../../src/lib/storage'
import { readLastSeen, resolveAnchorSeq, writeLastSeen } from '../../src/lib/read-position'

function entry(seq: number): Entry {
  return {
    id: `id-${seq}`,
    seq,
    slot: seq % 2 === 0 ? 'b' : 'a',
    body: `body-${seq}`,
    written_on: '2026-11-08',
  }
}

describe('readLastSeen / writeLastSeen', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('无记录时返回 null', () => {
    expect(readLastSeen()).toBeNull()
  })

  it('写入后读回同一个 seq，并落在 KEYS.lastSeen 键上', () => {
    writeLastSeen(42)

    expect(readLastSeen()).toBe(42)
    expect(window.localStorage.getItem(KEYS.lastSeen)).toBe('42')
    expect(KEYS.lastSeen).toBe('bimail.last_seen_seq')
  })

  it('覆盖写入只保留最新位置', () => {
    writeLastSeen(3)
    writeLastSeen(9)

    expect(readLastSeen()).toBe(9)
  })

  it('存储内容非法时返回 null，不抛错', () => {
    window.localStorage.setItem(KEYS.lastSeen, 'not-a-number')
    expect(readLastSeen()).toBeNull()

    window.localStorage.setItem(KEYS.lastSeen, '')
    expect(readLastSeen()).toBeNull()

    window.localStorage.setItem(KEYS.lastSeen, '-1')
    expect(readLastSeen()).toBeNull()

    window.localStorage.setItem(KEYS.lastSeen, '3.5')
    expect(readLastSeen()).toBeNull()
  })

  it('非整数 seq 不写入（存储保持原状）', () => {
    writeLastSeen(3.5)
    expect(window.localStorage.getItem(KEYS.lastSeen)).toBeNull()
  })
})

describe('resolveAnchorSeq：定位锚点', () => {
  const ascending = [entry(10), entry(11), entry(12)]

  it('lastSeen 为 null（首次进入）返回 null', () => {
    expect(resolveAnchorSeq(ascending, null)).toBeNull()
  })

  it('列表为空返回 null', () => {
    expect(resolveAnchorSeq([], 11)).toBeNull()
  })

  it('命中已有 seq 时返回该条', () => {
    expect(resolveAnchorSeq(ascending, 11)).toBe(11)
    expect(resolveAnchorSeq(ascending, 10)).toBe(10)
  })

  it('落在两条之间时取 seq ≤ lastSeen 的最后一条', () => {
    const entries = [entry(10), entry(12), entry(14)]

    expect(resolveAnchorSeq(entries, 13)).toBe(12)
    expect(resolveAnchorSeq(entries, 11)).toBe(10)
  })

  it('全都比 lastSeen 新时取最旧一条', () => {
    expect(resolveAnchorSeq(ascending, 5)).toBe(10)
  })

  it('lastSeen 比全部条目都新时取最新一条', () => {
    expect(resolveAnchorSeq(ascending, 99)).toBe(12)
  })
})
