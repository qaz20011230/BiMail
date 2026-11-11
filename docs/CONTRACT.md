# BiMail MVP — 工程契约（Lead 维护，实现者必须遵守）

> 权威产品定义：`docs/SPEC.md`（v1.0）。本文件只补充**实现接口、文件边界、验收命令**；冲突时以 SPEC 为准，并立刻告知 Lead。

## 1. 运行环境与命令

```bash
# 依赖已安装（node_modules 就绪）。不要运行 npm install；需要新依赖先问 Lead。
npm run dev            # 本地 API（127.0.0.1:8787）+ Vite（127.0.0.1:5173）
npm run typecheck      # vue-tsc --noEmit，必须 0 错误
npm test               # vitest run（tests/unit/**）
npm run test:integration  # node --test tests/integration/（需要 server/dev-server.mjs）
npm run test:sql       # node tests/sql/run.mjs（PGlite 跑 Supabase 迁移）
npm run build          # 类型检查 + 生产构建
npm run check:copy     # 禁用词 / 结构禁令扫描
```

- 工作目录：`/Users/leon/Documents/BiMail`。共享文件系统，所有成员同时可见。
- **不要执行 git 命令**（提交由 Lead 统一完成）。**不要修改** `package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts`、`index.html`、`src/types.ts`、`src/copy.ts`、`src/lib/{errors,storage,date,adapter,local-adapter,backend}.ts`、`src/lib/store.ts`、`src/App.vue`、`src/components/WallScreen.vue`、`src/styles/**`、`scripts/**`、`README.md`、`docs/SPEC.md`、`docs/CONTRACT.md`。
- 只在你的写作用域内写文件。需要改共享接口 → 发消息给 Lead（`send_message` target `lead`），说明原因，不要自己改。
- 并行期间不要占用 5173/8787 端口做长驻服务；测试自起临时端口（PORT=0 或 8788+）。

## 2. 文件所有权（写作用域）

| 负责人 | 写作用域 |
|---|---|
| **backend** | `server/**`、`supabase/**`、`src/lib/supabase.ts`、`tests/integration/**`、`tests/sql/**`、`tests/unit/supabase.test.ts`、`docs/BACKEND.md` |
| **composer** | `src/components/Composer.vue`、`src/lib/input.ts`、`src/lib/draft.ts`、`src/lib/queue.ts`、`tests/unit/{input,draft,queue,composer}.test.ts` |
| **wall** | `src/components/{EntryStream,DayGroup,EntryRow,StreamLine}.vue`、`src/lib/{grouping,read-position}.ts`、`tests/unit/{grouping,read-position,entry-stream}.test.ts` |
| **flows** | `src/components/{RecoveryScreen,LostKeyScreen,SettingsView}.vue`、`src/lib/{recovery-key,export}.ts`、`tests/unit/{recovery-key,export,flows}.test.ts` |
| **Lead** | 其余全部（脚手架、store、App、WallScreen、样式、脚本、文档、集成） |
| **QA（之后加入）** | `docs/ACCEPTANCE.md`、`tests/e2e/**`；不改 `src/**` |

共享只读模块（已就绪，可直接 import）：`src/types.ts`、`src/copy.ts`、`src/lib/{errors,storage,date,adapter,local-adapter,backend}.ts`。

## 3. 后端 HTTP 契约（local 后端，backend 实现 `server/dev-server.mjs`）

所有请求/响应 JSON；除 `/api/auth/*`、`/api/health` 外都需 `Authorization: Bearer <access_token>`。
错误响应：HTTP 4xx/5xx + `{ "error": "<code>" }`，code ∈ `src/lib/errors.ts` 的 `BackendErrorCode`。
**不得记录请求体、token、IP、精确时刻**（A3/§8）。响应头 `cache-control: no-store`。

