import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EntryStream from '../../src/components/EntryStream.vue'
import { copy } from '../../src/copy'
import { formatDayLabel, localISODate } from '../../src/lib/date'
import type { Entry, QueuedEntryView, Slot, WallState } from '../../src/types'

const NOW = new Date()
const TODAY = localISODate(NOW)
const YESTERDAY = localISODate(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1))
const PREV_YEAR_DAY = `${NOW.getFullYear() - 1}-12-31`

function entry(seq: number, slot: Slot, writtenOn: string = TODAY, body?: string): Entry {
  return {
    id: `id-${seq}`,
    seq,
    slot,
    body: body ?? `entry ${seq}`,
    written_on: writtenOn,
  }
}

function queued(clientUuid: string, failed: boolean, body = 'queued text'): QueuedEntryView {
  return { client_uuid: clientUuid, body, written_on: TODAY, failed }
}

/** 可控的 IntersectionObserver 替身：测试里手动触发进入/离开视口。 */
class MockIntersectionObserver implements IntersectionObserver {
  static instances: MockIntersectionObserver[] = []

  readonly root: Element | Document | null = null
  readonly rootMargin: string = '0px'
  readonly thresholds: ReadonlyArray<number> = [0]
  readonly observed: Element[] = []
  private readonly callback: IntersectionObserverCallback

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    MockIntersectionObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.observed.push(target)
  }

  unobserve(): void {
    /* noop */
  }

  disconnect(): void {
    /* noop */
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  trigger(isIntersecting: boolean): void {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

function lastObserver(): MockIntersectionObserver {
  const observer = MockIntersectionObserver.instances[MockIntersectionObserver.instances.length - 1]
  if (observer === undefined) throw new Error('IntersectionObserver was not created')
  return observer
}

interface StreamProps {
  entries: Entry[]
  queued: QueuedEntryView[]
  mySlot: Slot
  state: WallState
  derived: string[]
  notices: string[]
  emptyLine: string | null
  inviteUrl: string | null
  hasMore: boolean
  freshSeq?: number
}

function baseProps(): StreamProps {
  return {
    entries: [],
    queued: [],
    mySlot: 'a',
    state: 'open',
    derived: [],
    notices: [],
    emptyLine: null,
    inviteUrl: null,
    hasMore: false,
  }
}

function mountStream(overrides: Partial<StreamProps> = {}) {
  return mount(EntryStream, { props: { ...baseProps(), ...overrides } })
}

beforeEach(() => {
  MockIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('EntryStream：日分组与条目渲染', () => {
  it('空墙渲染空墙行，且没有日分组', () => {
    const wrapper = mountStream({ emptyLine: copy.emptyCreator })

    expect(wrapper.find('[data-testid="empty-line"]').exists()).toBe(true)
    expect(wrapper.find('.empty-line').text()).toBe(copy.emptyCreator)
    expect(wrapper.findAll('.day-group')).toHaveLength(0)
    expect(wrapper.find('[data-testid="settings-entry"]').exists()).toBe(true)
  })

  it('emptyLine 为 null 时不渲染空墙行', () => {
    const wrapper = mountStream()
    expect(wrapper.find('.empty-line').exists()).toBe(false)
  })

  it('游程渲染 .day-group / .day-label，重复日期各自成组且标签重复', () => {
    const entries = [
      entry(1, 'a', YESTERDAY),
      entry(2, 'b', TODAY),
      entry(3, 'a', TODAY),
      entry(4, 'b', YESTERDAY),
    ]
    const wrapper = mountStream({ entries })

    const groups = wrapper.findAll('.day-group')
    expect(groups).toHaveLength(3)
    expect(groups.map((group) => group.find('.day-label').text())).toEqual([
      formatDayLabel(YESTERDAY, NOW),
      formatDayLabel(TODAY, NOW),
      formatDayLabel(YESTERDAY, NOW),
    ])
    expect(groups[1].findAll('[data-testid="entry"]')).toHaveLength(2)
    expect(wrapper.findAll('[data-testid="entry"]')).toHaveLength(4)
  })

  it('跨年日期标签带年份', () => {
    const wrapper = mountStream({ entries: [entry(1, 'a', PREV_YEAR_DAY)] })

    expect(wrapper.find('.day-label').text()).toBe(
      `${NOW.getFullYear() - 1}年12月31日`,
    )
  })

  it('我的与笔友：类名、sr-only 前缀、data-seq / data-slot', () => {
    const wrapper = mountStream({
      entries: [entry(1, 'a', TODAY), entry(2, 'b', TODAY)],
      mySlot: 'a',
    })

    const rows = wrapper.findAll('[data-testid="entry"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].classes()).toContain('entry')
    expect(rows[0].classes()).toContain('entry--mine')
    expect(rows[1].classes()).toContain('entry--theirs')
    expect(rows[0].attributes('data-seq')).toBe('1')
    expect(rows[1].attributes('data-seq')).toBe('2')
    expect(rows[0].attributes('data-slot')).toBe('a')
    expect(rows[1].attributes('data-slot')).toBe('b')
    expect(rows[0].find('.sr-only').text()).toBe(copy.srMine)
    expect(rows[1].find('.sr-only').text()).toBe(copy.srTheirs)
  })

  it('"我的"由座位而非顺序决定', () => {
    const wrapper = mountStream({
      entries: [entry(1, 'a', TODAY), entry(2, 'b', TODAY)],
      mySlot: 'b',
    })

    const rows = wrapper.findAll('[data-testid="entry"]')
    expect(rows[0].classes()).toContain('entry--theirs')
    expect(rows[0].find('.sr-only').text()).toBe(copy.srTheirs)
    expect(rows[1].classes()).toContain('entry--mine')
    expect(rows[1].find('.sr-only').text()).toBe(copy.srMine)
  })

  it('.entry-body 以文本渲染：保留换行、不生成元素、不解析标记', () => {
    const body = 'first line\n<a href="https://example.test">link</a>\n<script>bad()</script>'
    const wrapper = mountStream({ entries: [entry(1, 'a', TODAY, body)] })

    const bodyNode = wrapper.find('.entry-body')
    expect(bodyNode.element.textContent).toBe(body)
    expect(bodyNode.find('a').exists()).toBe(false)
    expect(bodyNode.find('script').exists()).toBe(false)
  })
})

describe('EntryStream：freshSeq（仅新留言 120ms 淡入）', () => {
  const entries = [entry(1, 'a', TODAY), entry(2, 'b', TODAY), entry(3, 'a', TODAY)]

  it('freshSeq 缺省为 0：全部条目带 .entry--new', () => {
    const wrapper = mountStream({ entries })

    const rows = wrapper.findAll('.entry')
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.classes().includes('entry--new'))).toBe(true)
  })

  it('freshSeq = 最新 seq：没有条目带 .entry--new', () => {
    const wrapper = mountStream({ entries, freshSeq: 3 })

    expect(wrapper.findAll('.entry--new')).toHaveLength(0)
  })

  it('仅 seq > freshSeq 的条目带 .entry--new', () => {
    const wrapper = mountStream({ entries, freshSeq: 2 })

    const rows = wrapper.findAll('[data-testid="entry"]')
    expect(rows[0].classes()).not.toContain('entry--new')
    expect(rows[1].classes()).not.toContain('entry--new')
    expect(rows[2].classes()).toContain('entry--new')
  })

  it('排队条目不参与 .entry--new，但按"我的"身份编码对齐', () => {
    const wrapper = mountStream({ queued: [queued('u1', false)], freshSeq: 0 })

    const row = wrapper.find('.entry--queued')
    expect(row.exists()).toBe(true)
    expect(row.classes()).toContain('entry--queued')
    expect(row.classes()).toContain('entry--mine')
    expect(row.classes()).not.toContain('entry--new')
  })
})

describe('EntryStream：派生语 / 邀请行 / 提示行', () => {
  it('派生语逐行渲染为 .derived-line', () => {
    const derived = [copy.seatEstablished('11月12日'), copy.wallClosed]
    const wrapper = mountStream({ derived })

    const lines = wrapper.findAll('.derived-line')
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => line.text())).toEqual(derived)
  })

  it('邀请行是纯文本行，不是链接', () => {
    const inviteUrl = 'https://bimail.example/#i=0123456789abcdef0123456789abcdef'
    const wrapper = mountStream({ inviteUrl })

    const line = wrapper.find('[data-testid="invite-line"]')
    expect(line.exists()).toBe(true)
    expect(line.text()).toBe(inviteUrl)
    expect(line.element.tagName).toBe('P')
    expect(line.classes()).toContain('invite-line')
    expect(wrapper.find('a').exists()).toBe(false)
  })

  it('inviteUrl 为 null 时不渲染邀请行', () => {
    const wrapper = mountStream()
    expect(wrapper.find('.invite-line').exists()).toBe(false)
  })

  it('提示行逐行渲染为 .notice-line', () => {
    const wrapper = mountStream({ notices: [copy.wallClosed, copy.offline] })

    const lines = wrapper.findAll('.notice-line')
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => line.text())).toEqual([copy.wallClosed, copy.offline])
    expect(wrapper.findAll('[data-testid="notice-line"]')).toHaveLength(2)
  })
})

