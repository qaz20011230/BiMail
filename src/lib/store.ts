/**
 * 集成中枢：屏幕状态机 + 同步 + 寄出队列 + 恢复密钥流。
 *
 * A3 约束：本模块不产生任何对方可观测信号；轮询/长连接不存在。
 * A4 约束：寄出失败只回落 queued，永不丢字。
 */

import { computed, reactive } from 'vue'
import { copy } from '../copy'
import type {
  Entry,
  QueuedEntry,
  QueuedEntryView,
  Screen,
  WallSnapshot,
} from '../types'
import { ENTRY_PAGE_SIZE, type Backend } from './adapter'
import { createBackend } from './backend'
import { isBackendError, isTransient } from './errors'
import { localISODate } from './date'
import { buildInviteUrl, inviteTokenErrorLine, isPlausibleInviteToken, takeInviteTokenFromUrl } from './invite-url'
import { loadQueue, newClientUuid, saveQueue } from './queue'
import { writeLastSeen } from './read-position'
import {
  generateRecoveryKey,
  isPlausibleRecoveryKey,
  normalizeRecoveryKey,
  readStoredRecoveryKey,
  recoveryHash,
  storeRecoveryKey,
} from './recovery-key'
import { KEYS, readJSON, readString, removeKey, writeJSON, writeString } from './storage'

/** 首屏 120 + 上翻 120 = DOM 上限。更早历史不加载（§3.4）。 */
const MAX_ENTRIES = 240
const MAX_NOTICES = 3

export interface WallStore {
  screen: Screen
  snapshot: WallSnapshot | null
  entries: Entry[]
  queue: QueuedEntry[]
  failedUuids: string[]
  hasMore: boolean
  syncing: boolean
  loadingOlder: boolean
  busy: boolean
  notices: string[]
  recoveryKey: string | null
  errorLine: string | null
  shortcutHintVisible: boolean
  lastSyncAt: number
  inviteUrl: string | null
  /** 凭据失效屏是否给出"建一堵新墙"入口（仅当确知没有可换回的座位时） */
  canCreateWall: boolean

  boot(): Promise<void>
  retryBoot(): Promise<void>
  createNewWall(): Promise<void>
  sync(): Promise<void>
  loadOlder(): Promise<void>
  post(body: string): Promise<void>
  retryQueue(): Promise<void>
  retractQueued(clientUuid: string): Promise<void>
  markSeen(seq: number): void
  notice(text: string): void
  openSettings(): void
  closeSettings(): void
  confirmRecovery(): void
  submitRecoveryKey(key: string): Promise<void>
  destroyMyEntries(): Promise<void>
  revokeOthers(): Promise<void>
  fetchAllEntries(): Promise<Entry[]>
}

let backend: Backend | null = null
let booting = false
let flushing = false
let closedNoticed = false

export const wall = reactive<WallStore>({
  screen: 'boot',
  snapshot: null,
  entries: [],
  queue: [],
  failedUuids: [],
  hasMore: false,
  syncing: false,
  loadingOlder: false,
  busy: false,
  notices: [],
  recoveryKey: null,
  errorLine: null,
  shortcutHintVisible: false,
  lastSyncAt: 0,
  inviteUrl: null,
  canCreateWall: false,

  boot,
  retryBoot,
  createNewWall,
  sync,
  loadOlder,
  post,
  retryQueue,
  retractQueued,
  markSeen,
  notice,
  openSettings,
  closeSettings,
  confirmRecovery,
  submitRecoveryKey,
  destroyMyEntries,
  revokeOthers,
  fetchAllEntries,
})

/** 渲染视图：failed 才显示"尚未寄出"本地语（寄出中的乐观条目看起来与已寄出相同）。 */
export const queuedViews = computed<QueuedEntryView[]>(() =>
  wall.queue.map((item) => ({
    ...item,
    failed: wall.failedUuids.includes(item.client_uuid),
  })),
)

// —— 基础工具 ——

function notice(text: string): void {
  if (!text) return
  wall.notices = [...wall.notices, text].slice(-MAX_NOTICES)
}

function persistQueue(): void {
  saveQueue(
    wall.queue.map(({ client_uuid, body, written_on }) => ({ client_uuid, body, written_on })),
  )
}

interface StoredInvite {
  dyad_id: string
  token: string
  expires_on: string
}

