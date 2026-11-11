#!/usr/bin/env node
// Zero-dependency launcher: local API backend + Vite dev server.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const children = []

function run(name, args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env },
  })
  children.push(child)
  child.on('exit', (code, signal) => {
    if (signal !== 'SIGINT' && signal !== 'SIGTERM' && code !== 0) {
      console.error(`[dev-all] ${name} exited with code ${code}`)
    }
    shutdown(code ?? 0)
  })
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

run('api', [join(root, 'server/dev-server.mjs')])
run('web', [join(root, 'node_modules/vite/bin/vite.js')])
