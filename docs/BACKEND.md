# BiMail 后端说明（local 后端与 Supabase 生产实现）

本文说明两种后端如何跑起来、如何验收，以及安全边界与残余风险。产品定义以
`docs/SPEC.md` 为准，接口契约以 `docs/CONTRACT.md` 为准；本文只记录实现细节与运维步骤。

两种后端实现同一个 `Backend` 接口（`src/lib/adapter.ts`）：

| 模式 | 选择方式 | 实现 | 用途 |
|---|---|---|---|
| local | `VITE_BACKEND=local`（默认） | `server/dev-server.mjs`（零依赖 Node HTTP + `node:sqlite`） | 本地开发、集成测试、端到端验收 |
| supabase | `VITE_BACKEND=supabase` | `src/lib/supabase.ts`（手写 Auth + PostgREST 客户端，不引入 supabase-js） | 生产部署 |

---

## 1. 本地后端（零服务）

```bash
npm run dev:api     # 只起 API：127.0.0.1:8787
npm run dev         # API + Vite（5173），Vite 把 /api 代理到 8787
```

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口；支持 `0`（由系统分配，测试用） |
| `BIMAIL_DB` | `server/data/bimail.db` | SQLite 文件；支持 `:memory:` |

启动通过后 stdout 固定打印一行，集成测试据此解析端口：

```
[bimail-api] listening on http://127.0.0.1:<实际端口>
```

收到 `SIGTERM` / `SIGINT` 时优雅退出（0）。文件库位于 `.gitignore` 覆盖的
`server/data/` 下。

实现要点：

- 匿名登录：服务端只保存 token 的 SHA-256；`POST /api/auth/refresh` 轮换 access 与
  refresh 两枚 token，旧 token 即时失效。
- 邀请：24 字节随机 → 32 字符 base64url；服务端只存 SHA-256；7 天过期、单次消费。
  明文只在 `create_wall` 的响应里出现一次，因此 `wall_state` 的 `snapshot.invite`
  恒为 `null`；创建者设备由前端自行保管链接明文（`src/lib/store.ts` 的 `bimail.invite` 兜底）。
- 幂等：`(dyad_id, client_uuid)` 唯一；重放（即使墙已 closed）返回原记录 +
  `duplicate: true`。并发重复写入只落一行。
- 日期：`written_on` 非法或不在服务端 UTC 日期 ±2 日内 → 取服务端日期；不做时区换算。
- 限流：`rebind_seat` 按调用者记录，1 小时 5 次，失败与通过都计；被限流的调用不计数。
- 数据层外键：`seat.user_id → users(id) ON DELETE RESTRICT`（A4 的数据库级保护）、
  `entry` 对 `dyad` 与 `seat(dyad_id, slot)` 外键、`seat.user_id UNIQUE`（A1）。
- 不记录请求体、token、IP、精确时刻；所有响应 `cache-control: no-store`；
  错误体固定 `{ "error": "<BackendErrorCode>" }`。

辅助模块：`server/store.mjs`（数据层，可单独被测试进程打开同一文件库做运维级断言）；
`server/dev-server.mjs`（HTTP 路由与鉴权）。两者均为内部模块，不承诺对外接口稳定。

---

## 2. Supabase 生产实现

### 2.1 建项与开启匿名登录

1. 在 Supabase 控制台新建项目，记下 `Project URL` 与 `anon public key`（API Keys 页）。
2. Authentication → Sign In / Providers：开启 **Anonymous sign-ins**（允许匿名登录）；
   本产品不需要邮箱、手机号、OAuth 等任何其它登录方式，建议保持关闭。
3. Authentication → URL Configuration：把 `Site URL` 设为 GitHub Pages 域名
   （例如 `https://<name>.github.io/<repo>/`），并把同一来源加入 `Redirect URLs`。
4. 不要启用 Realtime、Storage、Edge Functions（SPEC §5.1）。
5. `service_role` key 只允许出现在运维侧，绝不进入前端产物或仓库。

### 2.2 执行迁移

迁移文件在 `supabase/migrations/`，按文件名排序执行，**顺序不可打乱**：

| 文件 | 内容 |
|---|---|
| `0001_init.sql` | 表（dyad / seat / entry / invite / rebind_attempt）、视图（v_entry / v_seat）、RLS、列级读权限、`my_dyad()` / `my_slot()` |
| `0002_rpc.sql` | security definer RPC、白名单授权、rebind 限流 |

两种执行方式任选：

- **SQL Editor（最少步骤）**：新建查询，粘贴 `0001_init.sql` 全文执行，再粘贴
  `0002_rpc.sql` 全文执行。
- **Supabase CLI**：`supabase link --project-ref <ref>` 后执行 `supabase db push`。

迁移写成幂等友好（`create table if not exists`、`create or replace`、policy 先 drop
再 create、授权语句可重复），但**已应用的迁移不要回改**；结构变更请新增文件。
`tests/sql/run.mjs` 会把两个文件各执行两遍以验证幂等。

### 2.3 环境变量

本地开发时写入 `.env.local`（不提交）：

```
VITE_BACKEND=supabase
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key>
```