| 方法与路径 | 请求体 | 成功响应 |
|---|---|---|
| `GET /api/health` | — | `{ "ok": true }` |
| `POST /api/auth/anonymous` | `{}` | `201 { user_id, access_token, refresh_token }` |
| `POST /api/auth/refresh` | `{ refresh_token }` | `{ user_id, access_token, refresh_token }` |
| `POST /api/rpc/create_wall` | `{ recovery_hash }` | `{ snapshot: WallSnapshot }` |
| `POST /api/rpc/accept_invite` | `{ token, recovery_hash }` | `{ snapshot }` |
| `POST /api/rpc/wall_state` | `{}` | `{ snapshot }` |
| `POST /api/rpc/list_entries` | `{ before_seq: number\|null, limit?: number }` | `{ entries: Entry[], has_more: boolean }` |
| `POST /api/rpc/post_entry` | `{ client_uuid, body, written_on }` | `{ entry: Entry, duplicate: boolean }` |
| `POST /api/rpc/rebind_seat` | `{ recovery_hash }` | `{ snapshot }` |
| `POST /api/rpc/revoke_other_sessions` | `{}` | `{}` |
| `POST /api/rpc/close_and_erase` | `{}` | `{}` |

`WallSnapshot` / `Entry` 形状严格按 `src/types.ts`（snake_case；`seq` 为 number）。
`snapshot.invite` 只在 `state==='nascent' && my_slot==='a'` 时非空，含 `{token, expires_on}`。
`seats` 按 slot 升序；nascent 只有 a。

**行为要求**（对应 SPEC §5.3/§5.5）：
- 匿名会话：服务端只存 token 哈希（如 sha256）；`refresh` 轮换 access token。
- `create_wall`：调用者已在座 → 409 `already_seated`；`recovery_hash` 必须 64 位小写 hex，否则 400 `invalid_hash`；创建 dyad(nascent)+seat a+invite（token=24 字节 base64url 32 字符，服务端只存 sha256；7 天后过期）。
- `accept_invite`：调用者已在座 → 409 `already_seated`；token 不存在 → 404 `invite_unknown`；过期 → 410 `invite_expired`；已消费 / 墙非 nascent / 座位已满 → 409 `invite_consumed`。成功在**单事务**内占 b、墙置 open、邀请作废。
- `wall_state`：无座位 → 409 `no_seat`。
- `list_entries`：无座位 → **返回空页** `{entries:[],has_more:false}`（等价 RLS 零行，不报错）；有座但墙 closed 仍可读；`limit` 默认/上限 120；`before_seq=null` 取最近一页，返回**升序**；`has_more` 表示还有更早的；不得返回 `created_at`/`client_uuid`。
- `post_entry`：先查 `(dyad_id, client_uuid)` 命中则直接返回已存在记录 + `duplicate:true`（即使墙已 closed）；无座位 → 409 `no_seat`；墙 closed → 409 `wall_closed`；`client_uuid` 非法 UUID → 400 `invalid_uuid`；`body` 修剪后空或码点 >8000 → 400 `invalid_body`；`written_on` 非法或不在服务端 UTC 日期 ±2 天内 → 取服务端日期；成功后 `seq` 严格单调递增（全库 identity 语义）；同一 client_uuid 并发两次只落一行。
- `rebind_seat`：调用者已在座 → 409 `already_seated`；hash 格式错或无匹配 → 400 `invalid_hash`；墙 closed → 409 `wall_closed`；**不改变 slot / joined_on**，只换 `user_id`；旧匿名会话之后 `list_entries` 零行、`wall_state` 报 `no_seat`；限流：同一调用者 1 小时 5 次，超出 429 `throttled`（限流按调用者记录，失败与成功都计）。
  > Supabase/SQL 实现的例外：`rebind_seat` 业务错误以 **HTTP 200 + `{"error":"<code>"}`** 返回（其余 7 个 RPC 仍用 `raise exception '<code>'`）。原因：PostgreSQL raise 会回滚事务，连提前写入的限流计数也回滚，导致「失败也计入限流」无法实现。客户端（`src/lib/supabase.ts`）对 200 响应里的 `error` 与 4xx 的 `message` 都做同一错误码映射。
