/**
 * Store 集成行为（Lead）：屏幕状态机、寄出队列、恢复密钥换座、邀请持久化。
 * 用假 Backend 替身驱动，不触网；每个用例重置模块得到干净的 store 单例。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Backend, CommitInput } from '../../src/lib/adapter'
import { BackendError } from '../../src/lib/errors'
import type { Entry, EntryPage, PostedEntry, Session, WallSnapshot } from '../../src/types'

const hoisted = vi.hoisted(() => ({ fake: null as unknown as FakeBackend }))

vi.mock('../../src/lib/backend', () => ({
  createBackend: async () => hoisted.fake,
}))

class FakeBackend implements Backend {
  readonly mode = 'local' as const
  calls: string[] = []
  postedBodies: string[] = []
  failPost = false
  snapshot: WallSnapshot = {
    dyad_id: 'dyad-1',
    state: 'nascent',
    my_slot: 'a',
    seats: [{ slot: 'a', joined_on: '2026-11-12' }],
    invite: { token: 'A'.repeat(32), expires_on: '2026-11-19' },
  }
  entries: Entry[] = []
  nextSeq = 1

  async ensureSession(): Promise<Session> {
    this.calls.push('ensureSession')
    return { user_id: 'user-1', access_token: 'token-1', refresh_token: 'refresh-1' }
  }

  async createWall(recoveryHash: string): Promise<WallSnapshot> {
    this.calls.push(`createWall:${recoveryHash}`)
    return this.snapshot
  }

  async acceptInvite(token: string, recoveryHash: string): Promise<WallSnapshot> {
    this.calls.push(`acceptInvite:${token}:${recoveryHash}`)
    this.snapshot = {
      ...this.snapshot,
      state: 'open',
      my_slot: 'b',
      seats: [...this.snapshot.seats, { slot: 'b', joined_on: '2026-11-13' }],
      invite: null,
    }
    return this.snapshot
  }

  async wallSnapshot(): Promise<WallSnapshot> {
    this.calls.push('wallSnapshot')
    if (this.calls.filter((call) => call === 'wallSnapshot').length === 1) {
      throw new BackendError('no_seat')
    }
    return this.snapshot
  }

  async listEntries(beforeSeq: number | null, limit = 120): Promise<EntryPage> {
    this.calls.push(`listEntries:${beforeSeq ?? 'null'}:${limit}`)
    return { entries: [...this.entries], has_more: false }
  }

  async postEntry(input: CommitInput): Promise<PostedEntry> {
    this.calls.push(`postEntry:${input.client_uuid}`)
    if (this.failPost) throw new BackendError('network')
    const entry: Entry = {
      id: `entry-${this.nextSeq}`,
      seq: this.nextSeq,
      slot: this.snapshot.my_slot,
      body: input.body,
      written_on: input.written_on,
    }
    this.nextSeq += 1
    this.entries.push(entry)
    this.postedBodies.push(input.body)
    return { entry, duplicate: false }
  }

  async rebindSeat(recoveryHash: string): Promise<WallSnapshot> {
    this.calls.push(`rebindSeat:${recoveryHash}`)
    this.snapshot = {
      ...this.snapshot,
      state: 'open',
      my_slot: 'a',
      seats: [
        { slot: 'a', joined_on: '2026-11-12' },
        { slot: 'b', joined_on: '2026-11-13' },
      ],
      invite: null,
    }
    return this.snapshot
  }

  async revokeOtherSessions(): Promise<void> {
    this.calls.push('revokeOtherSessions')
  }

  async closeAndErase(): Promise<void> {
    this.calls.push('closeAndErase')
    this.snapshot = { ...this.snapshot, state: 'closed', invite: null }
    this.entries = this.entries.filter((entry) => entry.slot !== this.snapshot.my_slot)
  }
}

type StoreModule = typeof import('../../src/lib/store')

async function loadStore(): Promise<StoreModule['wall']> {
  vi.resetModules()
  const module = await import('../../src/lib/store')
  return module.wall
}

function validKey(): string {
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
}

/** 首次抵达 → 凭据屏 → 显式「建一堵新墙」→ 恢复密钥屏 → 墙。 */
async function createFirstWall(wall: StoreModule['wall']): Promise<void> {
  await wall.boot()
  if (wall.screen === 'lost') {
    expect(wall.canCreateWall).toBe(true)
    await wall.createNewWall()
  }
  expect(wall.screen).toBe('recovery')
  wall.confirmRecovery()
  await vi.waitFor(() => expect(wall.screen).toBe('wall'))
}

beforeEach(() => {
  hoisted.fake = new FakeBackend()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
})

