#!/usr/bin/env node
/**
 * BiMail local dev backend — zero-dependency Node HTTP server（contract: docs/CONTRACT.md §3）。
 *
 * 只监听 127.0.0.1；不记录请求体 / token / IP / 精确时刻（SPEC §8）。
 * 所有响应带 cache-control: no-store；错误体固定为 { error: BackendErrorCode }。
 */

import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HttpError, Store } from './store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DB = join(HERE, 'data', 'bimail.db')
const BODY_LIMIT_BYTES = 1_000_000

/**
 * 路由表：路径 → { method, auth, handler(store, { body, auth }) }。
 * auth=true 时需要 Bearer access token；anonymous/refresh/health 例外。
 */
const ROUTES = new Map([
  [
    'GET /api/health',
    { method: 'GET', auth: false, handler: () => ({ ok: true }) },
  ],
  [
    'POST /api/auth/anonymous',
    {
      method: 'POST',
      auth: false,
      status: 201,
      handler: (store) => store.createAnonymousSession(),
    },
  ],
  [
    'POST /api/auth/refresh',
    {
      method: 'POST',
      auth: false,
      handler: (store, { body }) => {
        const session = store.refreshSession(body.refresh_token)
        if (!session) throw new HttpError(401, 'invalid_token')
        return session
      },
    },
  ],
  [
    'POST /api/rpc/create_wall',
    {
      method: 'POST',
      auth: true,
      handler: (store, { body, auth }) => {
        const snapshot = store.createWall(auth.userId, body.recovery_hash)
        return { snapshot }
      },
    },
  ],
  [
    'POST /api/rpc/accept_invite',
    {
      method: 'POST',
      auth: true,
      handler: (store, { body, auth }) => {
        const snapshot = store.acceptInvite(auth.userId, body.token, body.recovery_hash)
        return { snapshot }
      },
    },
  ],
  [
    'POST /api/rpc/wall_state',
    {
      method: 'POST',
      auth: true,
      handler: (store, { auth }) => ({ snapshot: store.wallState(auth.userId) }),
    },
  ],
  [
    'POST /api/rpc/list_entries',
    {
      method: 'POST',
      auth: true,
      handler: (store, { body, auth }) =>
        store.listEntries(auth.userId, body.before_seq, body.limit),
    },
  ],
  [
    'POST /api/rpc/post_entry',
    {
      method: 'POST',
      auth: true,
      handler: (store, { body, auth }) => store.postEntry(auth.userId, body),
    },
  ],
  [
    'POST /api/rpc/rebind_seat',
    {
      method: 'POST',
      auth: true,
      handler: (store, { body, auth }) => ({
        snapshot: store.rebindSeat(auth.userId, body.recovery_hash),
      }),
    },
  ],
  [
    'POST /api/rpc/revoke_other_sessions',
    {
      method: 'POST',
      auth: true,
      handler: (store, { auth }) =>
        store.revokeOtherSessions(auth.userId, auth.sessionId),
    },
  ],
  [
    'POST /api/rpc/close_and_erase',
    {
      method: 'POST',
      auth: true,
      handler: (store, { auth }) => store.closeAndErase(auth.userId),
    },
  ],
])

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let received = 0
    let settled = false
    const chunks = []
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    request.on('data', (chunk) => {
      received += chunk.length
      if (received > BODY_LIMIT_BYTES) {
        fail(new HttpError(413, 'http'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new HttpError(400, 'http'))
      }
    })
    request.on('error', fail)
  })
}

function bearerToken(request) {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header.trim())
  return match ? match[1] : null
}

export function createDevServer({ dbFile = ':memory:' } = {}) {
  const store = new Store(dbFile)

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const key = `${request.method ?? 'GET'} ${url.pathname}`
        const route = ROUTES.get(key)

        if (!route) {
          const knownPath = [...ROUTES.keys()].some(
            (routeKey) => routeKey.slice(routeKey.indexOf(' ') + 1) === url.pathname,
          )
          throw new HttpError(knownPath ? 405 : 404, knownPath ? 'http' : 'unknown')
        }
        if (request.method !== route.method) throw new HttpError(405, 'http')

        let auth = null
        if (route.auth) {
          const token = bearerToken(request)
          auth = token ? store.authenticate(token) : null
          if (!auth) throw new HttpError(401, 'unauthorized')
        }

        const body = route.method === 'POST' ? await readJsonBody(request) : {}
        const payload = route.handler(store, { body, auth })
        sendJson(response, route.status ?? 200, payload)
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(response, error.status, { error: error.code })
          return
        }
        // 不记录请求体 / token / IP；只记录一句不含主体内容的一行。
        console.error('[bimail-api] internal error:', error instanceof Error ? error.message : 'unknown')
        sendJson(response, 500, { error: 'unknown' })
      }
    })()
  })

  return {
    server,
    store,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          const address = server.address()
          const actualPort = typeof address === 'object' && address ? address.port : port
          resolve({ port: actualPort, host })
        })
      })
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          try {
            store.close()
          } catch {
            /* 已关闭 */
          }
          resolve()
        })
      })
    },
  }
}

function main() {
  const port = Number.parseInt(process.env.PORT ?? '8787', 10)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error('[bimail-api] invalid PORT')
    process.exit(1)
  }
  const dbFile = process.env.BIMAIL_DB ?? DEFAULT_DB
  const app = createDevServer({ dbFile })

  app
    .listen(port)
    .then(({ port: actualPort }) => {
      console.log(`[bimail-api] listening on http://127.0.0.1:${actualPort}`)
    })
    .catch((error) => {
      console.error('[bimail-api] failed to listen:', error instanceof Error ? error.message : 'unknown')
      try {
        app.store.close()
      } catch {
        /* noop */
      }
      process.exit(1)
    })

  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    setTimeout(() => process.exit(0), 2000).unref()
    void app.close().then(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