- `close_and_erase`：无座位 → 409 `no_seat`；硬删除**自己 slot** 的全部 entry、dyad 置 closed、删除 invite；**不释放座位**、不删对方 entry；重复调用幂等成功。
- `revoke_other_sessions`：删除该 user 除当前 access token 外的全部会话；幂等。

**数据层**（SQLite，`node:sqlite`）：`users / sessions / dyad / seat / entry / invite / rebind_attempt`。外键：`seat.user_id → users(id) ON DELETE RESTRICT`（A4 的数据库级保护）；`entry` 对 `dyad`、`seat(dyad_id,slot)` 外键；`unique(seat.user_id)`；`unique(entry.dyad_id, entry.client_uuid)`；`dyad.state CHECK`；`entry.slot CHECK`。启动时 `PRAGMA foreign_keys=ON`。
`PORT`（默认 8787，支持 `0`）、`BIMAIL_DB`（默认 `server/data/bimail.db`，支持 `:memory:`）。
启动后 stdout 必须打印一行：`[bimail-api] listening on http://127.0.0.1:<实际端口>`；收到 SIGTERM/SIGINT 优雅退出。集成测试会解析这一行。

## 4. Supabase 生产实现（backend 实现）

### 4.1 SQL 迁移 `supabase/migrations/`
按 SPEC §5.2/§5.3 实现 `dyad / seat / entry / v_entry / v_seat / my_dyad()`，并补齐规格必要的：
- `invite(dyad_id pk references dyad, token_hash bytea unique, expires_on date, consumed_at timestamptz)`
- 视图：`v_entry(id,seq,slot,body,written_on)`、`v_seat(slot,joined_on)`（`security_invoker = true`；**不得含 created_at/client_uuid/dyad_id**）
- RLS：`entry` 只读策略 `dyad_id = my_dyad()`；`seat` 只读策略 `dyad_id = my_dyad()`；无 insert/update/delete 策略；`revoke all ... from anon, authenticated`，仅 `grant select on v_entry, v_seat`、`grant execute on 白名单函数`。
- `security definer` RPC（函数内 `set search_path = public, pg_temp`）：`create_wall(recovery_hash bytea)`, `accept_invite(token text, recovery_hash bytea)`, `wall_state()`, `list_entries(before_seq bigint, page_limit int)`, `post_entry(client_uuid uuid, body text, written_on date)`, `rebind_seat(recovery_hash bytea)`, `revoke_other_sessions()`, `close_and_erase()`。返回 JSON 形状与 §3 完全一致；业务错误用 `raise exception '<code>'`（消息即错误码，客户端据此映射）。
- 恢复哈希：`sha256(convert_to(lower(hex), 'UTF8'))` 由客户端计算并传入（bytea，64 hex）；`rebind_seat` 直接比对存储哈希，**服务端不接触明文钥匙**。
- `seat.user_id uuid references auth.users(id) on delete restrict`（A4）。匿名清理被外键阻止。
- `rebind` 限流表 + 每小时 5 次。
- 邀请：`token_hash = sha256(token)`，7 天，单次消费。
- `close_and_erase`：`delete from entry where dyad_id=my_dyad() and slot=my_slot()`（唯一删除例外），`update dyad set state='closed'`，删除 invite。
- 迁移文件用 `supabase/migrations/0001_init.sql`（可拆多个，按文件名排序）。所有 `create` 写成幂等友好（`if not exists` 或单次迁移由工具保证；测试会按序执行）。

**已在实现中确认的 PostgreSQL 语义偏离（经 Lead 裁定，测试锁定）**：
1. `security_invoker` 视图会以调用者身份检查底层表权限，因此 `authenticated` 除视图 SELECT 外，还需 `entry(id,seq,slot,body,written_on)` 与 `seat(slot,joined_on)` 的**列级** SELECT；`created_at`/`client_uuid` 在基表层面不可读，表级 `has_table_privilege(...,'SELECT')` 仍为 false（SPEC §5.2 表级断言成立）。
2. `rebind_seat` 用 200 + `{"error":"<code>"}` 返回业务错误（原因见 §3 注），以便限流计数在失败时也能提交。