/** 邀请明文只出现在建墙响应里（服务端只存哈希）；本设备保管明文以便刷新后仍可取回链接。 */
function readStoredInvite(): StoredInvite | null {
  const value = readJSON<StoredInvite>(KEYS.invite)
  if (!value || typeof value.token !== 'string' || typeof value.dyad_id !== 'string') return null
  if (typeof value.expires_on !== 'string') return null
  return value
}

function saveStoredInvite(invite: StoredInvite): void {
  writeJSON(KEYS.invite, invite)
}

function clearStoredInvite(): void {
  removeKey(KEYS.invite)
}

/** nascent 创建者的邀请行：优先本次响应，其次本设备的持久副本；过期或非创建者不显示。 */
function resolveInviteUrl(snapshot: WallSnapshot): string | null {
  if (snapshot.state !== 'nascent' || snapshot.my_slot !== 'a') {
    clearStoredInvite()
    return null
  }
  const stored = readStoredInvite()
  const fallback =
    stored !== null && stored.dyad_id === snapshot.dyad_id && stored.expires_on >= localISODate()
      ? stored.token
      : null
  const token = snapshot.invite?.token ?? fallback
  return token === null ? null : buildInviteUrl(token)
}

function markFailed(uuid: string): void {
  if (!wall.failedUuids.includes(uuid)) wall.failedUuids = [...wall.failedUuids, uuid]
}

function markFirstCommit(): void {
  if (readString(KEYS.firstCommit) !== '1') writeString(KEYS.firstCommit, '1')
  wall.shortcutHintVisible = false
}

function addCommitted(entry: Entry): void {
  if (wall.entries.some((item) => item.seq === entry.seq)) return
  const merged = [...wall.entries, entry].sort((a, b) => a.seq - b.seq)
  wall.entries = merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged
}

function handleFatal(error: unknown): void {
  if (isBackendError(error) && error.code === 'network') {
    wall.errorLine = copy.offline
  } else {
    wall.errorLine = copy.unknownError
  }
  wall.screen = 'error'
}

function showInviteError(line: string): void {
  if (wall.snapshot) {
    wall.notice(line)
    wall.screen = 'wall'
  } else {
    wall.errorLine = line
    wall.screen = 'invite-error'
  }
}

function recoveryErrorLine(error: unknown): string {
  if (!isBackendError(error)) return copy.unknownError
  switch (error.code) {
    case 'invalid_hash':
      return copy.recoveryKeyWrong
    case 'throttled':
      return copy.throttled
    case 'wall_closed':
      return copy.wallClosed
    case 'network':
      return copy.offline
    case 'already_seated':
      return copy.alreadyHasWall
    case 'unauthorized':
      return copy.offline
    default:
      return copy.unknownError
  }
}

function inviteErrorLine(error: unknown): string {
  if (!isBackendError(error)) return copy.unknownError
  switch (error.code) {
    case 'invite_expired':
    case 'invite_unknown':
      return copy.inviteExpired
    case 'invite_consumed':
      return copy.wallFull
    case 'already_seated':
      return copy.alreadyHasWall
    case 'network':
      return copy.offline
    case 'invalid_hash':
    case 'invalid_token':
      return copy.inviteTokenInvalid
    default:
      return copy.unknownError
  }
}

// —— 恢复密钥生成（创建者与接受者共用） ——

async function prepareRecoveryKey(): Promise<string> {
  const key = generateRecoveryKey()
  storeRecoveryKey(key)
  writeString(KEYS.pendingRecovery, '1')
  return key
}

function discardRecoveryKeyAttempt(): void {
  removeKey(KEYS.pendingRecovery)
  removeKey(KEYS.recoveryKey)
}

// —— 屏幕流转 ——

