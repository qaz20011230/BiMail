import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Composer from '../../src/components/Composer.vue'
import { copy } from '../../src/copy'
import { codepointLength } from '../../src/lib/input'
import { KEYS } from '../../src/lib/storage'

function mountComposer(props: { showShortcutHint?: boolean } = {}) {
  const wrapper = mount(Composer, { props, attachTo: document.body })
  wrappers.push(wrapper)
  return wrapper
}

type MountedComposer = ReturnType<typeof mountComposer>

const wrappers: Array<{ unmount: () => void }> = []

function inputOf(wrapper: MountedComposer): HTMLTextAreaElement {
  return wrapper.find('[data-testid="composer-input"]').element as HTMLTextAreaElement
}

async function setInput(wrapper: MountedComposer, text: string): Promise<void> {
  const textarea = wrapper.find('[data-testid="composer-input"]')
  ;(textarea.element as HTMLTextAreaElement).value = text
  await textarea.trigger('input')
}

interface KeyOptions {
  ctrl?: boolean
  meta?: boolean
  composing?: boolean
  keyCode?: number
  key?: string
}

function dispatchKey(wrapper: MountedComposer, options: KeyOptions = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: options.key ?? 'Enter',
    ctrlKey: options.ctrl ?? false,
    metaKey: options.meta ?? false,
    bubbles: true,
    cancelable: true,
  })
  if (options.composing) Object.defineProperty(event, 'isComposing', { configurable: true, value: true })
  if (options.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { configurable: true, value: options.keyCode })
  }
  inputOf(wrapper).dispatchEvent(event)
  return event
}

async function pressCtrlEnter(wrapper: MountedComposer): Promise<KeyboardEvent> {
  const event = dispatchKey(wrapper, { ctrl: true })
  await nextTick()
  return event
}

function commitBodies(wrapper: MountedComposer): string[] {
  const events = wrapper.emitted('commit') ?? []
  return events.map((args) => String(args[0]))
}

interface PastePayload {
  plain: string
  html?: string
}

async function paste(
  wrapper: MountedComposer,
  payload: PastePayload,
): Promise<{ event: Event; getData: ReturnType<typeof vi.fn> }> {
  const getData = vi.fn((type: string) => {
    if (type === 'text/plain') return payload.plain
    if (type === 'text/html') return payload.html ?? ''
    return ''
  })
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { configurable: true, value: { getData } })
  inputOf(wrapper).dispatchEvent(event)
  await nextTick()
  return { event, getData }
}

/* —— 受控的浏览器能力：matchMedia / visualViewport / innerHeight / visibilityState —— */

const baseline = {
  matchMedia: Object.getOwnPropertyDescriptor(window, 'matchMedia'),
  visualViewport: Object.getOwnPropertyDescriptor(window, 'visualViewport'),
  innerHeight: Object.getOwnPropertyDescriptor(window, 'innerHeight'),
  visibilityState: Object.getOwnPropertyDescriptor(document, 'visibilityState'),
}

function restoreOwn(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor)
  else delete (target as Record<string, unknown>)[key]
}

function stubMatchMedia(matches: boolean): void {
  const list = {
    matches,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn(() => list),
  })
}