### 4.2 `src/lib/supabase.ts`（替换占位实现）
手写 fetch 客户端，**不引入 supabase-js**，≤~200 行：
- 匿名登录：`POST {url}/auth/v1/signup`，headers `{apikey, Authorization: Bearer <anonKey>}`，body `{}` → 存 `session` 到 `KEYS.session`（形状同 `Session`，user_id 取 `user.id`）。
- `ensureSession()`：有存储会话则检查 JWT `exp`（base64url 解析），过期前 60s 用 `POST {url}/auth/v1/token?grant_type=refresh_token` 刷新；否则匿名登录。
- RPC：`POST {url}/rest/v1/rpc/<name>`，headers `{apikey, Authorization: Bearer <access>, content-type}`；4xx 的 `body.message` 若命中错误码则抛对应 `BackendError`；401 刷新一次后重试。
- `listEntries`：**直接读视图** `GET {url}/rest/v1/v_entry?select=id,seq,slot,body,written_on&order=seq.desc&limit=<n+1>[&seq=lt.<before>]`，反转成升序，`has_more` = 取到 n+1 条。不得查询基表、不得 select `*`。
- `revokeOtherSessions`：`POST {url}/auth/v1/logout?scope=others`（Bearer access）。
- 错误码映射：`network`（fetch 抛错）、`unauthorized`、其余按消息。

### 4.3 `docs/BACKEND.md`
写清：Supabase 项目创建、开启 Anonymous sign-in、迁移执行方式（SQL Editor 或 supabase CLI）、环境变量、GitHub Pages 部署、CSP 需放行的域名、残余风险与"不承诺端到端加密"的表述。中文，语气符合 SPEC 文案规则。

### 4.4 测试
- `tests/integration/*.mjs`（`node --test`）：起临时后端（`PORT=0`, `BIMAIL_DB=:memory:` 或临时文件，解析启动行拿端口），覆盖：双人完整生命周期；邀请单次消费；T1 第三方 `list_entries` 零行 / `post_entry` 拒绝；T4 二次消费失败；T5 恢复钥匙换座成功、旧 token 零行；T6 跨墙占座被拒；幂等（同 client_uuid 并发/重放）；`written_on` ±2 日钳制；body 8000 码点边界与 `invalid_body`；响应字段集不含 `created_at`/`client_uuid`；`revoke_other_sessions` 后旧 token 失效；`close_and_erase` 后对方仍可读、墙不可写、座位不释放。
- `tests/sql/run.mjs`：PGlite（`@electric-sql/pglite`）内存库 → mock `auth` schema（`auth.users(id uuid pk)`、`auth.uid()` 读 `current_setting('request.jwt.claims', true)` 的 `sub`）→ 创建角色 `anon/authenticated` → 执行迁移 → 用 `set role authenticated; set request.jwt.claims='{"sub":"..."}'` 跑断言：T1 零行、T2 视图字段集、T3 `has_table_privilege` 假、T4 二次消费失败、T5 rebind 后旧 uid 零行、T6 unique 冲突、T7 `delete from auth.users` 被 FK 阻止、`created_at` 不在视图、entry 不可 update/delete、幂等、日期钳制。**若 PGlite 对 role/RLS 有限制**：改用等价断言（如 `set row_security = on` + 非 superuser role；不可行则如实记录并在报告中说明哪条降级为静态审计）。
- `tests/unit/supabase.test.ts`：mock `fetch`，断言匿名登录/刷新/RPC/视图查询的 URL、header、错误映射；断言 listEntries 不请求基表且字段白名单。

## 5. 前端组件契约