describe('boot：首次来访流程', () => {
  it('无座位、无邀请、无钥匙 → 凭据屏 → 建一堵新墙 → 恢复密钥屏 → 确认后进入墙', async () => {
    const wall = await loadStore()
    await wall.boot()

    // 首次抵达与"清空设备存储"不可区分：先给凭据屏与建墙入口，不替人建墙（§8.1）
    expect(wall.screen).toBe('lost')
    expect(wall.canCreateWall).toBe(true)
    expect(hoisted.fake.calls.some((call) => call.startsWith('createWall:'))).toBe(false)

    await wall.createNewWall()
    expect(wall.screen).toBe('recovery')
    expect(wall.recoveryKey).toHaveLength(32)
    const createCall = hoisted.fake.calls.find((call) => call.startsWith('createWall:'))
    expect(createCall).toBeDefined()
    // 传给服务端的是 SHA-256 十六进制，明文钥匙不外发
    expect(createCall?.split(':')[1]).toMatch(/^[0-9a-f]{64}$/)
    // 明文钥匙仅在本设备保管
    expect(window.localStorage.getItem('bimail.recovery_key')).toHaveLength(32)
    expect(window.localStorage.getItem('bimail.pending_recovery')).toBe('1')
    // 邀请明文同样只在本设备保管（服务端只有哈希）
    expect(window.localStorage.getItem('bimail.invite')).toContain('"token"')

    wall.confirmRecovery()
    await vi.waitFor(() => expect(wall.screen).toBe('wall'))
    expect(wall.inviteUrl).toContain('#i=' + hoisted.fake.snapshot.invite?.token)
    expect(wall.shortcutHintVisible).toBe(true)
    expect(window.localStorage.getItem('bimail.pending_recovery')).toBeNull()
  })

  it('邀请刷新后仍可从本设备取回邀请链接（wall_state 不回传明文）', async () => {
    const wall = await loadStore()
    await createFirstWall(wall)

    // 模拟服务端 wall_state 的 invite 恒为 null（只存哈希的实现）
    const snapshotWithoutInvite: WallSnapshot = { ...hoisted.fake.snapshot, invite: null }
    hoisted.fake.snapshot = snapshotWithoutInvite
    hoisted.fake.calls = ['wallSnapshot'] // 预置一次，使下一次 wallSnapshot 返回快照而非 no_seat
    const wall2 = await loadStore()
    await wall2.boot()
    expect(wall2.screen).toBe('wall')
    expect(wall2.inviteUrl).toContain('#i=' + 'A'.repeat(32))
  })

  it('带邀请进入：占座 → 恢复密钥屏 → 墙（open，邀请行消失）', async () => {
    window.history.replaceState(null, '', '/#i=' + 'B'.repeat(32))
    const wall = await loadStore()
    await wall.boot()

    expect(wall.screen).toBe('recovery')
    expect(hoisted.fake.calls.some((call) => call.startsWith(`acceptInvite:${'B'.repeat(32)}:`))).toBe(
      true,
    )
    wall.confirmRecovery()
    await vi.waitFor(() => expect(wall.screen).toBe('wall'))
    expect(wall.snapshot?.state).toBe('open')
    expect(wall.inviteUrl).toBeNull()
    // URL fragment 已清除，不留在历史里
    expect(window.location.hash).toBe('')
  })

  it('已有墙的来访：直接进墙并加载留言', async () => {
    hoisted.fake.calls.push('wallSnapshot') // 跳过 no_seat 分支
    hoisted.fake.snapshot = {
      ...hoisted.fake.snapshot,
      state: 'open',
      my_slot: 'a',
      invite: null,
      seats: [
        { slot: 'a', joined_on: '2026-11-12' },
        { slot: 'b', joined_on: '2026-11-13' },
      ],
    }
    hoisted.fake.entries = [
      { id: 'e1', seq: 1, slot: 'a', body: '第一封', written_on: '2026-11-12' },
      { id: 'e2', seq: 2, slot: 'b', body: '回信', written_on: '2026-11-13' },
    ]
    const wall = await loadStore()
    await wall.boot()
    expect(wall.screen).toBe('wall')
    expect(wall.entries).toHaveLength(2)
  })
})

