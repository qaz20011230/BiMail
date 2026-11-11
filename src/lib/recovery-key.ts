/**
 * 恢复密钥（SPEC §5.6 / CONTRACT §5.4）。
 *
 * 160 位熵以 Base32 呈现为 32 字符（RFC 4648 字母表，无填充、无分组，便于抄写）。
 * 服务端只接触 `recoveryHash()` 的小写 hex；明文钥匙只在本设备展示与保管。
 * 本模块不触网；除 `copyText` / `downloadText` 外不依赖浏览器交互。
 */

import { KEYS, readString, writeString } from './storage'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const KEY_BYTES = 20
const KEY_CHARS = 32
const KEY_PATTERN = /^[A-Z2-7]{32}$/

/** 20 随机字节 → Base32，恰好 32 字符（160 / 5 = 32，无填充位）。 */
function base32Encode(bytes: Uint8Array): string {
  let output = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += BASE32_ALPHABET[(buffer >>> bits) & 31]
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  }
  return output
}

/** 生成一把新的恢复密钥。熵源必须是 `crypto.getRandomValues`（不可降级为 Math.random）。 */
export function generateRecoveryKey(): string {
  const bytes = new Uint8Array(KEY_BYTES)
  crypto.getRandomValues(bytes)
  return base32Encode(bytes)
}

/** 大写、去空白与 `-`：抄写/粘贴时允许分组与空格。 */
export function normalizeRecoveryKey(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, '')
}

/** normalize 后长度 32 且字符集为 A–Z2–7。 */
export function isPlausibleRecoveryKey(raw: string): boolean {
  const key = normalizeRecoveryKey(raw)
  return key.length === KEY_CHARS && KEY_PATTERN.test(key)
}

/** 任意文本的 SHA-256，小写 hex（64 字符）。 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  let hex = ''
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/** 恢复密钥的哈希：normalize 后 SHA-256，小写 hex（64）。服务端只存这个值。 */
export async function recoveryHash(key: string): Promise<string> {
  return sha256Hex(normalizeRecoveryKey(key))
}

/** 仅本设备保存明文钥匙（设置面可再次展示；服务端无副本）。 */
export function storeRecoveryKey(key: string): void {
  writeString(KEYS.recoveryKey, normalizeRecoveryKey(key))
}

/** 读取本设备的钥匙副本；不存在或不可用时为 null。 */
export function readStoredRecoveryKey(): string | null {
  const raw = readString(KEYS.recoveryKey)
  if (raw === null) return null
  const key = normalizeRecoveryKey(raw)
  return key.length > 0 ? key : null
}

/** 复制文本：Clipboard API 优先，不可用时降级到隐藏 textarea + execCommand。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 权限被拒或接口不可用：走降级路径 */
  }
  return copyViaExecCommand(text)
}

function copyViaExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}

/** 以 Blob 触发纯文本下载；下载启动后撤销 object URL，不留悬挂引用。 */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    // 放到下一轮事件循环再撤销：部分浏览器（Safari）同步撤销会中断下载。
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