interface FakeViewport {
  height: number
  offsetTop: number
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

function stubVisualViewport(height: number, offsetTop = 0): FakeViewport {
  const viewport: FakeViewport = {
    height,
    offsetTop,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  return viewport
}

function cssInset(): string {
  return document.documentElement.style.getPropertyValue('--bimail-keyboard-inset')
}

afterEach(() => {
  while (wrappers.length > 0) {
    try {
      wrappers.pop()?.unmount()
    } catch {
      /* 已卸载 */
    }
  }
  document.body.innerHTML = ''
  document.documentElement.style.removeProperty('--bimail-keyboard-inset')
  window.localStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  restoreOwn(window, 'matchMedia', baseline.matchMedia)
  restoreOwn(window, 'visualViewport', baseline.visualViewport)
  restoreOwn(window, 'innerHeight', baseline.innerHeight)
  restoreOwn(document, 'visibilityState', baseline.visibilityState)
})

describe('Composer 空态与非空态', () => {
  it('空态零控件：没有寄出词、快捷键标签、超限提示', () => {
    const wrapper = mountComposer()
    expect(wrapper.find('textarea').exists()).toBe(true)
    expect(wrapper.find('.composer-controls').exists()).toBe(false)
    expect(wrapper.find('[data-testid="commit-word"]').exists()).toBe(false)
    expect(wrapper.find('.composer-shortcut').exists()).toBe(false)
    expect(wrapper.find('.composer-overflow').exists()).toBe(false)
    expect(wrapper.find('.composer-hint').exists()).toBe(false)
    expect(inputOf(wrapper).value).toBe('')
  })

  it('非空出现词形「寄出」与快捷键标签', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, '写点什么')
    const controls = wrapper.find('.composer-controls')
    expect(controls.exists()).toBe(true)
    const word = wrapper.find('[data-testid="commit-word"]')
    expect(word.text()).toBe(copy.words.commit)
    expect(word.classes()).toContain('word')
    expect(word.classes()).toContain('composer-word')
    expect(word.attributes('type')).toBe('button')
    const shortcut = wrapper.find('.composer-shortcut')
    expect(shortcut.text()).toMatch(/^(⌘⏎|Ctrl ⏎)$/)
    expect(shortcut.classes()).toContain('faint')
  })

  it('showShortcutHint 时提示显示在输入框上方；输入后隐藏，寄出后重现', async () => {
    const wrapper = mountComposer({ showShortcutHint: true })
    const hint = wrapper.find('.composer-hint')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toBe(copy.shortcutHint)
    await setInput(wrapper, 'x')
    expect(wrapper.find('.composer-hint').exists()).toBe(false)
    await pressCtrlEnter(wrapper)
    expect(wrapper.find('.composer-hint').exists()).toBe(true)
  })

  it('点击词形「寄出」也能寄出', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, '点词寄出')
    await wrapper.find('[data-testid="commit-word"]').trigger('click')
    expect(commitBodies(wrapper)).toEqual(['点词寄出'])
    expect(inputOf(wrapper).value).toBe('')
  })
})

describe('Composer 键盘与 IME 守卫', () => {
  it('Enter 只换行，不寄出', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, '第一行')
    const event = dispatchKey(wrapper)
    expect(event.defaultPrevented).toBe(false)
    expect(commitBodies(wrapper)).toEqual([])
    expect(inputOf(wrapper).value).toBe('第一行')
  })

  it('Ctrl+Enter 寄出并同步清空输入框与本地草稿', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, '你好')
    await wrapper.find('textarea').trigger('blur')
    expect(window.localStorage.getItem(KEYS.draft)).toBe('你好')
    const event = await pressCtrlEnter(wrapper)
    expect(event.defaultPrevented).toBe(true)
    expect(commitBodies(wrapper)).toEqual(['你好'])
    expect(inputOf(wrapper).value).toBe('')
    expect(window.localStorage.getItem(KEYS.draft)).toBeNull()
    expect(wrapper.find('.composer-controls').exists()).toBe(false)
  })

  it('Cmd+Enter 同样寄出', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, 'mac')
    dispatchKey(wrapper, { meta: true })
    await nextTick()
    expect(commitBodies(wrapper)).toEqual(['mac'])
  })

  it('IME 组合中（isComposing）的回车不寄出', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, '候选词')
    dispatchKey(wrapper, { ctrl: true, composing: true })
    await nextTick()
    expect(commitBodies(wrapper)).toEqual([])
    expect(inputOf(wrapper).value).toBe('候选词')
  })

  it('keyCode 229 的回车不寄出', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, '候选词')
    dispatchKey(wrapper, { ctrl: true, keyCode: 229 })
    await nextTick()
    expect(commitBodies(wrapper)).toEqual([])
  })

  it('compositionstart/end 兜底：组合结束后紧跟的回车不寄出', async () => {
    const wrapper = mountComposer()
    vi.useFakeTimers()
    await setInput(wrapper, '候选词')
    const textarea = wrapper.find('textarea')
    await textarea.trigger('compositionstart')
    dispatchKey(wrapper, { ctrl: true })
    await nextTick()
    expect(commitBodies(wrapper)).toEqual([])

    await textarea.trigger('compositionend')
    dispatchKey(wrapper, { ctrl: true })
    await nextTick()
    expect(commitBodies(wrapper)).toEqual([])

    vi.advanceTimersByTime(60)
    dispatchKey(wrapper, { ctrl: true })
    await nextTick()
    expect(commitBodies(wrapper)).toEqual(['候选词'])
  })

  it('连按 Ctrl+Enter 只产生一条：第一下同步清空，第二下天然不重复', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, '只寄一次')
    dispatchKey(wrapper, { ctrl: true })
    expect(inputOf(wrapper).value).toBe('')
    dispatchKey(wrapper, { ctrl: true })
    await nextTick()
    expect(commitBodies(wrapper)).toEqual(['只寄一次'])
  })

  it('空输入按 Ctrl+Enter 静默忽略', async () => {
    const wrapper = mountComposer()
    await pressCtrlEnter(wrapper)
    expect(commitBodies(wrapper)).toEqual([])
  })
})

