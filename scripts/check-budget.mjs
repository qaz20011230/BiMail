#!/usr/bin/env node
/**
 * 性能预算验收（SPEC §5.1 / §9-23）：
 * - 首屏 JS ≤ 55KB gzip
 * - CSS ≤ 6KB gzip
 * - 首屏请求 ≤ 4（index.html + JS + CSS + 可选 favicon；零图片/零 Web Font/零第三方）
 * - 构建产物含严格 CSP；无内联脚本；无第三方请求
 */

import { gzipSync } from 'node:zlib'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const JS_BUDGET = 55 * 1024
const CSS_BUDGET = 6 * 1024
const REQUEST_BUDGET = 4

const failures = []
const rows = []

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('✗ dist/index.html 不存在，请先 npm run build')
  process.exit(1)
}

function walk(dir, results = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, results)
    else results.push(full)
  }
  return results
}

const files = walk(DIST)
const html = readFileSync(join(DIST, 'index.html'), 'utf8')

function gzipSize(file) {
  return gzipSync(readFileSync(file)).length
}

let jsTotal = 0
let cssTotal = 0
for (const file of files) {
  const rel = relative(DIST, file)
  if (!/\.(js|css)$/.test(file)) continue
  const size = gzipSize(file)
  if (file.endsWith('.js')) jsTotal += size
  else cssTotal += size
  rows.push(`${rel}: ${(size / 1024).toFixed(2)}KB gzip`)
}

// 首屏请求：外链 script + stylesheet（favicon 为 data URI，零请求）
const scriptSrcs = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)].map((m) => m[1])
const stylesheetHrefs = [...html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/g)].map(
  (m) => m[1],
)
const requestCount = scriptSrcs.length + stylesheetHrefs.length
rows.push(`首屏请求: ${requestCount}（JS ${scriptSrcs.length} + CSS ${stylesheetHrefs.length}）`)

if (jsTotal > JS_BUDGET) failures.push(`JS ${(jsTotal / 1024).toFixed(1)}KB > 55KB`)
if (cssTotal > CSS_BUDGET) failures.push(`CSS ${(cssTotal / 1024).toFixed(1)}KB > 6KB`)
if (requestCount > REQUEST_BUDGET) failures.push(`首屏请求 ${requestCount} > ${REQUEST_BUDGET}`)

// 零图片 / 零 Web Font / 零第三方
const binaryAssets = files.filter((file) => !/\.(html|js|css|map|txt|svg|json)$/.test(file))
if (binaryAssets.length > 0) {
  failures.push(`构建产物含二进制资源：${binaryAssets.map((file) => relative(DIST, file)).join(', ')}`)
}
const fonts = files.filter((file) => /\.(woff2?|ttf|otf|eot)$/.test(file))
if (fonts.length > 0) failures.push('构建产物含 Web Font')

if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html)) {
  failures.push('dist/index.html 含内联脚本')
}
if (!/http-equiv=["']Content-Security-Policy["']/i.test(html)) {
  failures.push('dist/index.html 缺少 CSP meta')
}
for (const required of ["default-src 'self'", "script-src 'self'", "object-src 'none'"]) {
  if (!html.includes(required)) failures.push(`CSP 缺少 ${required}`)
}

// 请求目标不得跨域（favicon data URI 除外；CSP 里允许 supabase 域名是声明，不是请求）
for (const src of [...scriptSrcs, ...stylesheetHrefs]) {
  if (/^https?:\/\//i.test(src)) failures.push(`首屏请求指向外部：${src}`)
}

const allowedDist = new Set(files.map((file) => relative(DIST, file)))
for (const src of [...scriptSrcs, ...stylesheetHrefs]) {
  const cleaned = src.replace(/^\.\//, '')
  if (!allowedDist.has(cleaned)) failures.push(`index.html 引用了不存在的产物：${src}`)
}

for (const row of rows) console.log(`  ${row}`)
console.log(
  `  合计 JS ${(jsTotal / 1024).toFixed(2)}KB / 预算 55KB；CSS ${(cssTotal / 1024).toFixed(2)}KB / 预算 6KB`,
)

if (failures.length > 0) {
  console.error(`✗ 性能预算验收失败（${failures.length}）`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('✓ 性能预算验收通过：JS/CSS/请求数达标，零图片、零 Web Font、零第三方、CSP 就位')