async function boot(attempt = 0): Promise<void> {
  if (booting) return
  booting = true
  wall.screen = 'boot'
  wall.errorLine = null
  wall.recoveryKey = null
  closedNoticed = false
  const inviteToken = takeInviteTokenFromUrl()

  try {
    if (!backend) backend = await createBackend()
    const active = backend
    try {
      await active.ensureSession()
    } catch (error) {
      if (isBackendError(error) && error.code === 'unauthorized' && attempt === 0) {
        removeKey(KEYS.session)
        booting = false
        return boot(1)
      }
      handleFatal(error)
      return
    }

    // 恢复未寄出的文字（A4）
    wall.queue = loadQueue()
    wall.failedUuids = wall.queue.map((item) => item.client_uuid)
    persistQueue()

    const pendingRecovery = readString(KEYS.pendingRecovery) === '1'
    const storedKey = readStoredRecoveryKey()

    try {
      const snapshot = await active.wallSnapshot()
      wall.snapshot = snapshot
      if (pendingRecovery) {
        if (storedKey) {
          wall.recoveryKey = storedKey
          wall.screen = 'recovery'
          return
        }
        removeKey(KEYS.pendingRecovery)
      }
      if (inviteToken) {
        await acceptInvite(inviteToken)
      } else {
        await enterWall()
      }
    } catch (error) {
      if (!isBackendError(error)) {
        handleFatal(error)
        return
      }
      switch (error.code) {
        case 'no_seat':
          if (inviteToken) {
            await acceptInvite(inviteToken)
          } else if (storedKey) {
            await tryStoredKeyRebind(storedKey)
          } else {
            // 首次抵达与"清空设备存储"在客户端不可区分：同屏提供"进入钥匙"与"建一堵新墙"。
            wall.canCreateWall = true
            wall.errorLine = null
            wall.screen = 'lost'
          }
          break
        case 'unauthorized':
          if (attempt === 0) {
            removeKey(KEYS.session)
            booting = false
            return boot(1)
          }
          handleFatal(error)
          break
        case 'network':
          wall.errorLine = copy.offline
          wall.screen = 'error'
          break
        default:
          handleFatal(error)
      }
    }
  } finally {
    booting = false
  }
}

async function retryBoot(): Promise<void> {
  backend = null
  wall.snapshot = null
  await boot(0)
}

async function createWall(): Promise<void> {
  if (!backend) return
  const key = await prepareRecoveryKey()
  try {
    const snapshot = await backend.createWall(await recoveryHash(key))
    wall.snapshot = snapshot
    wall.recoveryKey = key
    wall.canCreateWall = false
    if (snapshot.invite) {
      saveStoredInvite({
        dyad_id: snapshot.dyad_id,
        token: snapshot.invite.token,
        expires_on: snapshot.invite.expires_on,
      })
    }
    wall.screen = 'recovery'
  } catch (error) {
    discardRecoveryKeyAttempt()
    if (isBackendError(error) && error.code === 'already_seated') {
      try {
        wall.snapshot = await backend.wallSnapshot()
        await enterWall()
      } catch (inner) {
        handleFatal(inner)
      }
      return
    }
    handleFatal(error)
  }
}

async function acceptInvite(token: string): Promise<void> {
  if (!backend) return
  if (!isPlausibleInviteToken(token)) {
    showInviteError(inviteTokenErrorLine(token))
    return
  }
  const key = await prepareRecoveryKey()
  try {
    const snapshot = await backend.acceptInvite(token, await recoveryHash(key))
    wall.snapshot = snapshot
    wall.recoveryKey = key
    clearStoredInvite()
    wall.screen = 'recovery'
  } catch (error) {
    discardRecoveryKeyAttempt()
    if (isBackendError(error) && error.code === 'already_seated') {
      try {
        wall.snapshot = await backend.wallSnapshot()
        wall.notice(copy.alreadyHasWall)
        await enterWall()
      } catch (inner) {
        handleFatal(inner)
      }
      return
    }
    showInviteError(inviteErrorLine(error))
  }
}

async function tryStoredKeyRebind(storedKey: string): Promise<void> {
  if (!backend) return
  try {
    const snapshot = await backend.rebindSeat(await recoveryHash(storedKey))
    wall.snapshot = snapshot
    await enterWall()
  } catch (error) {
    // 本设备钥匙换不回座位（旧钥匙残留 / 墙已销毁 / 数据库重置）：
    // 当前身份没有座位，凭据屏必须同时给出「建一堵新墙」，否则用户无路可走。
    wall.canCreateWall = true
    wall.screen = 'lost'
    wall.errorLine = isBackendError(error) && error.code === 'invalid_hash' ? null : recoveryErrorLine(error)
  }
}