describe('Composer 归一化与空白', () => {
  it('空白输入静默忽略，无提示也不清空', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, '   \n\t  ')
    await pressCtrlEnter(wrapper)
    expect(commitBodies(wrapper)).toEqual([])
    expect(wrapper.find('.composer-overflow').exists()).toBe(false)
    expect(inputOf(wrapper).value).toBe('   \n\t  ')
  })

  it('寄出前做规格归一化', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, 'a\r\nb\tc\u200B\n\n\nd')
    await pressCtrlEnter(wrapper)
    expect(commitBodies(wrapper)).toEqual(['a\nb  c\n\nd'])
  })
})

describe('Composer 粘贴', () => {
  it('只取 text/plain，富文本被剥离', async () => {
    const wrapper = mountComposer()
    const { event, getData } = await paste(wrapper, { plain: 'hello', html: '<b>hello</b>' })
    expect(event.defaultPrevented).toBe(true)
    expect(getData).toHaveBeenCalledWith('text/plain')
    expect(inputOf(wrapper).value).toBe('hello')
    expect(inputOf(wrapper).value).not.toContain('<b>')
    await pressCtrlEnter(wrapper)
    expect(commitBodies(wrapper)).toEqual(['hello'])
  })

  it('粘贴内容先归一化', async () => {
    const wrapper = mountComposer()
    await paste(wrapper, { plain: 'a\r\n\r\n\r\nb\tc\u200B' })
    expect(inputOf(wrapper).value).toBe('a\n\nb  c')
  })

  it('在选区处插入并恢复光标', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, 'abcdef')
    const element = inputOf(wrapper)
    element.selectionStart = 1
    element.selectionEnd = 4
    await paste(wrapper, { plain: 'X' })
    expect(element.value).toBe('aXef')
    expect(element.selectionStart).toBe(2)
    expect(element.selectionEnd).toBe(2)
  })

  it('空剪贴板不改变输入', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, '原文')
    const { event } = await paste(wrapper, { plain: '' })
    expect(event.defaultPrevented).toBe(true)
    expect(inputOf(wrapper).value).toBe('原文')
  })
})

describe('Composer 8000 码点上限', () => {
  it('恰好 8000 码点可寄出，无超限提示', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, 'x'.repeat(8000))
    expect(wrapper.find('.composer-overflow').exists()).toBe(false)
    await pressCtrlEnter(wrapper)
    expect(commitBodies(wrapper)[0]).toHaveLength(8000)
  })

  it('超出 1 码点：保留可容纳部分并显示 copy.overLimit(1)', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, 'x'.repeat(8001))
    expect(inputOf(wrapper).value).toHaveLength(8000)
    const overflow = wrapper.find('.composer-overflow')
    expect(overflow.exists()).toBe(true)
    expect(overflow.text()).toBe(copy.overLimit(1))
    expect(overflow.classes()).toContain('faint')
  })

  it('删减回上限以内后超限提示消失', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, 'x'.repeat(8001))
    expect(wrapper.find('.composer-overflow').exists()).toBe(true)
    await setInput(wrapper, 'x'.repeat(7999))
    expect(wrapper.find('.composer-overflow').exists()).toBe(false)
  })

  it('astral 字符按码点截断，不切断代理对', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, '😀'.repeat(8001))
    expect(codepointLength(inputOf(wrapper).value)).toBe(8000)
    expect(inputOf(wrapper).value).toBe('😀'.repeat(8000))
    expect(wrapper.find('.composer-overflow').text()).toBe(copy.overLimit(1))
  })

  it('在上限处粘贴：截断、提示，寄出正文仍为 8000 码点', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, 'x'.repeat(7999))
    await paste(wrapper, { plain: '😀😀' })
    expect(codepointLength(inputOf(wrapper).value)).toBe(8000)
    expect(wrapper.find('.composer-overflow').text()).toBe(copy.overLimit(1))
    await pressCtrlEnter(wrapper)
    expect(codepointLength(commitBodies(wrapper)[0])).toBe(8000)
  })
})