describe('寄出与离线队列（A4：永不丢字）', () => {
  async function enterWall(): Promise<StoreModule['wall']> {
    const wall = await loadStore()
    await createFirstWall(wall)
    hoisted.fake.entries = []
    return wall
  }

  it('寄出失败回落 queued（仅自己可见的本地语），恢复后按序寄出且无重复', async () => {
    const wall = await enterWall()
    hoisted.fake.failPost = true
    for (const body of ['一', '二', '三', '四', '五']) {
      await wall.post(body)
    }
    expect(wall.queue).toHaveLength(5)
    expect(wall.entries).toHaveLength(0)
    expect(wall.failedUuids).toHaveLength(5)

    const module = await import('../../src/lib/store')
    const view = module.queuedViews.value
    expect(view.every((item) => item.failed)).toBe(true)
    const stored = JSON.parse(window.localStorage.getItem('bimail.queue') ?? '[]') as unknown[]
    expect(stored).toHaveLength(5)

    hoisted.fake.failPost = false
    await wall.retryQueue()
    expect(wall.queue).toHaveLength(0)
    expect(wall.failedUuids).toHaveLength(0)
    expect(hoisted.fake.postedBodies).toEqual(['一', '二', '三', '四', '五'])
    expect(wall.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5])
    expect(wall.shortcutHintVisible).toBe(false)
    expect(JSON.parse(window.localStorage.getItem('bimail.queue') ?? '[]')).toEqual([])
    // last_seen 更新到最新 seq（仅本地）
    expect(window.localStorage.getItem('bimail.last_seen_seq')).toBe('5')
  })

  it('未寄出文字可撤回：队列与本地存储同时清除', async () => {
    const wall = await enterWall()
    hoisted.fake.failPost = true
    await wall.post('还没寄出的一段')
    expect(wall.queue).toHaveLength(1)
    await wall.retractQueued(wall.queue[0].client_uuid)
    expect(wall.queue).toHaveLength(0)
    expect(JSON.parse(window.localStorage.getItem('bimail.queue') ?? '[]')).toEqual([])
  })

  it('已寄出的留言没有任何撤回入口（队列为空，entries 只增）', async () => {
    const wall = await enterWall()
    await wall.post('已寄出')
    expect(wall.queue).toHaveLength(0)
    expect(wall.entries).toHaveLength(1)
    expect(wall.entries[0].body).toBe('已寄出')
  })
})

describe('恢复密钥换座（T5 客户端侧）', () => {
  it('本设备钥匙 + 失去座位时自动换回，并保存/读取钥匙', async () => {
    window.localStorage.setItem('bimail.recovery_key', validKey())
    // 第一个 wallSnapshot 抛 no_seat → 走自动 rebind 分支
    const wall = await loadStore()
    await wall.boot()
    expect(wall.screen).toBe('wall')
    expect(hoisted.fake.calls.some((call) => call.startsWith('rebindSeat:'))).toBe(true)
    expect(wall.snapshot?.my_slot).toBe('a')
  })

  it('本设备有旧钥匙但换座失败 → 凭据屏，并给出建墙入口（不再有死路）', async () => {
    window.localStorage.setItem('bimail.recovery_key', validKey())
    hoisted.fake.rebindSeat = async () => {
      throw new BackendError('invalid_hash')
    }
    const wall = await loadStore()
    await wall.boot()
    expect(wall.screen).toBe('lost')
    expect(wall.canCreateWall).toBe(true)
    await wall.createNewWall()
    expect(wall.screen).toBe('recovery')
  })

  it('提交钥匙：成功进入墙；钥匙错误只给一行本地语', async () => {
    const wall = await loadStore()
    // 先建墙拿到恢复屏，再模拟丢失会话进入凭据屏
    await createFirstWall(wall)

    // 让服务端换座失败
    const original = hoisted.fake.rebindSeat.bind(hoisted.fake)
    hoisted.fake.rebindSeat = async () => {
      throw new BackendError('invalid_hash')
    }
    wall.screen = 'lost'
    await wall.submitRecoveryKey(validKey())
    expect(wall.screen).toBe('lost')
    expect(wall.errorLine).toBe('这把钥匙不对。')
    hoisted.fake.rebindSeat = original
  })
})

describe('同步与销毁', () => {
  it('同步到 closed：一行「这堵墙已经停下。」且不重复', async () => {
    hoisted.fake.calls.push('wallSnapshot')
    hoisted.fake.snapshot = { ...hoisted.fake.snapshot, state: 'open', invite: null }
    const wall = await loadStore()
    await wall.boot()
    expect(wall.screen).toBe('wall')

    hoisted.fake.snapshot = { ...hoisted.fake.snapshot, state: 'closed' }
    await wall.sync()
    expect(wall.notices).toContain('这堵墙已经停下。')
    await wall.sync()
    expect(wall.notices.filter((line) => line === '这堵墙已经停下。')).toHaveLength(1)
  })

  it('销毁：删自己的留言、墙置 closed、邀请清除', async () => {
    const wall = await loadStore()
    await createFirstWall(wall)
    hoisted.fake.entries = [
      { id: 'e1', seq: 1, slot: 'a', body: '我的', written_on: '2026-11-12' },
      { id: 'e2', seq: 2, slot: 'b', body: '对方的', written_on: '2026-11-12' },
    ]
    wall.entries = [...hoisted.fake.entries]

    await wall.destroyMyEntries()
    expect(hoisted.fake.calls).toContain('closeAndErase')
    expect(wall.snapshot?.state).toBe('closed')
    expect(wall.entries.map((entry) => entry.body)).toEqual(['对方的'])
    expect(wall.inviteUrl).toBeNull()
  })
})