构建生产产物时同样需要这两个变量（`.env.example` 已给出模板）。`anon public key`
按设计是公开的：它只代表「未登录的匿名角色」，能否读到数据完全由 RLS 与函数白名单
决定。任何情况下都不得把 `service_role` key 打进前端。

### 2.4 部署到 GitHub Pages

```bash
npm run build        # vue-tsc + vite build，产物在 dist/
```

- 把 `dist/` 发布到 Pages（可用 `gh-pages` 分支或 Actions；工作流文件由 Lead 维护）。
- `vite.config.ts` 已设 `base: './'`，适用于 `https://<name>.github.io/<repo>/` 子路径。
- 单页无路由；邀请 token 放在 URL fragment（`#i=<token>`），fragment 不会进入服务器
  日志、`Referer` 与 CDN 缓存键。
- Pages 无法自定义响应头：只能靠构建时注入的 `<meta>` CSP；`frame-ancestors` 这类
  只能靠响应头表达的指令在 meta 中无效，如需强约束请挂在自有域名 + 反向代理上。

### 2.5 CSP 需要放行的域名

构建时注入的 CSP 已覆盖（见 `vite.config.ts`）：

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self' https://*.supabase.co; base-uri 'none';
form-action 'none'; object-src 'none'
```

- 前端只与 `https://<project-ref>.supabase.co` 通信（Auth 在 `/auth/v1/*`，
  数据在 `/rest/v1/*`），因此 `connect-src` 只需放行 `https://*.supabase.co`
  （若使用自定义 API 域名，请改成对应来源）。
- 不允许任何第三方脚本、Web Font、图片与统计脚本；不需要为它们放行。
- 若使用 CSP 报告端点，注意报告本身会外发请求，建议不启用。

---

## 3. 数据库与 RPC 实现说明

### 3.1 表与视图

- `dyad`：墙，三态 `nascent | open | closed`。
- `seat`：座位。主键 `(dyad_id, slot)`，`slot ∈ {a,b}`，`user_id UNIQUE`（一人一墙），
  `user_id → auth.users(id) ON DELETE RESTRICT`（已寄出文字恒可读的数据库级保护），
  `recovery_hash bytea` 只存恢复密钥的 SHA-256。
- `entry`：留言，只追加。`seq bigint generated always as identity` 严格单调；
  `UNIQUE (dyad_id, client_uuid)` 保证幂等；`created_at` 只用于排序与审计。
- `invite`：每个墙至多一条；`token_hash` 唯一；`expires_on` 7 天；`consumed_at` 单次消费。
- `rebind_attempt`：`rebind_seat` 限流记录。
- `v_entry(id, seq, slot, body, written_on)`、`v_seat(slot, joined_on)`：唯一读通道，
  `security_invoker = true`；`created_at` / `client_uuid` / `dyad_id` 不在任何视图中。

RLS：`entry` 与 `seat` 只允许读自己墙的行（`dyad_id = my_dyad()`）；没有 insert /
update / delete 策略，基表写权限全部撤销；`dyad` / `invite` / `rebind_attempt` 无策略、
无授权；全部写入只经 security definer RPC。RPC 内的 `set search_path = public, pg_temp`。

**与 `docs/CONTRACT.md` 的已知差异（已在交付说明中报备）**：PostgreSQL 的
`security_invoker` 视图会以调用者身份检查底层表权限，因此 `authenticated` 必须持有
**列级** SELECT 才能读视图。实现只授予视图真正用到的列：

```
grant select (id, seq, slot, body, written_on) on public.entry to authenticated;
grant select (slot, joined_on) on public.seat to authenticated;
```

其结果是 `created_at` / `client_uuid` 在基表层面即不可读（比「只藏视图」更强），
同时表级 `has_table_privilege(..., 'SELECT')` 仍为假，符合 SPEC §5.2 的表级断言。
`tests/sql/run.mjs` 的 T2/T3 会验证这两点。

### 3.2 RPC 一览

所有 RPC 返回 JSON，形状与 local 后端的 HTTP 响应体一致：

| 函数 | 参数 | 通过返回 |
|---|---|---|
| `create_wall(recovery_hash bytea)` | 恢复哈希（32 字节） | `{snapshot}`（含一次性邀请 token） |
| `accept_invite(token text, recovery_hash bytea)` | 邀请明文、恢复哈希 | `{snapshot}` |
| `wall_state()` | — | `{snapshot}` |
| `list_entries(before_seq bigint, page_limit int)` | 分页游标 | `{entries, has_more}` |
| `post_entry(client_uuid uuid, body text, written_on date)` | 幂等键与正文 | `{entry, duplicate}` |
| `rebind_seat(recovery_hash bytea)` | 恢复哈希 | `{snapshot}` |
| `revoke_other_sessions()` | — | `{}` |
| `close_and_erase()` | — | `{}` |

- 业务错误一般以 `raise exception '<code>'` 表达，PostgREST 把 message 原样带回，
  `src/lib/supabase.ts` 按 `BackendErrorCode` 映射（如 `already_seated`、`no_seat`、
  `invite_consumed`、`wall_closed`、`invalid_body`、`throttled`…）。