### 5.1 通用
- Vue 3 `<script setup lang="ts">`，`strict` 通过。所有用户可见文字**必须来自 `src/copy.ts`**（不得在模板/脚本里硬编码中文文案；class 名、data 属性除外）。
- 渲染用户内容一律 `{{ }}`（textContent 语义），禁止 `v-html`、`innerHTML`、动态 `<a>`。
- 无弹窗/Toast：状态一律是流中一行文字（用 `StreamLine` 或组件内一行）。
- 触摸目标：词形控件最小高度 44px（`.word` 由 Lead 的 CSS 保证，布局按契约 class）。
- 键盘可达：可交互元素用 `<button type="button">` / `<input>` / `<textarea>`；`:focus-visible` 描边由全局 CSS 提供。
- data-testid 必须实现（§5.6），供 QA 断言。

### 5.2 Composer（composer）
```ts
// props
{ showShortcutHint?: boolean }            // 首次成功寄出前 true
// emits
(e: 'commit', body: string): void
// expose
{ focus(): void, clear(): void }
```
- 空态（`value.length === 0`）：**零控件**——不渲染寄出词/快捷键/计数。
- 非空：右下出现 `.composer-controls`，含 `<button class="word" data-testid="commit-word">寄出</button>` 与 `.composer-shortcut`（`⌘⏎` mac / `Ctrl ⏎` 其他，来自 `shortcutLabel(isMac)`）。
- `Enter` 换行；`Ctrl/Cmd+Enter` 寄出；`keydown` 里 `event.isComposing || event.keyCode === 229` 直接返回（IME 守卫，P0）。另用 compositionstart/end 兜底。
- 寄出动作顺序：取 `body = normalize(value)` → `trim` 空则静默忽略 → 超过 8000 码点截断并显示 `.composer-overflow`（`copy.overLimit(n)`）→ **同步清空 textarea 与本地草稿** → `emit('commit', body)`。因此连按第二下时输入框已空，不会重复。
- 归一化（`src/lib/input.ts`）：`\r\n?`→`\n`；连续 ≥3 个 `\n` 折叠为 2；`\t`→2 空格；删除 U+200B–U+200D、U+FEFF；按 Unicode 码点计长。粘贴：`paste` 事件 `preventDefault`，只取 `text/plain`，归一化+截断后插入并触发 input 处理（富文本被剥离）。`input` 事件里也做一次截断（防 IME 绕过）。
- 草稿（`src/lib/draft.ts`）：`loadDraft()/saveDraft(body)`，输入节流 300ms 写 `KEYS.draft`；`blur`/`visibilitychange hidden` 立即写；寄出后清空。不得上传。
- 自增高：`min-height:48px`，`max-height:40vh`，`overflow-y:auto`；输入时按 `scrollHeight` 设 height。
- 移动端：监听 `visualViewport` 的 resize/scroll，把 `window.innerHeight - visualViewport.height - visualViewport.offsetTop` 写入 `document.documentElement.style.setProperty('--bimail-keyboard-inset', '<px>')`；失焦/隐藏时归零。挂载时仅 `matchMedia('(pointer:fine)').matches` 才自动 focus。
- 快捷键提示 `.composer-hint`（`copy.shortcutHint`）仅在 `showShortcutHint && value.length===0` 时显示在输入框上方。
- 超限提示 `.composer-overflow` 一行淡字，位于输入框下方。
- `src/lib/queue.ts`：队列纯函数（localStorage 持久化，不触网）：`loadQueue(): QueuedEntry[]`、`saveQueue(q)`、`enqueue(q, entry)`、`removeQueued(q, client_uuid)`、`newClientUuid(): string`（crypto.randomUUID，降级手写 v4）、`sortQueue`。不做网络请求（寄出由 Lead 的 store 负责）。

