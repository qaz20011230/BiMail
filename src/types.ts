/** 共享类型：墙、座位、留言、快照。字段名与后端视图/JSON 对齐（snake_case）。 */

export type Slot = 'a' | 'b'

export type WallState = 'nascent' | 'open' | 'closed'

/** 应用层屏幕状态。A5：单一表面；设置面与恢复密钥屏为规格明确允许的变体。 */
export type Screen =
  | 'boot'
  | 'invite-error'
  | 'error'
  | 'recovery'
  | 'wall'
  | 'settings'
  | 'lost'
  | 'closed'
  | 'fatal'

/** 一条已寄出的不可变留言。绝不包含 created_at / client_uuid / 任何过程字段。 */
export interface Entry {
  id: string
  seq: number
  slot: Slot
  body: string
  /** 写作者本地日期，YYYY-MM-DD */
  written_on: string
}

export interface SeatInfo {
  slot: Slot
  /** 座位建立日，YYYY-MM-DD（双方共知的一次性天粒度信息） */
  joined_on: string
}

export interface InviteInfo {
  /** 32 字符 base64url，192 位熵；只出现在 fragment 与 nascent 创建者视图 */
  token: string
  /** 过期日，YYYY-MM-DD */
  expires_on: string
}

export interface WallSnapshot {
  dyad_id: string
  state: WallState
  my_slot: Slot
  seats: SeatInfo[]
  /** 仅 nascent 且我是 a 时非空，其余为 null */
  invite: InviteInfo | null
}

export interface EntryPage {
  entries: Entry[]
  has_more: boolean
}

/** 匿名身份会话。仅存于本设备 localStorage。 */
export interface Session {
  user_id: string
  access_token: string
  refresh_token: string
}

/** 本地队列中的一条未寄出文字。永不上传直到寄出动作发生。 */
export interface QueuedEntry {
  client_uuid: string
  body: string
  /** 写作者本地日期，YYYY-MM-DD */
  written_on: string
}

/** 渲染用视图：failed=true 时其下才出现"尚未寄出"本地语（寄出前失败）。 */
export interface QueuedEntryView extends QueuedEntry {
  failed: boolean
}

export interface PostedEntry {
  entry: Entry
  duplicate: boolean
}