describe('Composer 草稿', () => {
  it('输入节流 300ms 才写入草稿', async () => {
    const wrapper = mountComposer()
    vi.useFakeTimers()
    await setInput(wrapper, '草稿内容')
    expect(window.localStorage.getItem(KEYS.draft)).toBeNull()
    vi.advanceTimersByTime(299)
    expect(window.localStorage.getItem(KEYS.draft)).toBeNull()
    vi.advanceTimersByTime(1)
    expect(window.localStorage.getItem(KEYS.draft)).toBe('草稿内容')
  })

  it('持续输入以最后一次为准（节流窗口重排）', async () => {
    const wrapper = mountComposer()
    vi.useFakeTimers()
    await setInput(wrapper, 'a')
    vi.advanceTimersByTime(200)
    await setInput(wrapper, 'ab')
    vi.advanceTimersByTime(200)
    expect(window.localStorage.getItem(KEYS.draft)).toBeNull()
    vi.advanceTimersByTime(100)
    expect(window.localStorage.getItem(KEYS.draft)).toBe('ab')
  })

  it('blur 立即写入草稿', async () => {
    const wrapper = mountComposer()
    vi.useFakeTimers()
    await setInput(wrapper, '失焦立即存')
    await wrapper.find('textarea').trigger('blur')
    expect(window.localStorage.getItem(KEYS.draft)).toBe('失焦立即存')
  })

  it('页面隐藏（visibilitychange hidden）立即写入草稿', async () => {
    const wrapper = mountComposer()
    await setInput(wrapper, '隐藏立即存')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(window.localStorage.getItem(KEYS.draft)).toBe('隐藏立即存')
  })

  it('挂载时恢复草稿', async () => {
    window.localStorage.setItem(KEYS.draft, '上次没写完的话')
    const wrapper = mountComposer()
    await nextTick()
    expect(inputOf(wrapper).value).toBe('上次没写完的话')
    expect(wrapper.find('.composer-controls').exists()).toBe(true)
  })

  it('草稿永不上传：输入、失焦、节流写盘全程无网络请求', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mountComposer()
    vi.useFakeTimers()
    await setInput(wrapper, '本机文字')
    vi.advanceTimersByTime(1000)
    await wrapper.find('textarea').trigger('blur')
    expect(window.localStorage.getItem(KEYS.draft)).toBe('本机文字')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('Composer 焦点与移动端吸底', () => {
  it('桌面端（pointer:fine）自动聚焦', async () => {
    stubMatchMedia(true)
    const wrapper = mountComposer()
    await nextTick()
    expect(document.activeElement).toBe(inputOf(wrapper))
  })

  it('非精确指针（移动端）不自动聚焦', () => {
    stubMatchMedia(false)
    const wrapper = mountComposer()
    expect(document.activeElement).not.toBe(inputOf(wrapper))
  })

  it('expose focus() 聚焦，clear() 清空输入与草稿', async () => {
    stubMatchMedia(false)
    const wrapper = mountComposer()
    const exposed = wrapper.getCurrentComponent().exposed as { focus: () => void; clear: () => void }
    exposed.focus()
    expect(document.activeElement).toBe(inputOf(wrapper))
    await setInput(wrapper, '将被清空')
    exposed.clear()
    await nextTick()
    expect(inputOf(wrapper).value).toBe('')
    expect(window.localStorage.getItem(KEYS.draft)).toBeNull()
    expect(wrapper.find('.composer-controls').exists()).toBe(false)
  })

  it('把 visualViewport 的键盘遮挡高度写入 --bimail-keyboard-inset，失焦归零', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    const viewport = stubVisualViewport(500)
    const wrapper = mountComposer()
    expect(cssInset()).toBe('300px')

    viewport.height = 700
    const resizeCall = viewport.addEventListener.mock.calls.find((call) => call[0] === 'resize')
    expect(resizeCall).toBeDefined()
    ;(resizeCall?.[1] as () => void)()
    expect(cssInset()).toBe('100px')

    await wrapper.find('textarea').trigger('blur')
    expect(cssInset()).toBe('0px')

    wrapper.unmount()
    expect(cssInset()).toBe('0px')
    const removed = viewport.removeEventListener.mock.calls.map((call) => call[0])
    expect(removed).toContain('resize')
    expect(removed).toContain('scroll')
  })
})
