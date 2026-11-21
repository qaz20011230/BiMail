/** 外观偏好：两档（亮色/暗色），默认跟随系统；选择只保存在本设备。 */
import { KEYS, readString, writeString } from './storage'

export type Theme = 'light' | 'dark'

export function systemTheme(): Theme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function currentTheme(): Theme {
  if (typeof document !== 'undefined') {
    const value = document.documentElement.dataset.theme
    if (value === 'light' || value === 'dark') return value
  }
  const saved = readString(KEYS.theme)
  return saved === 'light' || saved === 'dark' ? saved : systemTheme()
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = theme === 'dark' ? '#101214' : '#ffffff'
}

export function setTheme(theme: Theme): void {
  writeString(KEYS.theme, theme)
  applyTheme(theme)
}
