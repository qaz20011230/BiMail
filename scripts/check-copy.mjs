#!/usr/bin/env node
/**
 * 文案与结构禁令扫描（SPEC §0.2 / §7 语气规则 / §6 非目标 / §1 A5/A6）。
 * 通过标准：退出码 0 且无 failure。warnings 不阻塞，但须在验收文档中说明。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const warnings = []

const BANNED_TERMS = [
  '聊天',
  '会话',
  '房间',
  '群',
  '好友',
  '联系人',
  '用户',
  '账号',
  '成员',
  '消息',
  '发送成功',
  '发送',
  '上线',
  '活跃',
  '几点几分',
  '刚刚',
  '送达状态',
  '密码',
  '验证码',
  '系统通知',
  '在线',
  '正在输入',
  '已读',
  '绝对安全',
  '无法窃取',
  '军事级加密',
  '恭喜',
  '成功',
  '立即',
  '您',
]

const STRUCTURE_RULES = [
  { pattern: /\balert\s*\(/, label: 'alert() 弹窗' },
  { pattern: /\bprompt\s*\(/, label: 'prompt() 弹窗' },
  { pattern: /window\.confirm\s*\(/, label: 'window.confirm() 弹窗' },
  { pattern: /setInterval\s*\(/, label: 'setInterval 轮询' },
  { pattern: /new\s+WebSocket\b/, label: 'WebSocket 长连接' },
  { pattern: /new\s+EventSource\b/, label: 'EventSource 长连接' },
  { pattern: /\bsupabase-js\b/, label: 'supabase-js 依赖' },
  { pattern: /\bv-html\b/, label: 'v-html 渲染' },
  { pattern: /\.innerHTML\b/, label: 'innerHTML 渲染' },
  { pattern: /\bNotification\b/, label: 'Notification API（禁止触达）' },
  { pattern: /\btoast\s*\(/i, label: 'Toast' },
  { pattern: /https?:\/\/(?!\*\.supabase\.co)/, label: '硬编码外部 URL' },
]

/** 去掉注释，避免实现说明里的技术词被误判为界面文案。 */
function stripComments(source, kind) {
  let text = source
  if (kind === 'vue') text = text.replace(/<!--[\s\S]*?-->/g, '')
  text = text.replace(/\/\*[\s\S]*?\*\//g, '')
  text = text
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n')
  return text
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

const srcFiles = walk(join(ROOT, 'src')).filter((file) => /\.(ts|vue|css)$/.test(file))

for (const file of srcFiles) {
  const rel = relative(ROOT, file)
  const kind = file.endsWith('.vue') ? 'vue' : 'ts'
  const raw = readFileSync(file, 'utf8')
  const scannable = stripComments(raw, kind)

  for (const term of BANNED_TERMS) {
    if (scannable.includes(term)) {
      failures.push(`${rel}: 出现禁用词「${term}」`)
    }
  }

  for (const rule of STRUCTURE_RULES) {
    if (rule.label === '硬编码外部 URL' && rel.includes('supabase')) continue
    if (rule.pattern.test(scannable)) {
      failures.push(`${rel}: 命中结构禁令「${rule.label}」`)
    }
  }

  if (file.endsWith('.vue') && /<a[\s>]/.test(scannable)) {
    failures.push(`${rel}: 出现内容链接 <a>（不允许可点击链接/预览）`)
  }

  if (!rel.includes('storage.ts') && /local\.?\s*storage/i.test(scannable)) {
    failures.push(`${rel}: 绕过 src/lib/storage.ts 直接使用 localStorage`)
  }

  // 语气规则：文案中不得有感叹号或 emoji。
  if (/[！]/.test(scannable) && (rel === 'src/copy.ts' || file.endsWith('.vue'))) {
    failures.push(`${rel}: 出现感叹号`)
  }
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(scannable)) {
    failures.push(`${rel}: 出现 emoji`)
  }
}

// —— 逐字文案字典（SPEC §7）防回归 ——
const copySource = readFileSync(join(ROOT, 'src/copy.ts'), 'utf8')
const REQUIRED_COPY = [
  '这堵墙只有你。写下第一封，然后把链接交给他/她。',
  '墙是空的。第一封还在路上。',
  'Enter 换行，⌘/Ctrl + Enter 寄出。',
  '这是唯一的钥匙。我们不留副本。丢了它，就丢了这堵墙。',
  '这堵墙已有两位笔友。',
  '这条链接已经过期。请向他/她再要一条。',
  '你已经有一堵墙了。',
  '尚未寄出，联网后自动寄出。',
  '撤回这段未寄出的文字。',
  '已超出 ${excess} 字，未纳入。',
  '需要你的钥匙才能回到这堵墙。',
  '${monthDay}，两位笔友到齐。',
  '你的文字将被删除，这堵墙会停下。不可恢复。',
  '这堵墙已经停下。',
  '查看恢复密钥',
  '导出全部文字',
  '让其他设备离开',
  '离开并销毁我的文字',
]
for (const snippet of REQUIRED_COPY) {
  if (!copySource.includes(snippet)) failures.push(`src/copy.ts: 缺少规格文案「${snippet}」`)
}

// —— index.html：零第三方、零内联脚本、零图片请求 ——
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8')
if (/<script[^>]+src=["']https?:/i.test(indexHtml)) failures.push('index.html: 出现第三方脚本')
if (/fonts\.googleapis|fonts\.gstatic/i.test(indexHtml)) failures.push('index.html: 出现 Web Font')
if (/<img[\s>]/i.test(indexHtml)) failures.push('index.html: 出现图片元素')
if (/<link[^>]+href=["']https?:/i.test(indexHtml)) failures.push('index.html: 出现外部样式/资源')
if (/<script(?![^>]*src=)[^>]*>/i.test(indexHtml)) failures.push('index.html: 出现内联脚本')

// —— 共享文件写作用域抽查：文案不得硬编码在组件里（提醒级） ——
const chineseLiteral = /['"`]([^'"`]*[\u4e00-\u9fff][^'"`]*)['"`]/g
for (const file of srcFiles.filter((f) => f.endsWith('.vue'))) {
  const rel = relative(ROOT, file)
  const raw = readFileSync(file, 'utf8')
  const template = raw.slice(raw.indexOf('<template>') + 10)
  const script = raw.slice(0, raw.indexOf('</script>'))
  const scannableTemplate = stripComments(template, 'vue')
  if (chineseLiteral.test(scannableTemplate)) {
    failures.push(`${rel}: 模板中出现硬编码中文，必须来自 copy.ts`)
  }
  const scriptText = stripComments(script, 'ts')
  const matches = [...scriptText.matchAll(chineseLiteral)].map((match) => match[1])
  const allowed = matches.filter((text) => /^\s*\//.test(text) || text.includes('你：') || text.includes('笔友：'))
  if (allowed.length > 0) {
    warnings.push(`${rel}: 脚本中疑似硬编码中文 ${JSON.stringify(allowed)}`)
  }
}

if (failures.length > 0) {
  console.error(`✗ 文案/结构检查失败（${failures.length}）`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

if (warnings.length > 0) {
  console.warn(`⚠ 提醒（${warnings.length}）`)
  for (const warning of warnings) console.warn(`  - ${warning}`)
}
console.log(`✓ 文案/结构检查通过：${srcFiles.length} 个源文件，禁用词 ${BANNED_TERMS.length} 项，结构禁令 ${STRUCTURE_RULES.length} 项`)