describe('EntryStream：排队区与两步撤回', () => {
  it('渲染排队条目正文；未失败者不出现本地语', () => {
    const wrapper = mountStream({ queued: [queued('u1', false, 'pending body')] })

    const queuedRow = wrapper.find('.entry--queued')
    expect(queuedRow.exists()).toBe(true)
    expect(queuedRow.find('.entry-body').text()).toBe('pending body')
    expect(wrapper.find('[data-testid="queued-line"]').exists()).toBe(false)
    expect(wrapper.find('.local-line').exists()).toBe(false)
  })

  it('失败条目：先展开确认词，再点才 emit retract-queued', async () => {
    const wrapper = mountStream({ queued: [queued('u1', true, 'failed body')] })

    const queuedLine = wrapper.find('[data-testid="queued-line"]')
    expect(queuedLine.exists()).toBe(true)
    expect(queuedLine.element.tagName).toBe('BUTTON')
    expect(queuedLine.classes()).toContain('local-line')
    expect(queuedLine.text()).toBe(copy.queued)

    await queuedLine.trigger('click')

    expect(wrapper.find('[data-testid="queued-line"]').exists()).toBe(false)
    const retractLine = wrapper.find('[data-testid="retract-line"]')
    expect(retractLine.exists()).toBe(true)
    expect(retractLine.element.tagName).toBe('BUTTON')
    expect(retractLine.text()).toBe(copy.retractQueued)
    expect(wrapper.emitted('retract-queued')).toBeUndefined()

    await retractLine.trigger('click')

    expect(wrapper.emitted('retract-queued')).toEqual([['u1']])
  })

  it('多条失败条目各自独立展开确认', async () => {
    const wrapper = mountStream({ queued: [queued('u1', true), queued('u2', true)] })

    expect(wrapper.findAll('[data-testid="queued-line"]')).toHaveLength(2)

    await wrapper.findAll('[data-testid="queued-line"]')[0].trigger('click')

    expect(wrapper.findAll('[data-testid="retract-line"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="queued-line"]')).toHaveLength(1)

    await wrapper.findAll('[data-testid="queued-line"]')[0].trigger('click')

    expect(wrapper.findAll('[data-testid="retract-line"]')).toHaveLength(2)
    expect(wrapper.emitted('retract-queued')).toBeUndefined()
  })

  it('排队条目按输入顺序渲染', () => {
    const wrapper = mountStream({ queued: [queued('u1', false, 'first'), queued('u2', false, 'second')] })

    const bodies = wrapper.findAll('.entry--queued .entry-body').map((node) => node.text())
    expect(bodies).toEqual(['first', 'second'])
  })
})

