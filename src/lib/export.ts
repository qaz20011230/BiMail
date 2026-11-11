/**
 * 纯文本导出（SPEC §5.7 / CONTRACT §5.4）。
 *
 * 格式逐字：
 *   BiMail · 导出于 2026年11月12日
 *   —— 11月8日
 *   你：……
 *   我：……
 *   （组与组之间空一行）
 *
 * 游程分组与 wall 的 `lib/grouping.ts` 同语义（相邻同 `written_on` 归一组；不排序、不去重、
 * 不跨组聚合，标签可重复）。为避免跨角色阻塞，此处自带同一算法的 15 行实现，QA 会核对两处一致。
 */

import { copy } from '../copy'
import type { Entry, Slot } from '../types'
import { formatDayLabel, formatFullDate, localISODate } from './date'

interface ExportGroup {
  writtenOn: string
  label: string
  entries: Entry[]
}

/** 游程分组：相邻且 written_on 相同者归为一组；日期变化即开新组。 */
function groupRuns(entries: Entry[], now: Date): ExportGroup[] {
  const groups: ExportGroup[] = []
  for (const entry of entries) {
    const last = groups.length > 0 ? groups[groups.length - 1] : undefined
    if (last !== undefined && last.writtenOn === entry.written_on) {
      last.entries.push(entry)
    } else {
      groups.push({
        writtenOn: entry.written_on,
        label: formatDayLabel(entry.written_on, now),
        entries: [entry],
      })
    }
  }
  return groups
}

/** 我：/你： 标签由座位归属决定，不改变条目原顺序。 */
function formatEntryLine(entry: Entry, mySlot: Slot): string {
  const prefix = entry.slot === mySlot ? copy.exportMine : copy.exportTheirs
  return `${prefix}${entry.body}`
}

export function formatExport(entries: Entry[], mySlot: Slot, now: Date = new Date()): string {
  const title = copy.exportTitle(formatFullDate(localISODate(now)))
  const groups = groupRuns(entries, now)
  if (groups.length === 0) return title
  const sections = groups.map((group) => {
    const lines = [
      copy.exportDay(group.label),
      ...group.entries.map((entry) => formatEntryLine(entry, mySlot)),
    ]
    return lines.join('\n')
  })
  // 抬头与首组之间不空行；组与组之间空一行（SPEC §5.7 样例 + 组间空行）。
  return `${title}\n${sections.join('\n\n')}`
}

export function exportFilename(now: Date = new Date()): string {
  return copy.exportFileName(localISODate(now))
}
