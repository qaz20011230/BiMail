import { beforeEach, describe, expect, it } from 'vitest'
import { KEYS } from '../../src/lib/storage'
import { DRAFT_SAVE_DELAY_MS, clearDraft, loadDraft, saveDraft } from '../../src/lib/draft'

describe('draft', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('没有草稿时返回空串', () => {
    expect(loadDraft()).toBe('')
  })

  it('保存后能原样读回（含换行与首尾留白）', () => {
    saveDraft('第一行\n\n  第二行  ')
    expect(window.localStorage.getItem(KEYS.draft)).toBe('第一行\n\n  第二行  ')
    expect(loadDraft()).toBe('第一行\n\n  第二行  ')
  })

  it('再次保存覆盖旧草稿', () => {
    saveDraft('old')
    saveDraft('new')
    expect(loadDraft()).toBe('new')
  })

  it('保存空串等价于清除（不留空键）', () => {
    saveDraft('内容')
    saveDraft('')
    expect(window.localStorage.getItem(KEYS.draft)).toBeNull()
    expect(loadDraft()).toBe('')
  })

  it('clearDraft 幂等且只清草稿键', () => {
    window.localStorage.setItem('bimail.session', '{"user_id":"x"}')
    saveDraft('内容')
    clearDraft()
    clearDraft()
    expect(window.localStorage.getItem(KEYS.draft)).toBeNull()
    expect(window.localStorage.getItem('bimail.session')).toBe('{"user_id":"x"}')
  })

  it('只在本设备 localStorage 存一份，键名固定', () => {
    saveDraft('abc')
    expect(window.localStorage.length).toBe(1)
    expect(Object.values(KEYS)).toContain('bimail.draft')
    expect(DRAFT_SAVE_DELAY_MS).toBe(300)
  })
})