describe('EntryStream：设置入口与流结构', () => {
  it('流尾设置入口是词形按钮，点击 emit open-settings', async () => {
    const wrapper = mountStream({ entries: [entry(1, 'a', TODAY)] })

    const button = wrapper.find('[data-testid="settings-entry"]')
    expect(button.exists()).toBe(true)
    expect(button.element.tagName).toBe('BUTTON')
    expect(button.classes()).toContain('word')
    expect(button.text()).toBe(copy.words.settings)

    await button.trigger('click')

    expect(wrapper.emitted('open-settings')).toHaveLength(1)
  })

  it('流结构顺序：哨兵 → 派生语 → 邀请行 → 空墙行 → 日分组 → 提示行 → 设置入口', () => {
    const wrapper = mountStream({
      entries: [entry(1, 'a', TODAY)],
      derived: [copy.seatEstablished('11月12日')],
      inviteUrl: 'https://bimail.example/#i=abc',
      emptyLine: copy.emptyCreator,
      notices: [copy.wallClosed],
    })

    const stream = wrapper.find('.stream').element
    expect(stream.getAttribute('data-state')).toBe('open')
    expect(stream.firstElementChild?.className).toContain('stream-sentinel')
    expect(stream.lastElementChild?.className).toContain('settings-entry')

    const classNames = Array.from(stream.children).map((child) => child.className)
    const indexOf = (name: string): number =>
      classNames.findIndex((className) => className.split(' ').includes(name))
    const order = [
      'stream-sentinel',
      'derived-line',
      'invite-line',
      'empty-line',
      'day-group',
      'notice-line',
      'settings-entry',
    ].map((name) => indexOf(name))

    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((left, right) => left - right)).toEqual(order)
  })
})

