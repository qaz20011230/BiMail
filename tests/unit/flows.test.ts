import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LostKeyScreen from '../../src/components/LostKeyScreen.vue'
import RecoveryScreen from '../../src/components/RecoveryScreen.vue'
import SettingsView from '../../src/components/SettingsView.vue'
import { copy } from '../../src/copy'

const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RecoveryScreen', () => {
  it('说明行 + 32 字符等宽钥匙 + 复制/下载词 + 我已保管；复制结果初始不占行', () => {
    const wrapper = mount(RecoveryScreen, { props: { recoveryKey: KEY } })
    expect(wrapper.find('.surface--recovery').exists()).toBe(true)
    expect(wrapper.text()).toContain(copy.recoveryScreen)

    const key = wrapper.get('[data-testid="recovery-key"]')
    expect(key.element.tagName).toBe('CODE')
    expect(key.classes()).toContain('recovery-key')
    expect(key.text()).toBe(KEY)

    const actions = wrapper.get('.recovery-actions')
    expect(actions.findAll('button').map((button) => button.text())).toEqual([
      copy.words.copy,
      copy.words.downloadTxt,
    ])
    expect(wrapper.get('.recovery-confirm').get('[data-testid="recovery-confirm"]').text()).toBe(
      copy.words.saved,
    )
    expect(wrapper.find('.local-line').exists()).toBe(false)
  })

  it('点击复制：写入剪贴板并只显示一行「已复制」本地语', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    const wrapper = mount(RecoveryScreen, { props: { recoveryKey: KEY } })
    await wrapper.get('[data-testid="key-copy"]').trigger('click')
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(KEY))

    const lines = wrapper.findAll('.local-line')
    expect(lines).toHaveLength(1)
    expect(lines[0].text()).toBe(copy.recoveryKeyCopyDone)
  })

  it('点击「下载 .txt」：Blob 内容为钥匙，文件名用契约文案', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recovery-key')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const wrapper = mount(RecoveryScreen, { props: { recoveryKey: KEY } })
    await wrapper.get('[data-testid="key-download"]').trigger('click')

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    await expect(blob.text()).resolves.toBe(KEY)
    expect(click).toHaveBeenCalledTimes(1)
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe(copy.recoveryKeyFileName)
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:recovery-key'))
  })

  it('必须显式确认才 emit confirmed；钥匙永不自动隐藏', async () => {
    vi.useFakeTimers()
    const wrapper = mount(RecoveryScreen, { props: { recoveryKey: KEY } })

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(wrapper.get('[data-testid="recovery-key"]').text()).toBe(KEY)
    expect(wrapper.emitted('confirmed')).toBeUndefined()

    await wrapper.get('[data-testid="recovery-confirm"]').trigger('click')
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(wrapper.get('[data-testid="recovery-key"]').text()).toBe(KEY)
  })
})