### 5.3 流与日分组（wall）
```ts
// EntryStream.vue props
{
  entries: Entry[]                 // committed，升序
  queued: QueuedEntryView[]        // 本地未寄出，升序（仅失败者显示本地语）
  mySlot: Slot
  state: WallState
  derived: string[]                // 居中派生语（如座位建立）
  notices: string[]                // 流尾本地语（错误/状态，仅自己可见）
  emptyLine: string | null         // 空墙文案
  inviteUrl: string | null         // nascent 创建者：邀请链接纯文本行
  hasMore: boolean
}
// emits
(e: 'load-older'): void
(e: 'open-settings'): void
(e: 'retract-queued', clientUuid: string): void
```
- 结构：`.stream`（滚动由 WallScreen 控制，EntryStream 只渲染）→ 顶部 `.stream-sentinel`（IntersectionObserver：`hasMore` 且进入视口 emit `load-older`，去抖/仅一次）→ 派生语 `.derived-line` → 邀请行 `.invite-line`（纯文本，可选中，不是 `<a>`）→ 空墙行 → 日分组 `.day-group`（`.day-label` + 若干 `.entry`）→ 排队区 → 通知行 `.notice-line` → 设置入口 `.settings-entry`（`<button class="word">设置</button>`，emit open-settings）。
- `.entry` 带 `data-testid="entry"`、`:data-seq`、`:data-slot`；我/笔友用 `.entry--mine` / `.entry--theirs`；正文 `.entry-body`（`white-space: pre-wrap; overflow-wrap: anywhere`）；每条内含视觉隐藏前缀 `<span class="sr-only">{{ mine ? '你：' : '笔友：' }}</span>`。
- 排队：`.entry.entry--queued` 无 sr 前缀也可；失败者在下方渲染 `.local-line` 按钮（`data-testid="queued-line"`，文字 `copy.queued`）；点击把该行替换为 `.local-line` 按钮（`data-testid="retract-line"`，文字 `copy.retractQueued`）；再点 emit `retract-queued`。未失败（寄出中）不渲染本地语。
- 日分组 `src/lib/grouping.ts`：`groupByDay(entries, now): Array<{writtenOn,label,entries}>`，**游程分组**（相邻同 `written_on` 归一组，不排序去重、不跨组聚合；labels 可重复），label 用 `formatDayLabel`。`derivedLines(snapshot, now?): string[]`：open 时返回 `[copy.seatEstablished(formatMonthDay(b.joined_on))]`，其余空数组。空墙文案由 Lead 传入。
- `src/lib/read-position.ts`：`readLastSeen(): number|null`、`writeLastSeen(seq)`、`resolveAnchorSeq(entries, lastSeen): number|null`（lastSeen 为 null → null；否则取 seq ≤ lastSeen 的最后一条；若全都更新则取最旧一条）。

### 5.4 恢复密钥屏 / 凭据失效屏 / 设置面（flows）

`src/lib/recovery-key.ts`：
```ts
generateRecoveryKey(): string            // 20 随机字节 → Base32 32 字符（无填充、无分组）
normalizeRecoveryKey(raw: string): string // 大写、去空白与 -
isPlausibleRecoveryKey(raw: string): boolean // normalize 后长度 32 且字符集合法
recoveryHash(key: string): Promise<string>   // normalize 后 SHA-256，小写 hex（64）
sha256Hex(text: string): Promise<string>
storeRecoveryKey(key: string): void      // KEYS.recoveryKey（仅本设备）
readStoredRecoveryKey(): string | null
copyText(text: string): Promise<boolean> // clipboard 失败时降级 execCommand
downloadText(filename: string, text: string): void // Blob + a[download]，之后 revokeObjectURL
```
`src/lib/export.ts`：
```ts
formatExport(entries: Entry[], mySlot: Slot, now?: Date): string
// 首行 copy.exportTitle(formatFullDate(localISODate(now)))
// 游程分组（可复用 lib/grouping 的 groupByDay；该模块由 wall 交付，接口见 §5.3）
// 每组："\n—— <label>\n" + 每条的 "我：<body>" / "你：<body>"，条目之间一个换行
exportFilename(now?: Date): string       // copy.exportFileName(localISODate(now))
```

