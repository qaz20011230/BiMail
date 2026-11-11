/** 文案字典防回归（SPEC §7 逐字文案 + §4.3 身份前缀 + §5.7 导出标签）。 */
import { describe, expect, it } from 'vitest'
import { copy, shortcutLabel } from '../../src/copy'

describe('§7 文案字典逐字实现', () => {
  it('空墙（创建者）', () => {
    expect(copy.emptyCreator).toBe('这堵墙只有你。写下第一封，然后把链接交给他/她。')
  })

  it('空墙（接受者）', () => {
    expect(copy.emptyAcceptor).toBe('墙是空的。第一封还在路上。')
  })

  it('首次快捷键告知', () => {
    expect(copy.shortcutHint).toBe('Enter 换行，⌘/Ctrl + Enter 寄出。')
  })

  it('恢复密钥屏', () => {
    expect(copy.recoveryScreen).toBe('这是唯一的钥匙。我们不留副本。丢了它，就丢了这堵墙。')
  })

  it('座位已满 / 邀请过期 / 已属他墙', () => {
    expect(copy.wallFull).toBe('这堵墙已有两位笔友。')
    expect(copy.inviteExpired).toBe('这条链接已经过期。请向他/她再要一条。')
    expect(copy.alreadyHasWall).toBe('你已经有一堵墙了。')
  })

  it('离线排队 / 撤回未寄出 / 超限', () => {
    expect(copy.queued).toBe('尚未寄出，联网后自动寄出。')
    expect(copy.retractQueued).toBe('撤回这段未寄出的文字。')
    expect(copy.overLimit(3)).toBe('已超出 3 字，未纳入。')
  })

  it('凭证失效 / 座位建立 / 销毁确认 / 墙已关闭', () => {
    expect(copy.lostCredential).toBe('需要你的钥匙才能回到这堵墙。')
    expect(copy.seatEstablished('11月12日')).toBe('11月12日，两位笔友到齐。')
    expect(copy.destroyConfirm).toBe('你的文字将被删除，这堵墙会停下。不可恢复。')
    expect(copy.wallClosed).toBe('这堵墙已经停下。')
  })

  it('设置面四行（顺序与文字）', () => {
    expect(copy.settingsRows).toEqual({
      viewKey: '查看恢复密钥',
      exportAll: '导出全部文字',
      revokeOthers: '让其他设备离开',
      destroy: '离开并销毁我的文字',
    })
  })
})

describe('身份与导出标签', () => {
  it('屏幕阅读器前缀为「你：/笔友：」（§4.3）', () => {
    expect(copy.srMine).toBe('你：')
    expect(copy.srTheirs).toBe('笔友：')
  })

  it('导出标签为我：/你：（§5.7）', () => {
    expect(copy.exportMine).toBe('我：')
    expect(copy.exportTheirs).toBe('你：')
  })

  it('导出文件名为 bimail-YYYY-MM-DD.txt', () => {
    expect(copy.exportFileName('2026-11-12')).toBe('bimail-2026-11-12.txt')
  })
})

describe('快捷键标签随平台变化', () => {
  it('mac 显示 ⌘⏎，其他平台显示 Ctrl ⏎', () => {
    expect(shortcutLabel(true)).toBe('⌘⏎')
    expect(shortcutLabel(false)).toBe('Ctrl ⏎')
  })
})