describe('LostKeyScreen', () => {
  it('渲染说明行与单行钥匙输入；空态零控件（无「进入」词）', () => {
    const wrapper = mount(LostKeyScreen)
    expect(wrapper.find('.surface--lost').exists()).toBe(true)
    expect(wrapper.text()).toContain(copy.lostCredential)

    const input = wrapper.get('[data-testid="key-input"]')
    expect(input.classes()).toContain('key-input')
    expect(input.attributes('type')).toBe('text')
    expect(input.attributes('autocapitalize')).toBe('characters')
    expect(input.attributes('autocomplete')).toBe('off')
    expect(input.attributes('spellcheck')).toBe('false')
    expect(wrapper.find('[data-testid="key-submit"]').exists()).toBe(false)
    expect(wrapper.find('.local-line').exists()).toBe(false)
  })

  it('输入非空才出现「进入」词', async () => {
    const wrapper = mount(LostKeyScreen)
    const input = wrapper.get('[data-testid="key-input"]')
    await input.setValue('a')
    expect(wrapper.get('[data-testid="key-submit"]').text()).toBe(copy.words.enter)
    expect(wrapper.get('.lost-actions').findAll('button')).toHaveLength(1)
    await input.setValue('')
    expect(wrapper.find('[data-testid="key-submit"]').exists()).toBe(false)
  })

  it('非法钥匙：显示 copy.recoveryKeyWrong 行且不 emit；再次输入即清除', async () => {
    const wrapper = mount(LostKeyScreen)
    const input = wrapper.get('[data-testid="key-input"]')
    await input.setValue('NOT-A-KEY')
    await wrapper.get('[data-testid="key-submit"]').trigger('click')

    expect(wrapper.get('.local-line').text()).toBe(copy.recoveryKeyWrong)
    expect(wrapper.emitted('submit')).toBeUndefined()

    await input.setValue(`${KEY}`)
    expect(wrapper.find('.local-line').exists()).toBe(false)
  })

  it('合法钥匙 emit 规范化后的原始钥匙（大写、去空白与 -），不自行哈希', async () => {
    const wrapper = mount(LostKeyScreen)
    await wrapper.get('[data-testid="key-input"]').setValue(
      ` ${KEY.slice(0, 8)}-${KEY.slice(8, 16)} ${KEY.slice(16, 24)}-${KEY.slice(24)} `.toLowerCase(),
    )
    await wrapper.get('[data-testid="key-submit"]').trigger('click')

    const emitted = wrapper.emitted('submit')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0][0]).toBe(KEY)
    expect(wrapper.find('.local-line').exists()).toBe(false)
  })

  it('Enter 提交；输入法组合中（isComposing / keyCode 229）的回车不提交', async () => {
    const wrapper = mount(LostKeyScreen)
    const input = wrapper.get('[data-testid="key-input"]')
    await input.setValue(KEY.toLowerCase())
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.emitted('submit')?.[0][0]).toBe(KEY)

    // IME：isComposing
    const imeWrapper = mount(LostKeyScreen)
    const imeInput = imeWrapper.get('[data-testid="key-input"]')
    await imeInput.setValue(KEY)
    await imeInput.trigger('keydown', { key: 'Enter', isComposing: true })
    expect(imeWrapper.emitted('submit')).toBeUndefined()

    // IME：keyCode 229（部分浏览器）
    const composingEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(composingEvent, 'keyCode', { value: 229 })
    imeInput.element.dispatchEvent(composingEvent)
    expect(imeWrapper.emitted('submit')).toBeUndefined()
  })

  it('busy 时禁用输入与词，提交无效', async () => {
    const wrapper = mount(LostKeyScreen)
    await wrapper.get('[data-testid="key-input"]').setValue(KEY)

    await wrapper.setProps({ busy: true })
    expect(wrapper.get('[data-testid="key-input"]').attributes('disabled')).toBeDefined()
    const word = wrapper.get('[data-testid="key-submit"]')
    expect(word.attributes('disabled')).toBeDefined()
    await word.trigger('click')
    expect(wrapper.emitted('submit')).toBeUndefined()

    await wrapper.setProps({ busy: false })
    expect(wrapper.get('[data-testid="key-input"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="key-submit"]').trigger('click')
    expect(wrapper.emitted('submit')).toHaveLength(1)
  })

  it('errorLine 属性作为一行本地语呈现（父组件换座失败时）', () => {
    const wrapper = mount(LostKeyScreen, { props: { errorLine: copy.recoveryKeyWrong } })
    const line = wrapper.get('.local-line')
    expect(line.text()).toBe(copy.recoveryKeyWrong)
  })
})

