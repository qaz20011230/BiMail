/**
 * 集成测试工具：起一个真实的 dev server 子进程（PORT=0，临时库），用 HTTP 走契约。
 * 测试自身只占据系统分配的临时端口，不碰 8787/5173（CONTRACT §1）。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SERVER_PATH = join(HERE, '..', '..', 'server', 'dev-server.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function waitForStartup(child) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('dev server 未在 10s 内打印启动行'))
    }, 10_000)
    const onData = (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline).trimEnd()
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(line)
      cleanup()
      if (!match) {
        reject(new Error(`启动行格式不符: ${line}`))
        return
      }
      resolve({ line, port: Number(match[1]) })
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`dev server 提前退出（code ${code}）`))
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    function cleanup() {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    child.stdout.on('data', onData)
    child.on('exit', onExit)
    child.on('error', onError)
  })
}

/**
 * 启动后端。tempFile=true 时使用临时文件库（允许测试进程另开连接做运维级断言）。
 * @returns {Promise<{ baseUrl: string, port: number, dbFile: string, stderr: () => string, stop: () => Promise<void> }>}
 */
export async function startBackend({ tempFile = false } = {}) {
  const tempDir = tempFile ? mkdtempSync(join(tmpdir(), 'bimail-it-')) : null
  const dbFile = tempDir ? join(tempDir, 'bimail.db') : ':memory:'
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: '0', BIMAIL_DB: dbFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 65_536) stderr += String(chunk)
  })

  try {
    const { line, port } = await waitForStartup(child)
    if (!line.startsWith('[bimail-api] listening on http://127.0.0.1:')) {
      throw new Error(`启动行前缀不符: ${line}`)
    }
    const baseUrl = `http://127.0.0.1:${port}`
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/api/health`)
        if (response.ok) break
      } catch {
        /* 等 listen 就绪 */
      }
      await sleep(20)
    }
    let stopped = false
    const stop = async () => {
      if (stopped) return
      stopped = true
      if (child.exitCode !== null) {
        if (tempDir) rmSync(tempDir, { recursive: true, force: true })
        return
      }
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      await Promise.race([exited, sleep(3000)])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    }
    return {
      baseUrl,
      port,
      dbFile,
      stderr: () => stderr,
      exitCode: () => child.exitCode,
      stop,
    }
  } catch (error) {
    child.kill('SIGKILL')
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    throw error
  }
}

/** 极简 HTTP 客户端：返回 { status, json, text, headers }，从不抛业务错。 */
export function createApi(baseUrl) {
  const call = async (method, path, { token, body, rawBody } = {}) => {
    const headers = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: method === 'POST' ? rawBody ?? JSON.stringify(body ?? {}) : undefined,
    })
    const text = await response.text()
    let json = null
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    return { status: response.status, json, text, headers: response.headers }
  }

  return {
    call,
    get: (path, options) => call('GET', path, options),
    post: (path, options) => call('POST', path, options),
    health: () => call('GET', '/api/health'),
    anonymous: () => call('POST', '/api/auth/anonymous', { body: {} }),
    createWall: (token, recoveryHash) =>
      call('POST', '/api/rpc/create_wall', { token, body: { recovery_hash: recoveryHash } }),
    acceptInvite: (token, inviteToken, recoveryHash) =>
      call('POST', '/api/rpc/accept_invite', {
        token,
        body: { token: inviteToken, recovery_hash: recoveryHash },
      }),
    wallState: (token) => call('POST', '/api/rpc/wall_state', { token, body: {} }),
    listEntries: (token, beforeSeq = null, limit) =>
      call('POST', '/api/rpc/list_entries', {
        token,
        body: { before_seq: beforeSeq, ...(limit === undefined ? {} : { limit }) },
      }),
    postEntry: (token, input) => call('POST', '/api/rpc/post_entry', { token, body: input }),
    rebindSeat: (token, recoveryHash) =>
      call('POST', '/api/rpc/rebind_seat', { token, body: { recovery_hash: recoveryHash } }),
    revokeOtherSessions: (token) =>
      call('POST', '/api/rpc/revoke_other_sessions', { token, body: {} }),
    closeAndErase: (token) => call('POST', '/api/rpc/close_and_erase', { token, body: {} }),
  }
}

export { sleep }
