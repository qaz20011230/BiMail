import { describe, expect, it } from 'vitest'
import {
  MAX_CODEPOINTS,
  codepointLength,
  excessCodepoints,
  insertPlainText,
  normalizeInput,
  truncateToCodepoints,
} from '../../src/lib/input'

describe('normalizeInput', () => {
  it('把 \\r\\n 与孤立的 \\r 统一成 \\n', () => {
    expect(normalizeInput('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('连续 3 个及以上换行折叠为 2 个', () => {
    expect(normalizeInput('a\n\n\nb')).toBe('a\n\nb')
    expect(normalizeInput('a\n\n\n\n\nb')).toBe('a\n\nb')
    expect(normalizeInput('a\n\nb')).toBe('a\n\nb')
    expect(normalizeInput('\n\n\n')).toBe('\n\n')
  })

  it('制表符变成 2 个空格', () => {
    expect(normalizeInput('a\tb\t\tc')).toBe('a  b    c')
  })

  it('剔除零宽字符 U+200B–U+200D 与 U+FEFF', () => {
    expect(normalizeInput('a\u200Bb\u200Cc\u200Dd\uFEFFe')).toBe('abcde')
    expect(normalizeInput('\u200B\uFEFF')).toBe('')
  })

  it('CRLF 先统一再参与三连换行折叠', () => {
    expect(normalizeInput('a\r\n\r\n\r\nb')).toBe('a\n\nb')
    expect(normalizeInput('a\r\n\r\nb')).toBe('a\n\nb')
  })

  it('不 trim：首尾留白由调用方判断', () => {
    expect(normalizeInput('  a  ')).toBe('  a  ')
    expect(normalizeInput(' \n\t ')).toBe(' \n   ')
  })

  it('归一化是幂等的', () => {
    const raw = 'a\r\n\t\r\n\r\n\u200Bb'
    const once = normalizeInput(raw)
    expect(normalizeInput(once)).toBe(once)
  })
})

describe('codepointLength', () => {
  it('按 Unicode 码点计数，不按 UTF-16 单元', () => {
    expect(codepointLength('')).toBe(0)
    expect(codepointLength('abc')).toBe(3)
    expect(codepointLength('你好')).toBe(2)
    expect(codepointLength('😀')).toBe(1)
    expect(codepointLength('😀a😀')).toBe(3)
    expect(codepointLength('𝄞')).toBe(1)
    expect(codepointLength('😀'.repeat(8000))).toBe(8000)
  })
})

describe('truncateToCodepoints', () => {
  it('未超限时原样返回', () => {
    expect(truncateToCodepoints('abc', 3)).toBe('abc')
    expect(truncateToCodepoints('abc', 8)).toBe('abc')
  })

  it('按码点截断且不切断代理对', () => {
    const emoji = '😀'
    expect(truncateToCodepoints(emoji.repeat(2), 1)).toBe(emoji)
    expect(truncateToCodepoints(`${emoji}a${emoji}`, 2)).toBe(`${emoji}a`)
    expect(truncateToCodepoints('你好世界', 2)).toBe('你好')
  })

  it('默认上限是 8000 码点', () => {
    expect(MAX_CODEPOINTS).toBe(8000)
    const text = 'x'.repeat(8000)
    expect(truncateToCodepoints(text)).toBe(text)
    expect(codepointLength(truncateToCodepoints('x'.repeat(8001)))).toBe(8000)
  })

  it('上限 <= 0 时返回空串', () => {
    expect(truncateToCodepoints('abc', 0)).toBe('')
    expect(truncateToCodepoints('abc', -1)).toBe('')
  })
})

describe('excessCodepoints', () => {
  it('未超限为 0，超限返回差值', () => {
    expect(excessCodepoints('abc', 5)).toBe(0)
    expect(excessCodepoints('abcdef', 5)).toBe(1)
    expect(excessCodepoints('😀😀😀', 2)).toBe(1)
  })
})

describe('insertPlainText', () => {
  it('在空文本中插入纯文本', () => {
    expect(insertPlainText('', 0, 0, 'hello')).toEqual({ value: 'hello', caret: 5, excess: 0 })
  })

  it('在光标处插入', () => {
    expect(insertPlainText('ab', 1, 1, 'X')).toEqual({ value: 'aXb', caret: 2, excess: 0 })
  })

  it('替换选区', () => {
    expect(insertPlainText('abcdef', 1, 4, 'X')).toEqual({ value: 'aXef', caret: 2, excess: 0 })
  })

  it('越界或反向的选区被夹紧', () => {
    expect(insertPlainText('abc', 99, 99, 'd')).toEqual({ value: 'abcd', caret: 4, excess: 0 })
    expect(insertPlainText('abcdef', 4, 1, 'X')).toEqual({ value: 'aXef', caret: 2, excess: 0 })
    expect(insertPlainText('abc', -5, -2, 'X')).toEqual({ value: 'Xabc', caret: 1, excess: 0 })
  })

  it('粘贴内容先归一化（CRLF/三连换行/制表符/零宽字符）', () => {
    const insertion = insertPlainText('', 0, 0, 'a\r\n\r\n\r\nb\tc\u200B')
    expect(insertion.value).toBe('a\n\nb  c')
    expect(insertion.caret).toBe(insertion.value.length)
  })

  it('合并后超过上限时截断并给出溢出量', () => {
    const insertion = insertPlainText('abc', 3, 3, 'defgh', 5)
    expect(insertion.value).toBe('abcde')
    expect(insertion.caret).toBe(5)
    expect(insertion.excess).toBe(3)
  })

  it('默认上限为 8000 码点且不切断代理对', () => {
    const insertion = insertPlainText('', 0, 0, '😀'.repeat(8001))
    expect(codepointLength(insertion.value)).toBe(8000)
    expect(insertion.value).toBe('😀'.repeat(8000))
    expect(insertion.excess).toBe(1)
  })
})
