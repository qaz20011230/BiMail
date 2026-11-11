/**
 * 输入归一化、码点计量与纯文本插入。寄出、粘贴、超限处理共用这一组纯函数，
 * 保证任何进入留言的文本都经过同一条路径（规格见 docs/SPEC.md §3.2）。
 */

/** 一条留言的码点上限。 */
export const MAX_CODEPOINTS = 8000

const CRLF = /\r\n?/g
const TAB = /\t/g
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g
const TRIPLE_NEWLINE = /\n{3,}/g

/**
 * 归一化：
 * - `\r\n` / 单独的 `\r` → `\n`
 * - 制表符 → 2 个空格
 * - 剔除零宽字符 U+200B–U+200D、U+FEFF
 * - 连续 ≥3 个换行折叠为 2 个
 */
export function normalizeInput(raw: string): string {
  return raw.replace(CRLF, '\n').replace(TAB, '  ').replace(ZERO_WIDTH, '').replace(TRIPLE_NEWLINE, '\n\n')
}

/** 按 Unicode 码点计长（astral 字符计 1，与后端 char_length 语义不同，但以此为准）。 */
export function codepointLength(text: string): number {
  let length = 0
  const iterator = text[Symbol.iterator]()
  while (!iterator.next().done) length += 1
  return length
}

/** 截断到 `max` 个码点；不会切断代理对。 */
export function truncateToCodepoints(text: string, max: number = MAX_CODEPOINTS): string {
  if (max <= 0) return ''
  const points = Array.from(text)
  if (points.length <= max) return text
  return points.slice(0, max).join('')
}

/** 超出上限的码点数（未超出为 0）。 */
export function excessCodepoints(text: string, max: number = MAX_CODEPOINTS): number {
  return Math.max(0, codepointLength(text) - max)
}

export interface TextInsertion {
  /** 插入后的完整文本（已截断到上限）。 */
  value: string
  /** 插入后光标位置（UTF-16 单元索引，可直接给 textarea.selectionStart）。 */
  caret: number
  /** 整段结果被截掉的码点数（0 表示未超限）。 */
  excess: number
}

/**
 * 把剪贴板纯文本插入 `current` 的 `[start, end)` 选区：
 * 粘贴内容先归一化，再与原有文本合并并整体截断到上限。
 * 选区位置按 UTF-16 单元解释（与 textarea 的 selectionStart 一致）。
 */
export function insertPlainText(
  current: string,
  start: number,
  end: number,
  pasted: string,
  max: number = MAX_CODEPOINTS,
): TextInsertion {
  const length = current.length
  const from = Math.min(Math.max(0, Math.min(start, end)), length)
  const to = Math.min(Math.max(0, Math.max(start, end)), length)
  const inserted = normalizeInput(pasted)
  const combined = current.slice(0, from) + inserted + current.slice(to)
  const excess = excessCodepoints(combined, max)
  const value = truncateToCodepoints(combined, max)
  const caret = Math.min(from + inserted.length, value.length)
  return { value, caret, excess }
}
