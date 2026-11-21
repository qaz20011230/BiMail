#!/usr/bin/env node
/**
 * 色彩验收（SPEC §4.1，2026-11-22 品牌配色）：
 * - 与 liang.world 对齐：白纸 + 深灰墨 + 品牌蓝 #0066CC
 * - 正文对比度 ≥12:1，淡语 ≥4.5:1，品牌蓝（链接/焦点/寄出）≥4.5:1
 * - 中性令牌色度 ≤6%，品牌蓝保持单一色相（约 210°）
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
const dark = readBlock(":root[data-theme='dark']")

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
  ['accent', 4.5],
])
auditScheme('暗色', dark, [
  ['ink-mine', 12],
  ['ink-theirs', 12],
  ['ink-faint', 4.5],
  ['accent', 4.5],
])

// 中性令牌保持低饱和（纸/墨/淡语）；品牌蓝是唯一的彩色令牌。
const neutralTokens = ['paper', 'ink-mine', 'ink-theirs', 'ink-faint']
for (const scheme of [light, dark]) {
  for (const name of neutralTokens) {
    const value = scheme[name]
    if (!value) continue
    const percent = chromaPercent(value)
    rows.push(`中性 ${value}: ${percent.toFixed(2)}%（要求 ≤6%）`)
    if (percent > 6) failures.push(`${value} 色度 ${percent.toFixed(2)}% > 6%（中性令牌不应引入彩色）`)
  }
}

for (const [name, scheme, expectedHue] of [
  ['亮色', light, 210],
  ['暗色', dark, 212],
]) {
  const accent = scheme.accent
  if (!accent) {
    failures.push(`${name}: 缺少品牌蓝 --accent`)
    continue
  }
  const percent = chromaPercent(accent)
  const accentHue = hue(accent)
  rows.push(`品牌蓝 ${accent}: 色度 ${percent.toFixed(2)}%，色相 ${accentHue?.toFixed(1)}°（目标 ~${expectedHue}°）`)
  if (percent < 30) failures.push(`${accent} 饱和度偏低，无法承担品牌蓝强调`)
  if (accentHue === null || Math.abs(accentHue - expectedHue) > 10) {
    failures.push(`${accent} 色相 ${accentHue?.toFixed(1)}° 偏离品牌蓝（目标 ~${expectedHue}°）`)
  }
}

const intentionalContrast = [
  ['亮色 我', '#1a1a1a', '#ffffff'],
  ['亮色 笔友', '#333333', '#ffffff'],
  ['亮色 淡语', '#666666', '#ffffff'],
  ['亮色 品牌蓝', '#0066cc', '#ffffff'],
  ['暗色 我', '#f2f2f2', '#101214'],
  ['暗色 笔友', '#d6d6d6', '#101214'],
  ['暗色 淡语', '#a3a9b0', '#101214'],
  ['暗色 品牌蓝', '#66a3ff', '#101214'],
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
console.log('✓ 色彩验收通过：白纸/深灰墨/品牌蓝，对比度与色相一致')