async function enterWall(): Promise<void> {
  if (!backend || !wall.snapshot) return
  wall.screen = 'wall'
  wall.errorLine = null
  wall.recoveryKey = null
  wall.inviteUrl = resolveInviteUrl(wall.snapshot)
  wall.shortcutHintVisible = readString(KEYS.firstCommit) !== '1'
  if (wall.snapshot.state === 'closed' && !closedNoticed) {
    closedNoticed = true
    wall.notice(copy.wallClosed)
  }
  wall.entries = []
  wall.hasMore = false
  try {
    const page = await backend.listEntries(null)
    wall.entries = page.entries
    wall.hasMore = page.has_more
    wall.lastSyncAt = Date.now()
  } catch {
    /* 无连接即无断线：保留空流，用户下次来访再同步 */
  }
  await retryQueue()
}

async function createNewWall(): Promise<void> {
  if (!wall.canCreateWall) return
  wall.canCreateWall = false
  await createWall()
}

function confirmRecovery(): void {
  removeKey(KEYS.pendingRecovery)
  wall.recoveryKey = null
  if (wall.snapshot) void enterWall()
}

async function submitRecoveryKey(rawKey: string): Promise<void> {
  if (!backend || wall.busy) return
  const key = normalizeRecoveryKey(rawKey)
  if (!isPlausibleRecoveryKey(key)) {
    wall.errorLine = copy.recoveryKeyWrong
    return
  }
  wall.busy = true
  wall.errorLine = null
  try {
    const snapshot = await backend.rebindSeat(await recoveryHash(key))
    wall.snapshot = snapshot
    storeRecoveryKey(key)
    removeKey(KEYS.pendingRecovery)
    wall.canCreateWall = false
    await enterWall()
  } catch (error) {
    wall.errorLine = recoveryErrorLine(error)
  } finally {
    wall.busy = false
  }
}

// —— 同步（A6：只在来访时发生，无轮询/长连接） ——

async function sync(): Promise<void> {
  if (!backend || !wall.snapshot || wall.syncing) return
  wall.syncing = true
  try {
    const snapshot = await backend.wallSnapshot()
    wall.snapshot = snapshot
    wall.inviteUrl = resolveInviteUrl(snapshot)
    if (snapshot.state === 'closed' && !closedNoticed) {
      closedNoticed = true
      wall.notice(copy.wallClosed)
    }
    if (snapshot.state !== 'closed') await retryQueue()
    const page = await backend.listEntries(null)
    mergeLatestPage(page)
    wall.lastSyncAt = Date.now()
  } catch (error) {
    if (isBackendError(error) && error.code === 'no_seat') {
      wall.screen = 'lost'
      wall.errorLine = null
      // 当前身份已无座位：给「建一堵新墙」入口（旧墙仍可输入恢复密钥找回）。
      wall.canCreateWall = true
    }
    /* 网络失败静默：没有断线状态可显示（A3） */
  } finally {
    wall.syncing = false
  }
}

function mergeLatestPage(page: { entries: Entry[]; has_more: boolean }): void {
  if (page.entries.length === 0) {
    if (wall.entries.length === 0) wall.hasMore = false
    return
  }
  const oldestLoaded = wall.entries[0]?.seq ?? null
  const pageOldest = page.entries[0].seq
  const hadOlder = oldestLoaded !== null && oldestLoaded < pageOldest
  const bySeq = new Map<number, Entry>()
  for (const entry of wall.entries) bySeq.set(entry.seq, entry)
  for (const entry of page.entries) bySeq.set(entry.seq, entry)
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  wall.entries = merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged
  if (!hadOlder) wall.hasMore = page.has_more && wall.entries.length < MAX_ENTRIES
}

async function loadOlder(): Promise<void> {
  if (!backend || wall.loadingOlder || !wall.hasMore) return
  if (wall.entries.length >= MAX_ENTRIES) {
    wall.hasMore = false
    return
  }
  const oldest = wall.entries[0]?.seq
  if (oldest === undefined) return
  wall.loadingOlder = true
  try {
    const page = await backend.listEntries(oldest)
    if (page.entries.length > 0) {
      const bySeq = new Map<number, Entry>()
      for (const entry of page.entries) bySeq.set(entry.seq, entry)
      for (const entry of wall.entries) bySeq.set(entry.seq, entry)
      const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
      wall.entries = merged.length > MAX_ENTRIES ? merged.slice(0, MAX_ENTRIES) : merged
    }
    wall.hasMore = page.has_more && wall.entries.length < MAX_ENTRIES
  } catch {
    /* 静默；下次来访重试 */
  } finally {
    wall.loadingOlder = false
  }
}