`RecoveryScreen.vue`：props `{ recoveryKey: string }`；emits `{ (e:'confirmed'): void }`。
- `.surface.surface--recovery`：正文行 `copy.recoveryScreen`；`<code class="recovery-key" data-testid="recovery-key">` 等宽展示 32 字符；词形控件 `复制`（`data-testid="key-copy"`）与 `下载 .txt`（`data-testid="key-download"`，文件名 `copy.recoveryKeyFileName`）；复制结果只占一行 `.local-line`（`copy.recoveryKeyCopyDone`）；确认词 `copy.words.saved`（`data-testid="recovery-confirm"`，emit confirmed）。**不得自动隐藏钥匙**。

`LostKeyScreen.vue`：props `{ busy?: boolean, errorLine?: string | null, allowCreate?: boolean }`；emits `{ (e:'submit', key: string): void; (e:'create'): void }`。
- `.surface.surface--lost`：居中行 `copy.lostCredential`；`allowCreate` 时另起一行 `copy.noWallYet` 与词 `建一堵新墙`（`data-testid="create-wall"`，emit `create`）；`<input class="key-input" data-testid="key-input" autocapitalize="characters" autocomplete="off" spellcheck="false">`；非空时出现词 `进入`（`data-testid="key-submit"`）。Enter 提交（输入法组合中不提交）。提交前 `normalize` + `isPlausible`，不合法显示 `copy.recoveryKeyWrong` 行且不 emit；合法则 emit **规范化后的原始钥匙字符串**（父组件负责 `recoveryHash` 并存入本设备）。`busy` 时禁用输入与词。

`SettingsView.vue`：props `{ recoveryKey: string | null, notices?: string[] }`；emits `{ (e:'close'):void; (e:'confirm-key'):void; (e:'export'):void; (e:'revoke-others'):void; (e:'destroy'):void }`。
- `.surface.surface--settings`：标题 `copy.settingsTitle`；四行（顺序固定）：
  1. `copy.settingsRows.viewKey`（`data-testid="settings-view-key"`）：点击后展开一行 `copy.keyRevealConfirm` + 词 `确认`/`取消`；确认后 emit `confirm-key`，父组件传回 `recoveryKey` 后以 `.recovery-key` 展示（**不再自动隐藏**）；`recoveryKey===null` 显示 `copy.recoveryKeyMissing`。
  2. `copy.settingsRows.exportAll`（`data-testid="settings-export"`）→ emit export。
  3. `copy.settingsRows.revokeOthers`（`data-testid="settings-revoke"`）：展开 `copy.revokeConfirm` + 确认/取消 → emit revoke-others。
  4. `copy.settingsRows.destroy`（`data-testid="settings-destroy"`）：展开 `copy.destroyConfirm` + 确认/取消 → emit destroy。
- `notices` 逐行 `.local-line`；底部词 `copy.words.back`（`data-testid="settings-close"`）emit close。无其他任何控件。

## 6. 样式契约（Lead 的 CSS 保证以下类名存在）

全局类：`.word`（词形控件：无边框无背景、同 13px、淡色、min-height 44px、`cursor:pointer`、`:focus-visible` 描边）、`.faint`、`.sr-only`、`.surface`、`.surface--recovery|--lost|--settings`、`.local-line`、`.notice-line`、`.derived-line`、`.invite-line`、`.recovery-key`、`.key-input`、`.settings-row`、`.settings-group`、`.day-group`、`.day-label`、`.entry`、`.entry--mine`、`.entry--theirs`、`.entry--queued`、`.entry-body`、`.stream`、`.stream-sentinel`、`.settings-entry`、`.composer-dock`、`.composer`、`.composer-input`、`.composer-controls`、`.composer-shortcut`、`.composer-hint`、`.composer-overflow`。
组件只用这些类 + 少量 BEM 修饰；新增类先告知 Lead。

## 7. 文案与约束（违反即验收失败）

