/** 后端抽象。local（零服务开发后端）与 supabase（生产目标）实现同一契约。 */

import type { EntryPage, PostedEntry, Session, WallSnapshot } from '../types'

export interface CommitInput {
  client_uuid: string
  body: string
  /** 写作者本地日期，YYYY-MM-DD */
  written_on: string
}

export interface Backend {
  readonly mode: 'local' | 'supabase'

  /** 恢复本设备已存会话；没有则建立匿名身份。 */
  ensureSession(): Promise<Session>

  /** 建立墙（座位 a）并生成邀请。已在座则抛 already_seated。 */
  createWall(recoveryHash: string): Promise<WallSnapshot>

  /** 消费邀请占座 b。 */
  acceptInvite(token: string, recoveryHash: string): Promise<WallSnapshot>

  /** 当前墙快照。无座位抛 no_seat。 */
  wallSnapshot(): Promise<WallSnapshot>

  /**
   * 按 seq 升序返回一页留言。beforeSeq=null 取最近一页。
   * 无座位时返回空页（与 RLS 的"零行"一致，而不是报错）。
   */
  listEntries(beforeSeq: number | null, limit?: number): Promise<EntryPage>

  /** 幂等寄出。 */
  postEntry(input: CommitInput): Promise<PostedEntry>

  /** 用钥匙哈希换回座位。 */
  rebindSeat(recoveryHash: string): Promise<WallSnapshot>

  /** 注销本主体除本次以外的全部匿名会话。 */
  revokeOtherSessions(): Promise<void>

  /** 销毁自己的全部留言，墙置 closed。 */
  closeAndErase(): Promise<void>
}

export const ENTRY_PAGE_SIZE = 120