// —— 寄出与队列（A4：失败只回落 queued） ——

async function post(body: string): Promise<void> {
  if (!backend || !wall.snapshot || wall.snapshot.state === 'closed') return
  const item: QueuedEntry = {
    client_uuid: newClientUuid(),
    body,
    written_on: localISODate(),
  }
  wall.queue = [...wall.queue, item]
  persistQueue()
  await flushQueue()
}

async function retryQueue(): Promise<void> {
  await flushQueue()
}

async function flushQueue(): Promise<void> {
  if (flushing || !backend || !wall.snapshot) return
  if (wall.snapshot.state === 'closed') return
  flushing = true
  try {
    while (wall.queue.length > 0) {
      const item = wall.queue[0]
      try {
        const posted = await backend.postEntry({
          client_uuid: item.client_uuid,
          body: item.body,
          written_on: item.written_on,
        })
        removeQueued(item.client_uuid)
        addCommitted(posted.entry)
        writeLastSeen(posted.entry.seq)
        markFirstCommit()
      } catch (error) {
        // 队列按序推进：队头失败即停止。此刻队列中每一条都尚未寄出，全部标记本地语。
        for (const pending of wall.queue) markFailed(pending.client_uuid)
        if (isBackendError(error) && error.code === 'wall_closed' && wall.snapshot) {
          wall.snapshot = { ...wall.snapshot, state: 'closed', invite: null }
          if (!closedNoticed) {
            closedNoticed = true
            wall.notice(copy.wallClosed)
          }
        }
        if (isBackendError(error) && error.code === 'no_seat') {
          wall.screen = 'lost'
          wall.errorLine = null
        }
        // 保留在队列中（可撤回），顺序不推进，等待下次来访重试
        break
      }
    }
    persistQueue()
  } finally {
    flushing = false
  }
}

function removeQueued(clientUuid: string): void {
  wall.queue = wall.queue.filter((item) => item.client_uuid !== clientUuid)
  wall.failedUuids = wall.failedUuids.filter((uuid) => uuid !== clientUuid)
}

async function retractQueued(clientUuid: string): Promise<void> {
  removeQueued(clientUuid)
  persistQueue()
}

// —— 阅读位置（仅 localStorage，绝不上行） ——

function markSeen(seq: number): void {
  if (Number.isFinite(seq)) writeLastSeen(seq)
}

// —— 设置面动作 ——

function openSettings(): void {
  if (!wall.snapshot) return
  wall.screen = 'settings'
}

function closeSettings(): void {
  if (wall.screen === 'settings') wall.screen = 'wall'
}

async function destroyMyEntries(): Promise<void> {
  if (!backend || !wall.snapshot || wall.busy) return
  const mySlot = wall.snapshot.my_slot
  wall.busy = true
  try {
    await backend.closeAndErase()
    wall.snapshot = { ...wall.snapshot, state: 'closed', invite: null }
    wall.entries = wall.entries.filter((entry) => entry.slot !== mySlot)
    wall.inviteUrl = null
    clearStoredInvite()
    closedNoticed = true
    wall.notice(copy.wallClosed)
    wall.screen = 'wall'
  } catch (error) {
    notice(recoveryErrorLine(error))
  } finally {
    wall.busy = false
  }
}

async function revokeOthers(): Promise<void> {
  if (!backend || wall.busy) return
  wall.busy = true
  try {
    await backend.revokeOtherSessions()
    notice(copy.revoked)
  } catch (error) {
    notice(isTransient(error) ? copy.offline : copy.unknownError)
  } finally {
    wall.busy = false
  }
}

async function fetchAllEntries(): Promise<Entry[]> {
  if (!backend) return [...wall.entries]
  const bySeq = new Map<number, Entry>()
  for (const entry of wall.entries) bySeq.set(entry.seq, entry)
  let before: number | null = null
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const page = await backend.listEntries(before, ENTRY_PAGE_SIZE)
    if (page.entries.length === 0) break
    for (const entry of page.entries) bySeq.set(entry.seq, entry)
    if (!page.has_more) break
    before = page.entries[0].seq
    if (bySeq.size >= 20_000) break
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
