import { describe, expect, it } from 'vitest'
import { exportFilename, formatExport } from '../../src/lib/export'
import type { Entry, Slot } from '../../src/types'

function entry(seq: number, slot: Slot, body: string, writtenOn: string): Entry {
  return { id: `id-${seq}`, seq, slot, body, written_on: writtenOn }
}

const NOW = new Date(2026, 10, 12, 9, 30)

describe('formatExport', () => {
  it('逐字格式：抬头 + 游程日分组 + 我：/你： + 组间空行（同名日期可重复）', () => {
    const entries: Entry[] = [
      entry(1, 'b', '他写的第一个', '2026-11-08'),
      entry(2, 'a', '我写的第一个', '2026-11-08'),
      entry(3, 'a', '第二日我写的', '2026-11-09'),
      entry(4, 'b', '八日又一条', '2026-11-08'),
    ]
    const expected = [
      'BiMail · 导出于 2026年11月12日',
      '—— 11月8日',
      '你：他写的第一个',
      '我：我写的第一个',
      '',
      '—— 11月9日',
      '我：第二日我写的',
      '',
      '—— 11月8日',
      '你：八日又一条',
    ].join('\n')
    const actual = formatExport(entries, 'a', NOW)
    expect(actual).toBe(expected)
    // 无尾随换行；抬头与首组之间不空行。
    expect(actual.endsWith('\n')).toBe(false)
    expect(actual.split('\n')[1]).toBe('—— 11月8日')
  })

  it('mySlot 为 b 时标签反转：我的=我：，笔友=你：，顺序不变', () => {
    const entries: Entry[] = [
      entry(1, 'b', 'b 的话', '2026-11-12'),
      entry(2, 'a', 'a 的话', '2026-11-12'),
    ]
    const expected = [
      'BiMail · 导出于 2026年11月12日',
      '—— 11月12日',
      '我：b 的话',
      '你：a 的话',
    ].join('\n')
    expect(formatExport(entries, 'b', NOW)).toBe(expected)
  })

  it('跨年日期用完整年份；同年日期不带年份', () => {
    const entries: Entry[] = [
      entry(1, 'a', '去年最后一天', '2025-12-31'),
      entry(2, 'b', '今年第一天', '2026-01-01'),
    ]
    const expected = [
      'BiMail · 导出于 2026年11月12日',
      '—— 2025年12月31日',
      '我：去年最后一天',
      '',
      '—— 1月1日',
      '你：今年第一天',
    ].join('\n')
    expect(formatExport(entries, 'a', NOW)).toBe(expected)
  })

  it('跨年游程重复：同日期标签可出现多次，不排序、不跨组聚合', () => {
    const entries: Entry[] = [
      entry(1, 'a', '一', '2025-11-08'),
      entry(2, 'b', '二', '2026-11-08'),
      entry(3, 'a', '三', '2025-11-08'),
    ]
    const actual = formatExport(entries, 'a', NOW)
    expect(actual).toBe(
      [
        'BiMail · 导出于 2026年11月12日',
        '—— 2025年11月8日',
        '我：一',
        '',
        '—— 11月8日',
        '你：二',
        '',
        '—— 2025年11月8日',
        '我：三',
      ].join('\n'),
    )
  })

  it('空序列只有抬头一行', () => {
    expect(formatExport([], 'a', NOW)).toBe('BiMail · 导出于 2026年11月12日')
  })

  it('正文原样保留（含换行），不做任何清洗或加链接', () => {
    const entries: Entry[] = [entry(1, 'a', '第一行\n第二行', '2026-11-12')]
    expect(formatExport(entries, 'a', NOW)).toBe(
      'BiMail · 导出于 2026年11月12日\n—— 11月12日\n我：第一行\n第二行',
    )
  })
})

describe('exportFilename', () => {
  it('bimail-<本地日期>.txt', () => {
    expect(exportFilename(NOW)).toBe('bimail-2026-11-12.txt')
    expect(exportFilename(new Date(2026, 0, 5))).toBe('bimail-2026-01-05.txt')
  })
})
