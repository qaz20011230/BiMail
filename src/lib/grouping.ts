/**
 * 日游程分组（run-length）：相邻且 written_on 相同者归为一组，日期变化即开新组。
 * 不排序、不去重、不跨组聚合——标签允许非单调重复（宁可重复，不可撒谎，绝不重排）。
 */

import type { Entry, WallSnapshot } from '../types'
import { copy } from '../copy'
import { formatDayLabel, formatMonthDay } from './date'

export interface DayGroup {
  /** 组键：写作者写下该留言时的本地日期，YYYY-MM-DD */
  writtenOn: string
  /** 日期标签：同年 11月8日；跨年 2026年11月8日 */
  label: string
  /** 该游程内的留言，保持输入顺序 */
  entries: Entry[]
}

/**
 * @param entries 已寄出的留言，按服务端 seq 升序
 * @param now 仅用于判断"同年/跨年"，不影响分组与排序
 */
export function groupByDay(entries: readonly Entry[], now: Date = new Date()): DayGroup[] {
  const groups: DayGroup[] = []
  for (const entry of entries) {
    const current = groups[groups.length - 1]
    if (current !== undefined && current.writtenOn === entry.written_on) {
      current.entries.push(entry)
      continue
    }
    groups.push({
      writtenOn: entry.written_on,
      label: formatDayLabel(entry.written_on, now),
      entries: [entry],
    })
  }
  return groups
}

/**
 * 派生语：仅 open 时返回一行座位建立说明（b 座的加入日，天粒度、双方共知）。
 * 其余状态返回空数组。
 */
export function derivedLines(snapshot: WallSnapshot, _now?: Date): string[] {
  if (snapshot.state !== 'open') return []
  const penpal = snapshot.seats.find((seat) => seat.slot === 'b')
  if (penpal === undefined) return []
  return [copy.seatEstablished(formatMonthDay(penpal.joined_on))]
}
