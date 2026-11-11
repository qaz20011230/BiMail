#!/usr/bin/env node
/**
 * 色彩验收（SPEC §4.1）：
 * - 正文对比度 ≥12:1，淡语 ≥4.5:1（亮色/暗色各一套）
 * - 全站色相数 = 1：所有令牌色度为同一暖色相，色度 (max-min)/255 ≤ 6%
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(ROOT, 'src/styles/tokens.css'), 'utf8')

function readBlock(startPattern) {
  const start = css.indexOf(startPattern)
  if (start < 0) throw new Error(`找不到样式块：${startPattern}`)
  const end = css.indexOf('}', start)
  const block = css.slice(start, end)
  const tokens = {}
  for (const match of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[match[1]] = match[2]
  }
  return tokens
}

const light = readBlock(':root {') // 首个 :root
const dark = readBlock('@media (prefers-color-scheme: dark)')

function rgb(hex) {
  const value = hex.replace('#', '')
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16))
}

function luminance([r, g, b]) {
  const channel = (value) => {
    const normalized = value / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(fg, bg) {
  const lightLum = Math.max(luminance(rgb(fg)), luminance(rgb(bg)))
  const darkLum = Math.min(luminance(rgb(fg)), luminance(rgb(bg)))
  return (lightLum + 0.05) / (darkLum + 0.05)
}

function chromaPercent(hex) {
  const channels = rgb(hex)
  return ((Math.max(...channels) - Math.min(...channels)) / 255) * 100
}

function hue(hex) {
  const [r, g, b] = rgb(hex).map((value) => value / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return null
  let value
  if (max === r) value = ((g - b) / delta) % 6
  else if (max === g) value = (b - r) / delta + 2
  else value = (r - g) / delta + 4
  return (value * 60 + 360) % 360
}

const failures = []
const rows = []

function auditScheme(name, tokens, expectations) {
  const paper = tokens.paper
  for (const [token, minimum] of expectations) {
    const value = tokens[token]
    if (!value) {
      failures.push(`${name}: 缺少令牌 --${token}`)
      continue
    }
    const ratio = contrast(value, paper)
    rows.push(`${name} --${token} ${value} on ${paper}: ${ratio.toFixed(2)}:1（要求 ≥${minimum}）`)
    if (ratio < minimum) failures.push(`${name} --${token} 对比度 ${ratio.toFixed(2)} < ${minimum}`)
  }
}

auditScheme('亮色', light, [
  ['ink-mine', 12],
  ['ink-theirs', 12],
  ['ink-faint', 4.5],
])
auditScheme('暗色', dark, [
  ['ink-mine', 12],
  ['ink-theirs', 12],
  ['ink-faint', 4.5],
])

// 色相数 = 1 且低饱和：只审计彩色令牌（纸/墨/淡语），允许 --focus-ring 等派生值缺席。
const colorTokens = new Set()
for (const scheme of [light, dark]) {
  for (const name of ['paper', 'ink-mine', 'ink-theirs', 'ink-faint']) {
    const value = scheme[name]
    if (!value) continue
    colorTokens.add(value)
    const percent = chromaPercent(value)
    rows.push(`色度 ${value}: ${percent.toFixed(2)}%（要求 ≤6%）`)
    if (percent > 6) failures.push(`${value} 色度 ${percent.toFixed(2)}% > 6%（引入强调色）`)
  }
}

const hues = [...colorTokens].map(hue).filter((value) => value !== null)
const hueSpread = Math.max(...hues) - Math.min(...hues)
rows.push(`色相范围: ${Math.min(...hues).toFixed(1)}°–${Math.max(...hues).toFixed(1)}°（要求跨度 ≤10°）`)
if (hueSpread > 10) failures.push(`色相跨度 ${hueSpread.toFixed(1)}° > 10°（全站色相数应为 1）`)

const intentionalContrast = [
  ['亮色 我', '#1a1917', '#f5f3ef'],
  ['亮色 笔友', '#2e2c28', '#f5f3ef'],
  ['亮色 淡语', '#6e6a61', '#f5f3ef'],
  ['暗色 我', '#e8e4dc', '#171614'],
  ['暗色 笔友', '#d8d3c9', '#171614'],
  ['暗色 淡语', '#9a958b', '#171614'],
]

for (const row of rows) console.log(`  ${row}`)
for (const [label, fg, bg] of intentionalContrast) {
  console.log(`  抽查 ${label}: ${contrast(fg, bg).toFixed(2)}:1`)
}

if (failures.length > 0) {
  console.error(`✗ 色彩验收失败（${failures.length}）`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('✓ 色彩验收通过：对比度阈值达标，暖灰单色相，无强调色')
