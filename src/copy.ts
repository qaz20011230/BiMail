/**
 * 全部界面文案的唯一来源。§7 文案字典逐字实现；补充文案（规格未逐字给出）遵循同一语气规则：
 * 陈述句、无感叹号、无 emoji、无"恭喜/成功/立即"、不用敬语"您"、不催促。
 *
 * 禁用词（不得出现在本文件）：聊天、会话、房间、群、好友、联系人、用户、账号、成员、
 * 消息、发送成功、上线、活跃、几点几分、刚刚、系统通知、送达状态、密码、验证码、
 * 在线、正在输入、已读、绝对安全、军事级加密。
 */

export const copy = {
  // —— §7 文案字典（逐字） ——
  emptyCreator: '这堵墙只有你。写下第一封，然后把链接交给他/她。',
  emptyAcceptor: '墙是空的。第一封还在路上。',
  shortcutHint: 'Enter 换行，⌘/Ctrl + Enter 寄出。',
  recoveryScreen: '这是唯一的钥匙。我们不留副本。丢了它，就丢了这堵墙。',
  wallFull: '这堵墙已有两位笔友。',
  inviteExpired: '这条链接已经过期。请向他/她再要一条。',
  alreadyHasWall: '你已经有一堵墙了。',
  queued: '尚未寄出，联网后自动寄出。',
  retractQueued: '撤回这段未寄出的文字。',
  overLimit: (excess: number) => `已超出 ${excess} 字，未纳入。`,
  lostCredential: '需要你的钥匙才能回到这堵墙。',
  // 实现补充（§8.6）：首次抵达与"清空设备存储"无法区分，故同屏给出建墙入口。
  noWallYet: '还没有墙，就先建一堵。',
  // 已 closed 的墙：离开旧墙并建新墙（§8 决策）
  newWallConfirm: '开始新的一堵墙。这堵墙将不再可读。',
  newWallWarnDelete: '你的文字会从这堵墙删除，建议先导出。',
  seatEstablished: (monthDay: string) => `${monthDay}，两位笔友到齐。`,
  destroyConfirm: '你的文字将被删除，这堵墙会停下。不可恢复。',
  wallClosed: '这堵墙已经停下。',

  // —— 操作词（词，非按钮外观） ——
  words: {
    commit: '寄出',
    confirm: '确认',
    cancel: '取消',
    enter: '进入',
    copy: '复制',
    downloadTxt: '下载 .txt',
    saved: '我已保管',
    settings: '设置',
    back: '回到墙',
    retry: '重试',
    createWall: '建一堵新墙',
    newWall: '再建一堵新墙',
  },

  // —— 身份编码（§4.3）：屏幕阅读器前缀 ——
  srMine: '你：',
  srTheirs: '笔友：',

  // —— 恢复密钥屏 ——
  recoveryKeyCopyDone: '已复制。',
  recoveryKeyMissing: '这台设备没有钥匙的副本。',
  recoveryKeyWrong: '这把钥匙不对。',

  // —— 设置面（§3.7 四行） ——
  settingsTitle: '设置',
  settingsRows: {
    viewKey: '查看恢复密钥',
    exportAll: '导出全部文字',
    revokeOthers: '让其他设备离开',
    destroy: '离开并销毁我的文字',
  },
  keyRevealConfirm: '再次确认：现在显示这把钥匙。',

  // —— 设置动作结果（流内一行文字） ——
  exportDone: '已导出全部文字。',
  revokeConfirm: '其他设备将需要重新出示钥匙。',
  revoked: '其他设备已经离开。',

  // —— 失败与边缘 ——
  offline: '暂时连不上，稍后再试。',
  unknownError: '出了点问题，稍后再试。',
  fatal: '这个浏览器缺少必要的加密接口，换一个浏览器再来。',
  throttled: '试得太频繁了，一小时后再试。',

  // —— 邀请 ——
  inviteLinkLine: (url: string) => url,
  inviteTokenInvalid: '这条链接不完整。请向他/她要一条新的。',

  // —— 导出（§5.7 格式） ——
  exportTitle: (fullDate: string) => `BiMail · 导出于 ${fullDate}`,
  exportDay: (label: string) => `—— ${label}`,
  exportMine: '我：',
  exportTheirs: '你：',
  exportFileName: (isoDate: string) => `bimail-${isoDate}.txt`,
  recoveryKeyFileName: 'bimail-recovery-key.txt',
} as const

/** 快捷键提示中的组合键标签随平台变化。 */
export function shortcutLabel(isMac: boolean): string {
  return isMac ? '⌘⏎' : 'Ctrl ⏎'
}
