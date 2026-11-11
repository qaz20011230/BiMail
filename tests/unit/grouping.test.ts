import { describe, expect, it } from 'vitest'
import type { Entry, SeatInfo, Slot, WallSnapshot, WallState } from '../../src/types'
import { copy } from '../../src/copy'
import { derivedLines, groupByDay } from '../../src/lib/grouping'

/** 固定"现在"：2026-11-12 本地时间，用于同年/跨年判定。 */
const NOW = new Date(2026, 10, 12)

function entry(seq: number, writtenOn: string, slot: Slot = 'a'): Entry {
  return {
    id: `id-${seq}`,
    seq,
    slot,
    body: `body-${seq}`,
    written_on: writtenOn,
  }
}

function seat(slot: Slot, joinedOn: string): SeatInfo {
  return { slot, joined_on: joinedOn }
}

function snapshot(state: WallState, seats: SeatInfo[]): WallSnapshot {
  return { dyad_id: 'dyad-1', state, my_slot: 'a', seats, invite: null }
}

describe('groupByDay：游程分组', () => {
  it('空列表返回空数组', () => {
    expect(groupByDay([], NOW)).toEqual([])
  })

  it('相邻且 written_on 相同者归为一组，组内保持输入顺序', () => {
    const entries = [
      entry(1, '2026-11-08'),
      entry(2, '2026-11-08', 'b'),
      entry(3, '2026-11-09', 'b'),
    ]

    const groups = groupByDay(entries, NOW)

    expect(groups.map((group) => group.writtenOn)).toEqual(['2026-11-08', '2026-11-09'])
    expect(groups[0].entries.map((item) => item.seq)).toEqual([1, 2])
    expect(groups[1].entries.map((item) => item.seq)).toEqual([3])
    expect(groups[0].entries.map((item) => item.body)).toEqual(['body-1', 'body-2'])
  })

  it('同一日期被其他日期隔开后成为两个组：标签重复，不跨组聚合', () => {
    const entries = [
      entry(1, '2026-11-08'),
      entry(2, '2026-11-09'),
      entry(3, '2026-11-08'),
    ]

    const groups = groupByDay(entries, NOW)

    expect(groups).toHaveLength(3)
    expect(groups.map((group) => group.label)).toEqual(['11月8日', '11月9日', '11月8日'])
    expect(groups[0].entries.map((item) => item.seq)).toEqual([1])
    expect(groups[2].entries.map((item) => item.seq)).toEqual([3])
  })

  it('不排序：输入日期非单调时按输入顺序分组，绝不重排', () => {
    const entries = [entry(1, '2026-11-09'), entry(2, '2026-11-08')]

    const groups = groupByDay(entries, NOW)

    expect(groups.map((group) => group.writtenOn)).toEqual(['2026-11-09', '2026-11-08'])
    expect(groups.map((group) => group.entries[0].seq)).toEqual([1, 2])
  })

  it('同年标签为 11月8日；跨年标签带年份', () => {
    expect(groupByDay([entry(1, '2026-11-08')], NOW)[0].label).toBe('11月8日')
    expect(groupByDay([entry(1, '2025-12-31')], NOW)[0].label).toBe('2025年12月31日')
  })

  it('跨年重复日期：同一天的不同年份标签各不相同且可重复出现', () => {
    const entries = [
      entry(1, '2025-11-08'),
      entry(2, '2026-11-08'),
      entry(3, '2025-11-08'),
    ]

    const labels = groupByDay(entries, NOW).map((group) => group.label)

    expect(labels).toEqual(['2025年11月8日', '11月8日', '2025年11月8日'])
  })

  it('不校验、不丢弃：非法日期键原样成组并以原键为标签', () => {
    const groups = groupByDay([entry(1, 'not-a-date')], NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0].writtenOn).toBe('not-a-date')
    expect(groups[0].label).toBe('not-a-date')
  })

  it('不修改输入数组', () => {
    const entries = [entry(1, '2026-11-08'), entry(2, '2026-11-08')]
    const before = entries.map((item) => item.seq)

    groupByDay(entries, NOW)

    expect(entries.map((item) => item.seq)).toEqual(before)
    expect(entries).toHaveLength(2)
  })
})

describe('derivedLines：派生语', () => {
  it('nascent 返回空数组', () => {
    expect(derivedLines(snapshot('nascent', [seat('a', '2026-11-08')]))).toEqual([])
  })

  it('closed 返回空数组', () => {
    const seats = [seat('a', '2026-11-08'), seat('b', '2026-11-12')]
    expect(derivedLines(snapshot('closed', seats))).toEqual([])
  })

  it('open 返回 b 座加入日的座位建立行', () => {
    const seats = [seat('a', '2026-11-08'), seat('b', '2026-11-12')]

    const lines = derivedLines(snapshot('open', seats))

    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(copy.seatEstablished('11月12日'))
    expect(lines[0]).toBe('11月12日，两位笔友到齐。')
  })

  it('open 但缺少 b 座时返回空数组（不抛错）', () => {
    expect(derivedLines(snapshot('open', [seat('a', '2026-11-08')]))).toEqual([])
  })
})