- `rebind_seat` 是唯一例外：它的错误用 HTTP 200 + `{"error":"<code>"}` 返回。
  原因：PostgreSQL 中 `raise` 会回滚整个事务，连提前写入的 `rebind_attempt` 计数也会
  被回滚，导致「失败也计入限流」永远不生效。为满足 SPEC §5.6 的每小时 5 次节流，
  该 RPC 必须正常返回以提交计数。客户端对「4xx + message」与「200 + error」两种
  形式都做映射，其余 RPC 仍按契约使用 raise。
- 恢复哈希传参：客户端把 64 位小写 hex 包成 PostgREST 的 bytea 字面量
  （JSON 字符串 `"\\x<64 hex>"`，即 `\x` + hex），服务端得到 32 字节。函数内不再接触
  明文恢复密钥。
- 邀请明文只出现在 `create_wall` 的响应里；服务端只有哈希，`wall_state` 的
  `snapshot.invite` 恒为 `null`。
- `revoke_other_sessions`：客户端主路径调用 GoTrue 的
  `POST /auth/v1/logout?scope=others`（`src/lib/supabase.ts`）；SQL 函数另按
  `request.jwt.claims.session_id` 清理 `auth.sessions`，作为不同 GoTrue 版本下的兜底，
  auth schema 结构不符时静默跳过。

### 3.3 验收方式（不依赖真实 Supabase）

```bash
npm run test:sql          # PGlite 内存库 + mock auth schema + anon/authenticated 角色
npx vitest run tests/unit/supabase.test.ts   # mock fetch 断言 URL/header/错误映射
```

`tests/sql/run.mjs` 覆盖：T1 第三方零行、T2 视图字段集、T3 表级写权限为假、
T4 邀请单次消费/未知/过期、T5 换座后旧 uid 零行、T6 `seat.user_id UNIQUE`、
T7 外键 RESTRICT 阻止删除在座主体，以及视图不可写、幂等重放、日期 ±2 日钳制、
8000 码点边界、closed 语义、分页上限、限流。PGlite 支持 role / RLS / security definer
与 `set role`，以上断言**未降级**；未覆盖的是真实 PostgREST 的 HTTP 序列化与 GoTrue
签发流程（离线环境不可达），`tests/unit/supabase.test.ts` 用 mock 覆盖客户端侧的
序列化与错误映射。

---

## 4. 安全边界与残余风险

**能说什么**：传输加密、静态加密、行级隔离；恢复密钥只存哈希；分秒不进任何响应；
第三方读不到你们墙上的字。

**明确不承诺端到端加密**：留言在数据库内是明文（平台方与数据库运营方理论上可读）。
产品文案不得出现 SPEC §5.5 列出的禁用表述，也不得暗示端到端加密。

残余风险清单：

1. **未消费的邀请链接被第三方取得**：可抢先占座。缓解：192 位熵、7 天时效、单次消费、
   token 只在 fragment 中传输且不入日志；占座后永久失效。风险无法归零。
2. **一方设备被他人取得**：可读写该座位、可看到本机未寄出的草稿。「让其他设备离开」
   只能注销其它登录句柄，无法清除那台设备本地保存的草稿与钥匙。
3. **平台方 / 数据库运营方**：可读明文；不提供端到端加密（见上）。
4. **换座后的旧 JWT**：旧 access token 在自然过期前仍能通过鉴权，但已无座位，
   读取零行、写入被拒；refresh token 随之失效（GoTrue logout 或 RPC 兜底）。
5. **邀请链接丢失**：创建者设备之外的任何地方都没有明文链接；服务端只有哈希，
   刷新后无法回显（`snapshot.invite` 恒 `null`）。这是「只存哈希」的代价，已由前端
   在创建者设备本地保管链接明文来补偿。
6. **限流位置**：`rebind_seat` 按调用者主体限流（1 小时 5 次）；这是防猜测/防刷的
   单层措施，不防分布式来源。PostgREST 与 GoTrue 自带的限流策略应保持在默认值。
7. **运维删除匿名主体**：被 `seat.user_id ON DELETE RESTRICT` 阻止（A4）。要清理只能
   先由主体行使销毁权；座位永不释放（A1），这是设计而非缺陷。
8. **供应链**：前端直接依赖仅 Vue；无第三方脚本、无 Web Font、无图片外链；CSP 已
   限制 `script-src 'self'`。静态托管方仍属信任根。
9. **时序侧信道**：`seq` 可被对方看到，但库外只有日期，无分秒，无法重建作息。

## 5. 运维注意

- 迁移只增不改；破坏性变更另开文件并先在全量备份上演练。
- 备份使用 Supabase 自带的每日备份；恢复演练需同时验证 `auth.users` 与 public schema。
- 日志：应用侧不得记录正文、token、IP、精确时刻；若启用平台日志，至少关闭
  PostgREST/GoTrue 请求体日志，并缩短保留期。
- 监控只看部署级聚合计数（SPEC §8），不含正文、不含 IP、不含阅读位置；
  提供完全关闭的开关。