describe('SettingsView', () => {
  it('标题 + 四行固定顺序 + 回到墙；无其他任何控件', () => {
    const wrapper = mount(SettingsView, { props: { recoveryKey: null } })
    expect(wrapper.find('.surface--settings').exists()).toBe(true)
    expect(wrapper.get('.settings-title').text()).toBe(copy.settingsTitle)

    const rows = wrapper.findAll('.settings-row')
    expect(rows.map((row) => row.text())).toEqual([
      copy.settingsRows.viewKey,
      copy.settingsRows.exportAll,
      copy.settingsRows.revokeOthers,
      copy.settingsRows.destroy,
    ])
    expect(rows[0].attributes('data-testid')).toBe('settings-view-key')
    expect(rows[1].attributes('data-testid')).toBe('settings-export')
    expect(rows[2].attributes('data-testid')).toBe('settings-revoke')
    expect(rows[3].attributes('data-testid')).toBe('settings-destroy')
    expect(wrapper.get('[data-testid="settings-close"]').text()).toBe(copy.words.back)

    // 空态：四行 + 回到墙，共 5 个按钮；无输入框、无链接。
    expect(wrapper.findAll('button')).toHaveLength(5)
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.find('a').exists()).toBe(false)

    // 本设备无钥匙副本：如实显示。
    expect(wrapper.text()).toContain(copy.recoveryKeyMissing)
  })

  it('已有钥匙副本时以 .recovery-key 等宽展示，且不显示缺失行', () => {
    const wrapper = mount(SettingsView, { props: { recoveryKey: KEY } })
    expect(wrapper.get('.recovery-key').text()).toBe(KEY)
    expect(wrapper.text()).not.toContain(copy.recoveryKeyMissing)

    // 展示后不再自动隐藏（无计时器）。
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
    expect(wrapper.get('.recovery-key').text()).toBe(KEY)
  })

  it('二次确认前父组件以空串占位：空 .recovery-key，不提前显示缺失行', () => {
    const wrapper = mount(SettingsView, { props: { recoveryKey: '' } })
    expect(wrapper.get('.recovery-key').text()).toBe('')
    expect(wrapper.text()).not.toContain(copy.recoveryKeyMissing)
    expect(wrapper.findAll('button')).toHaveLength(5)
  })

  it('查看钥匙：点击展开内联二次确认；取消不 emit，确认 emit confirm-key，回传后展示', async () => {
    const wrapper = mount(SettingsView, { props: { recoveryKey: null } })

    await wrapper.get('[data-testid="settings-view-key"]').trigger('click')
    expect(wrapper.get('.settings-confirm-line').text()).toBe(copy.keyRevealConfirm)
    expect(wrapper.get('.settings-actions').findAll('button').map((button) => button.text())).toEqual(
      [copy.words.confirm, copy.words.cancel],
    )
    expect(wrapper.findAll('button')).toHaveLength(7)

    await wrapper.get('[data-testid="settings-view-key-cancel"]').trigger('click')
    expect(wrapper.text()).not.toContain(copy.keyRevealConfirm)
    expect(wrapper.emitted('confirm-key')).toBeUndefined()

    await wrapper.get('[data-testid="settings-view-key"]').trigger('click')
    await wrapper.get('[data-testid="settings-view-key-confirm"]').trigger('click')
    expect(wrapper.emitted('confirm-key')).toHaveLength(1)
    expect(wrapper.text()).not.toContain(copy.keyRevealConfirm)

    await wrapper.setProps({ recoveryKey: KEY })
    expect(wrapper.get('.recovery-key').text()).toBe(KEY)
    expect(wrapper.text()).not.toContain(copy.recoveryKeyMissing)
  })

  it('导出行直接 emit export（无二次确认）', async () => {
    const wrapper = mount(SettingsView, { props: { recoveryKey: KEY } })
    await wrapper.get('[data-testid="settings-export"]').trigger('click')
    expect(wrapper.emitted('export')).toHaveLength(1)
    expect(wrapper.emitted('confirm-key')).toBeUndefined()
  })

  it('让其他设备离开：展开 revokeConfirm，确认 emit revoke-others', async () => {
    const wrapper = mount(SettingsView, { props: { recoveryKey: KEY } })
    await wrapper.get('[data-testid="settings-revoke"]').trigger('click')
    expect(wrapper.get('.settings-confirm-line').text()).toBe(copy.revokeConfirm)

    await wrapper.get('[data-testid="settings-revoke-confirm"]').trigger('click')
    expect(wrapper.emitted('revoke-others')).toHaveLength(1)
    expect(wrapper.text()).not.toContain(copy.revokeConfirm)
  })

  it('离开并销毁：展开 destroyConfirm，确认 emit destroy', async () => {
    const wrapper = mount(SettingsView, { props: { recoveryKey: KEY } })
    await wrapper.get('[data-testid="settings-destroy"]').trigger('click')
    expect(wrapper.get('.settings-confirm-line').text()).toBe(copy.destroyConfirm)

    await wrapper.get('[data-testid="settings-destroy-cancel"]').trigger('click')
    expect(wrapper.emitted('destroy')).toBeUndefined()

    await wrapper.get('[data-testid="settings-destroy"]').trigger('click')
    await wrapper.get('[data-testid="settings-destroy-confirm"]').trigger('click')
    expect(wrapper.emitted('destroy')).toHaveLength(1)
  })

  it('同一时间只展开一行二次确认', async () => {
    const wrapper = mount(SettingsView, { props: { recoveryKey: KEY } })
    await wrapper.get('[data-testid="settings-destroy"]').trigger('click')
    expect(wrapper.get('.settings-confirm-line').text()).toBe(copy.destroyConfirm)

    await wrapper.get('[data-testid="settings-revoke"]').trigger('click')
    expect(wrapper.text()).not.toContain(copy.destroyConfirm)
    expect(wrapper.text()).toContain(copy.revokeConfirm)
  })

  it('notices 逐行 .local-line；回到墙 emit close', async () => {
    const wrapper = mount(SettingsView, {
      props: { recoveryKey: KEY, notices: [copy.revoked, copy.exportDone] },
    })
    const lines = wrapper.findAll('.local-line')
    expect(lines.map((line) => line.text())).toEqual([copy.revoked, copy.exportDone])

    await wrapper.get('[data-testid="settings-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