- 所有用户可见文字来自 `src/copy.ts`；不要新增中文硬编码。需要新文案 → 消息 Lead，在 `copy.ts` 增加。
- 禁用词见 SPEC §0.2/§7 与 `scripts/check-copy.mjs`（`npm run check:copy` 必须通过）。不使用感叹号、emoji、"成功/恭喜/立即"、敬语"您"。
- 禁止：弹窗（`alert/confirm/prompt`）、Toast、`<a>` 内容链接、`v-html`/`innerHTML`、`setInterval` 轮询、WebSocket/EventSource、第三方脚本/字体/图片、`supabase-js`、路由库。
- 禁止任何过程信号：在线/正在输入/已读/送达/同步中提示；草稿永不上传；`created_at`/`client_uuid`/`last_seen` 永不上行。
- 不主动触达：无推送/邮件/角标。

## 8. MVP 决策记录（SPEC 未逐字规定处，Lead 裁定）

1. **创建者流**：首次访问无邀请、无本设备钥匙 → **凭据屏**（`copy.lostCredential` + 钥匙输入 + `copy.noWallYet` + 词「建一堵新墙」）。点「建一堵新墙」→ 建墙（座位 a）→ 恢复密钥屏 → 墙。`allowCreate` 只在"确实无从判断是否存在旧墙"时为真（全新匿名身份且本设备无钥匙）；一旦本设备持有钥匙或已知有墙，该入口关闭。nascent 期间邀请链接以纯文本行显示在流顶（`.invite-line`，仅创建者可见；不新增复制按钮，浏览器选中/长按即可）。b 占座后该行消失。
2. **派生语位置**：座位建立行渲染在流顶（open 状态，一次）。a 在 nascent 期间写的留言按原 `seq`/日期顺序呈现（封缄的信，零新增机制）。
3. **`closed`**：双方仍看到墙与各自可读文字；创建者销毁后自己已无留言；顶部/流尾一行 `copy.wallClosed`，无输入框、无邀请；设置面仍可进入（查看钥匙/导出/注销其他会话）。
4. **导出标签**：自己的留言 `我：`，笔友的 `你：`；日期游程同屏。
5. **恢复密钥本地保管**：钥匙在生成时即存本设备 localStorage（`KEYS.recoveryKey`），以便设置面"查看恢复密钥"可再次展示（服务端只有哈希，无法回显）。设备无副本时如实显示 `copy.recoveryKeyMissing`。
6. **凭据失效屏**：无座位、无邀请、本设备无钥匙时进入（与"首次抵达"不可区分，故同屏给出建墙入口；见 §8.1）；提交合法钥匙→`rebind_seat`；成功回墙，失败一行 `copy.recoveryKeyWrong`。若本设备有钥匙，boot 时自动尝试换回座位（零点击）；自动换回失败则进入凭据屏且不给建墙入口（避免一人两墙）。座位于运行中丢失（如其他设备换座）时 sync 报 `no_seat` → 凭据屏。
7. **邀请错误**：无墙时错误行单独成屏（`screen='invite-error'`，仍是一行文字）；已有墙时以流尾 notice 呈现。
8. **日期键**：`written_on` 用写作者本地日期；服务端只做 ±2 日钳制。渲染不做时区换算。
9. **首访定位**：`last_seen_seq` 不存在（首次进入）→ 视图定位到最早一条（第一封信日期组首）；存在 → 定位到 `last_seen_seq` 那一条。

## 9. 完成标准（每人）

- `npm run typecheck` 0 错误；你作用域的单元测试 `npx vitest run tests/unit/<你的文件>` 全绿；`npm run check:copy` 通过。
- 组件在 happy-dom 下可挂载（用 `@vue/test-utils` 的 `mount` 做至少一个渲染断言）。
- 不改共享文件；不改别人作用域；不执行 git。
- 完成后：把任务标记 complete，并 `send_message` 给 Lead，格式：
  `【完成】<角色> — 文件清单；关键实现；测试命令与结果；遗留/风险；需要 Lead 集成的事项`。