describe('EntryStream：顶部哨兵与加载更早', () => {
  it('挂载时创建 IntersectionObserver 并观察 .stream-sentinel', () => {
    const wrapper = mountStream({ entries: [entry(1, 'a', TODAY)], hasMore: true })

    const observer = lastObserver()
    expect(observer.observed).toHaveLength(1)
    expect(observer.observed[0]).toBe(wrapper.find('.stream-sentinel').element)
    expect(wrapper.find('.stream-sentinel').classes()).toContain('stream-sentinel')
  })

  it('hasMore 时进入视口只触发一次 load-older', () => {
    const wrapper = mountStream({ hasMore: true })
    const observer = lastObserver()

    observer.trigger(true)
    observer.trigger(true)
    observer.trigger(true)

    expect(wrapper.emitted('load-older')).toHaveLength(1)
  })

  it('hasMore 为 false 时不触发 load-older', () => {
    const wrapper = mountStream({ hasMore: false })
    const observer = lastObserver()

    observer.trigger(true)

    expect(wrapper.emitted('load-older')).toBeUndefined()
  })

  it('hasMore 变化后复位，可再次触发', async () => {
    const wrapper = mountStream({ hasMore: true })
    const observer = lastObserver()

    observer.trigger(true)
    expect(wrapper.emitted('load-older')).toHaveLength(1)

    await wrapper.setProps({ hasMore: false })
    await wrapper.setProps({ hasMore: true })
    observer.trigger(true)

    expect(wrapper.emitted('load-older')).toHaveLength(2)
  })

  it('留言列表变化后复位，可再次触发', async () => {
    const wrapper = mountStream({ entries: [entry(1, 'a', TODAY)], hasMore: true })
    const observer = lastObserver()

    observer.trigger(true)
    expect(wrapper.emitted('load-older')).toHaveLength(1)

    await wrapper.setProps({ entries: [entry(0, 'b', YESTERDAY), entry(1, 'a', TODAY)] })
    observer.trigger(true)

    expect(wrapper.emitted('load-older')).toHaveLength(2)
  })

  it('视口离开不触发；卸载时断开观察', () => {
    const wrapper = mountStream({ hasMore: true })
    const observer = lastObserver()
    const disconnect = vi.spyOn(observer, 'disconnect')

    observer.trigger(false)
    expect(wrapper.emitted('load-older')).toBeUndefined()

    wrapper.unmount()
    expect(disconnect).toHaveBeenCalled()
  })
})
