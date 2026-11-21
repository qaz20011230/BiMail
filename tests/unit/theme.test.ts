import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { applyTheme, currentTheme, setTheme } from '../../src/lib/theme'
import SettingsView from '../../src/components/SettingsView.vue'

describe('外观主题', () => {
  beforeEach(() => {
    window.localStorage.clear()
    delete document.documentElement.dataset.theme
    document.documentElement.style.colorScheme = ''
  })

  it('setTheme 写入本设备并更新根节点/原生 color-scheme', () => {
    setTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(window.localStorage.getItem('bimail.theme')).toBe('dark')

    setTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(window.localStorage.getItem('bimail.theme')).toBe('light')
  })

  it('currentTheme 优先读取已应用的主题', () => {
    applyTheme('dark')
    expect(currentTheme()).toBe('dark')
    applyTheme('light')
    expect(currentTheme()).toBe('light')
  })

  it('设置面「外观」一行可直接切换并持久化', async () => {
    delete document.documentElement.dataset.theme
    const wrapper = mount(SettingsView, { props: { recoveryKey: null } })
    const button = wrapper.get('[data-testid="settings-theme"]')
    const before = button.text()
    expect(before).toMatch(/^外观：/)
    await button.trigger('click')
    const after = button.text()
    expect(after).not.toBe(before)
    expect(['外观：亮色', '外观：暗色']).toContain(after)
    expect(window.localStorage.getItem('bimail.theme')).toBe(
      document.documentElement.dataset.theme,
    )
    wrapper.unmount()
  })
})
