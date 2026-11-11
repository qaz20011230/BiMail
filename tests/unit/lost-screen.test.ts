/**
 * 凭据屏（DoD 19 的 UI 入口）：首访与"清空设备存储"同屏给出「进入钥匙」与「建一堵新墙」。
 * Lead 集成测试：锁定 allowCreate 契约与钥匙归一化后的提交。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import LostKeyScreen from '../../src/components/LostKeyScreen.vue'

const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

describe('LostKeyScreen：凭据失效屏', () => {
  it('默认无建墙入口；空输入时不出现「进入」词（零控件精神）', () => {
    const wrapper = mount(LostKeyScreen)
    expect(wrapper.text()).toContain('需要你的钥匙才能回到这堵墙。')
    expect(wrapper.find('[data-testid="create-wall"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="key-submit"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="key-input"]').exists()).toBe(true)
    expect(wrapper.find('.local-line').exists()).toBe(false)
  })

  it('allowCreate：展示建墙入口与说明行，点击 emit create', async () => {
    const wrapper = mount(LostKeyScreen, { props: { allowCreate: true } })
    expect(wrapper.text()).toContain('还没有墙，就先建一堵。')
    const createWord = wrapper.get('[data-testid="create-wall"]')
    expect(createWord.text()).toBe('建一堵新墙')
    await createWord.trigger('click')
    expect(wrapper.emitted('create')).toHaveLength(1)
  })

  it('输入钥匙后出现「进入」词；提交 emit 规范化后的原始钥匙', async () => {
    const wrapper = mount(LostKeyScreen)
    const input = wrapper.get('[data-testid="key-input"]')
    await input.setValue(KEY.toLowerCase().slice(0, 16) + ' ' + KEY.toLowerCase().slice(16))
    const submit = wrapper.get('[data-testid="key-submit"]')
    await submit.trigger('click')
    const submitted = wrapper.emitted('submit')
    expect(submitted).toHaveLength(1)
    expect(submitted?.[0][0]).toBe(KEY)
  })

  it('非法钥匙：显示一行事实语且不 emit', async () => {
    const wrapper = mount(LostKeyScreen)
    await wrapper.get('[data-testid="key-input"]').setValue('这不是钥匙')
    await wrapper.get('[data-testid="key-submit"]').trigger('click')
    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(wrapper.text()).toContain('这把钥匙不对。')
  })

  it('busy 时输入与词禁用', () => {
    const wrapper = mount(LostKeyScreen, { props: { busy: true } })
    expect(wrapper.get('[data-testid="key-input"]').attributes('disabled')).toBeDefined()
    const wrapperWithCreate = mount(LostKeyScreen, { props: { busy: true, allowCreate: true } })
    expect(wrapperWithCreate.get('[data-testid="create-wall"]').attributes('disabled')).toBeDefined()
  })
})
