/** 日期工具：日粒度、无时区换算、无相对时间。 */

/** 本地日期 YYYY-MM-DD（写作者自己的"那一天"）。 */
export function localISODate(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

interface IsoParts {
  year: number
  month: number
  day: number
}

function parseISO(iso: string): IsoParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day }
}

/** 同年：11月8日；跨年：2026年11月8日。 */
export function formatDayLabel(iso: string, now: Date = new Date()): string {
  const parts = parseISO(iso)
  if (!parts) return iso
  if (parts.year === now.getFullYear()) return `${parts.month}月${parts.day}日`
  return `${parts.year}年${parts.month}月${parts.day}日`
}

/** 11月8日（不比较年份，用于派生语"座位建立日"）。 */
export function formatMonthDay(iso: string): string {
  const parts = parseISO(iso)
  if (!parts) return iso
  return `${parts.month}月${parts.day}日`
}

/** 2026年11月12日（导出抬头用完整日期）。 */
export function formatFullDate(iso: string): string {
  const parts = parseISO(iso)
  if (!parts) return iso
  return `${parts.year}年${parts.month}月${parts.day}日`
}
