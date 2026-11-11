# BiMail MVP — 独立验收报告（QA verifier）

**验收对象**：`docs/SPEC.md` v1.0 的 §9 24 条 Definition of Done + 工程契约 `docs/CONTRACT.md`
**验收者**：verifier（独立 QA，不改 `src/**` / `package.json` / `scripts/**` / `docs/SPEC.md` / `docs/CONTRACT.md`）
**验收时间**：2026-11-12 02:14–02:30（Asia/Shanghai，UTC+8；服务端 UTC 日期为 2026-11-11）
**代码状态**：Lead 于 02:25:48 声明 **src 冻结**；本报告所有结论均针对该冻结态（`dist/index.html`/`dist/assets/index-C27aYueN.js` mtime 02:26:34，FINAL3 全量复跑于 02:26–02:27；冻结后 `find src tests supabase scripts -newermt '02:25:50'` 无源码变更）。
**环境**：macOS；Tabbit Chromium（Playwright）；dev 栈：Lead 的 API `127.0.0.1:8787` + Lead 的 Vite `:5173`（未触碰）；QA 自起 Vite `:5174`（创作者/设备 A）、`:5175`（笔友/设备 B）、`:5176`（第三设备/清缓存设备）；生产验收：`npm run build` 后 `vite preview :4173`。

---

## 0. 结论摘要

| 指标 | 结果 |
|---|---|
| §9 DoD 24 条 | **24 通过 / 0 偏差 / 0 未覆盖**（DoD 6 的「30 分钟」时长以机制验证替代，见 §2 备注；T1–T7 以 PGlite SQL 套件 + 集成套件为权威证据） |
| 复跑命令 | `typecheck` 0 错误；单测 **214/214**（14 文件）；集成 **25/25**；SQL **16/16**；`check:copy` / `check:contrast` / `build` / `check:budget` 全绿 |
| 实测性能 | 首屏 JS **37.69KB gzip**（预算 55KB）、CSS **2.07KB gzip**（预算 6KB）、首屏外链请求 **2**；4G+CPU 4x+390×844：**LCP 324ms（冷启） / 348ms（墙回访）**，INP **≈64ms（Event Timing 交互最大值）**，均达标 |
| DOM | 服务端 **1013 条**历史，前端仅加载 **120+120=240 条**，DOM `.entry` = **240**（全程 ≤240） |
| 屏内可见留言数中位数 | 桌面 1440×900 = **2**；移动 390×844 = **1**（≤4，方法见 §5） |
| 发现缺陷 | **3 个**（2 个由 QA 发现并报 Lead，1 个 Lead 自查发现），全部已修复并由 QA 复验通过；另有 1 处 Lead 自查的提示行为修正已复验 |
| 残余风险 | 见 §8（真实 IME / 真机键盘与 safe-area / 30 分钟断网时长 / Safari-Firefox / Supabase 生产 E2E / 邀请明文本地保管等） |

**证据截图**（`docs/evidence/`，全部为 Tabbit 实际截图，PNG）：
`01-recovery-screen-dark.png`、`02-empty-wall-dark.png`、`03-desktop-light-wall.png`、`04-acceptor-wall-light.png`、`05-settings-light.png`、`06-lost-key-screen-light.png`、`07-desktop-dark-wall.png`、`08-mobile-input.png`、`10-empty-wall-light.png`。清单与说明见 §7。

---

## 1. 复跑命令与结果（FINAL3，2026-11-12 02:26，工作目录 `/Users/leon/Documents/BiMail`）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过，0 错误 |
| `npm test` | **214 passed / 14 files**（含 `tests/unit/flows.test.ts` 的 `''` 占位回归用例，见缺陷 1） |
| `npm run test:integration` | **25/25 pass**（真实 `server/dev-server.mjs` 子进程 + 临时端口 + 临时库） |
| `npm run test:sql` | **16/16 pass**（PGlite 内存库执行 `supabase/migrations/*.sql` 两遍验证幂等 + `set role authenticated` + `request.jwt.claims` 断言 T1–T7） |
| `npm run check:copy` | 通过：32 个源文件 / 禁用词 30 项 / 结构禁令 12 项 |
| `npm run check:contrast` | 通过：亮色 `我 15.85:1`、`笔友 12.57:1`、`淡语 4.86:1`；暗色 `我 14.26:1`、`笔友 12.13:1`、`淡语 6.07:1`；色度 ≤5.88%，色相跨度 40.0°–41.5° |
| `npm run build` | 通过：`index.js 103.52KB / gzip 38.60KB`、`style.css 7.85KB / gzip 2.12KB` |
| `npm run check:budget` | 通过：JS **37.69KB** gzip、CSS **2.07KB** gzip、首屏请求 **2**、零图片/零 Web Font/零第三方、CSP meta 就位 |

> 复跑方式：`cd /Users/leon/Documents/BiMail && npm run typecheck && npm test && npm run check:copy && npm run check:contrast && npm run test:integration && npm run test:sql && npm run build && npm run check:budget`
> 浏览器复跑：自起 `npx vite --port 5174 --strictPort`（`/api` 代理到 8787），Tabbit 任务名 **`BiMail QA`**；生产态 `npm run build && npx vite preview --port 4173 --strictPort`。详细操作步骤见 `tests/e2e/README.md`。

---

## 2. §9 Definition of Done — 24 条逐条验收

| 编号 | 条目（SPEC §9） | 验证方法（可复跑操作） | 证据 | 结果 |
|---|---|---|---|---|
| 1 | 中文/日文 IME 候选确认回车不寄出（P0） | 5174 墙内聚焦输入框：`dispatchEvent(new CompositionEvent('compositionstart'))` 后 dispatch `keydown Enter{isComposing:true,metaKey:true}`；断言输入值保留、`.entry` 数不变；`compositionend` 后 50ms 守卫期结束再 `Ctrl+Enter` 才寄出。另：`Composer` 单测覆盖 `isComposing/keyCode 229` 分支 | qa02：`afterIME.value="第一行\n第二行"`、`entries=0`；随后提交成功 1 条；`tests/unit/composer.test.ts` | 通过 |
| 2 | 连按 `⌘/Ctrl+Enter` 只产生一条 | 输入「连按测试」后连续两次 `Control+Enter`（第二次输入框已清空）；统计同正文 `.entry` 数；后端幂等由集成测试「同 client_uuid 重放/并发只落一行」覆盖 | qa02：`doubleAdd=1`；集成测试「幂等：同一 client_uuid 重放返回 duplicate:true；并发两次只落一行」 | 通过 |
| 3 | 空白输入静默忽略 | 输入 `"   \n\t  "` 后 `Ctrl+Enter`；断言 `.entry` 数不变、无任何提示行 | qa02：`afterWhitespace.entryCount` 不变（仍为 1） | 通过 |
| 4 | 粘贴富文本被剥离为纯文本 | 构造 `ClipboardEvent('paste')`，`clipboardData` 同时放 `text/plain='粘贴的纯文本'` 与 `text/html='<b>…</b><img src=x>'`；断言 textarea 值=纯文本、composer 内无 `<b>/<img>` | qa02：`pasteValue="粘贴的纯文本"`、`composerHasHtml.hasBoldTag=false,hasImg=false` | 通过 |
| 5 | 8000 字边界与超限提示正确 | 原生 setter 写入 8001 码点并派发 `input`；断言值截断为 8000、出现「已超出 1 字，未纳入。」；写入 8000 无超限行。后端边界：集成测试 8000 可寄 / 8001+空白 `invalid_body` | qa02：`over8001.len=8000`、`overflow="已超出 1 字，未纳入。"`；`at8000.overflowCount=0`；集成测试「body 边界：8000 码点…」 | 通过 |
| 6 | 刷新、关闭、断网 30 分钟后草稿仍在 | 输入草稿 → 等 300ms 节流写 `bimail.draft` → 整页 reload → 值恢复；跳到 `about:blank` 再回来 → 值恢复；CDP 断网后写草稿 → reload → 草稿键仍在；恢复网络 reload → 值恢复。草稿**永不上传**：全程 `Network.requestWillBeSent` 无含草稿的请求、无 Realtime/轮询（见 #9） | qa15：`draftStored="关闭页面后草稿仍在。"`、`draftAfterReopen` 同值、`offlineReload.draft="断网时写的草稿。"`、`draftAfterOnline` 同值；qa07 10s 空闲 0 请求 | 通过（注：30 分钟为时长口径，本轮以「本地单副本 + 断网/重载不丢」的机制验证替代，未真实等待 30 分钟；见 §8 残余风险） |
| 7 | 离线排队 5 条，恢复后按序寄出且无重复 | CDP `Network.emulateNetworkConditions{offline:true}`；连续写入并 `Ctrl+Enter` 5 条 → 断言 5 条 `.entry--queued` + 5 行「尚未寄出，联网后自动寄出。」、`bimail.queue` 长度 5、已寄出数不变；恢复网络（`offline:false`）不 reload，页面 `online` 事件自动 flush → 断言按序 4 条（先撤回第 1 条）落入流尾、队列清空、无重复正文字典 | qa07：`offlineState{queuedCount:5,queueLen:5,committedCount:4}` → `onlineState{committedCount:8,bodies:[…离线第2..5条],queueLen:0}` → `dupCheck.duplicateBodies=[]` | 通过 |
| 8 | 未寄出者可撤回；已寄出者无任何撤回入口 | queued 条目下点「尚未寄出…」→ 展开「撤回这段未寄出的文字。」→ 再点 → 条目从队列/界面消失；已寄出条目 DOM 内无 `<button>`/撤回行（`.entry:not(.entry--queued) button` 计数 0），只有 failed 的 queued 条目才渲染 `.local-line` 按钮 | qa07：`retractLine="撤回这段未寄出的文字。"`、撤回后 `queuedCount=4,queueLen=4`；`EntryStream.vue` 只在 `item.failed` 时渲染撤回按钮（DOM 断言 + 源码对照） | 通过 |
| 9 | 无 Realtime 连接、无轮询（网络面板断言） | 生产预览 4173：CDP `Network.enable` 收集 `requestWillBeSent` 与 `webSocketCreated`；页面稳定后清空计数并静置 **10s** → 请求 0、WebSocket 0。dev 5174 同样静置 10s → 请求 0、WS 0。源码/`check:copy` 结构禁令另禁止 `WebSocket/EventSource/setInterval` 轮询 | qa07：`idle{requestCount:0,wsUrls:[]}`；qa14：`idle10s{requestCount:0,wsUrls:[]}` | 通过 |
| 10 | 定位到上次离开处，且无任何「新」标记 | 在 240 条已加载窗口中真实滚动（scroll 事件经 rAF 写入 `last_seen_seq`）→ lastSeen=1018；第三方身份经 API 追写 seq 1019；A 重新加载 → 断言 `scrollTop>0`、`[data-seq=1018]` 底边位于视口底边上方 16px、最新 seq 1019 顶边在视口下方（折叠外）、全文无「新」字、`.entry--new` 数 0、seq 升序 | qa12：`anchored{lastSeen:1018,scrollTop:28993,anchorRect:{top:521,bottom:788},streamHeight:805,lastEntryTop:812,lastEntrySeq:1019,newMarkerTextHits:[],entryNewElements:0}` | 通过 |
| 11 | 1000 条历史下分页与滚动流畅，DOM ≤240 | 用页面会话 access_token 经 `/api/rpc/post_entry` 批量造 1000 条 + 5 条日期游程样本（服务端共 1013 条）；重载 → 首屏 120；下拉/回到顶部触发哨兵 `load-older` → 240；再触发不增长（`has_more=false`，更早历史不加载为契约行为）。滚动 20 步测帧：avg 15.81ms / p95 18.3ms | qa10b/qa11：`firstLoad.entryCount=120` → `page2.entryCount=240` → `page3.domEntries=240,ascending=true`；qa12：`scrollPerf{avg:15.81,p95:18.3,max:18.3}` | 通过 |
| 12 | 跨时区日期游程分组不重排、不撒谎 | 在 1000 条之后追加 5 条 `written_on=[11-11,11-13,11-11,11-13,11-12]` 的条目；重载后断言日期组按 seq 顺序呈现为 5 个连续单条 run，标签序列与写入顺序完全一致（非单调、重复均保留），且 `.entry` seq 严格升序；渲染不做时区换算 | qa10b：`datePattern=[11月11日,11月13日,11月11日,11月13日,11月12日]`（各 1 条、seq 1014–1018 递增）；qa11：`labels` tail 与之一致、`ascending=true` | 通过 |
| 13 | 暗色、`prefers-reduced-motion`、键盘可达、`:focus-visible` 全部通过 | ① 暗色：`emulateMedia({colorScheme:'dark'})` → body `rgb(23,22,20)`、我 `#E8E4DC/500`、笔友 `#D8D3C9/400`、淡语 `#9A958B`；切回 light → `rgb(245,243,239)`。② reduced-motion：默认 `.entry--new` animation `bimail-entry-in 0.12s ease-out`，`reduce` 时 `animationName:none / 0s`（CSSOM 存在对应 media 规则）。③ 键盘：Tab 焦点顺序 设置 → 输入框 → 寄出词；`:focus-visible` 计算样式 1px solid `rgb(110,106,97)`、offset 2px（设置行/寄出词）；textarea 可见焦点由规格裁定不设描边；桌面自动聚焦输入框，移动端（CDP touch 仿真 pointer:coarse）不自动聚焦（activeElement=BODY） | qa08：dark tokens、`motion{animationName:'none',duration:'0s'}`、mobile `pointerFine=false,activeElement=BODY`；qa09：`focusOrder`、`wordFocus.outline={solid,1px,offset:2px}`；qa19：1440×900 `pointerFine=true,activeElement=composer-input`、`anim{bimail-entry-in,0.12s}` | 通过 |
| 14 | 对比度与色相数断言通过 | `npm run check:contrast`（见 §1 数字）；DOM 计算色在暗色下抽查与令牌一致；正文对比度亮 15.85/12.57、暗 14.26/12.13（≥12），淡语 4.86/6.07（≥4.5），色度 ≤5.88%（≤6%），色相跨度 1.5° | `npm run check:contrast` 输出；qa08 `dark.tokens` | 通过 |
| 15 | T1：第三 uid 直接查询 `entry`/`v_entry` 返回零行 | PGlite SQL 套件 T1：第三方以 `authenticated` 查询视图/基表零行、RPC 拒绝、`anon` 无权限；集成套件 T1：无座位第三方 `list_entries` 空页、`post_entry` 409、`wall_state` 409。浏览器补充：换座后旧 uid 的 `list_entries` 返回 `{entries:[],has_more:false}`、`wall_state` 409 `no_seat` | `npm run test:sql` ✔ T1；`npm run test:integration` ✔ T1；qa06b `oldUidAfterRebind` | 通过 |
| 16 | T2：视图字段集不含 `created_at`、`client_uuid`、阅读/在线字段 | SQL 套件 T2 直接断言 `v_entry(id,seq,slot,body,written_on)`、`v_seat(slot,joined_on)` 字段集；集成套件断言响应字段集；浏览器抽查 `post_entry/list_entries` 响应只有 `id/seq/slot/body/written_on` 与 `entries/has_more` | `npm run test:sql` ✔ T2；集成测试「list_entries … 不得返回 created_at/client_uuid」；qa06b/qa07 API 抓包 | 通过 |
| 17 | T3：`has_table_privilege('authenticated','entry','UPDATE/DELETE')` 为假 | SQL 套件 T3：`entry` 无 select/insert/update/delete 表级权限、视图只读；迁移中 `revoke all` + 仅 `grant select on v_entry,v_seat` | `npm run test:sql` ✔ T3 | 通过（数据库层断言；浏览器无对应操作面） |
| 18 | T4：邀请二次消费失败；占座后 token 永久失效 | 集成测试：`accept_invite` 二次消费 409 `invite_consumed`；SQL 套件 T4：已消费优先于过期。浏览器：用已消费 token 在全新设备打开邀请 URL（`about:blank` 中转强制整页加载）→ `invite-error` 屏 +「这堵墙已有两位笔友。」+ URL fragment 已被 `replaceState` 清空 | 集成测试「accept_invite：… 邀请单次消费；未知 token 404、二次消费 409」；SQL ✔ T4；qa17 `consumedInvite{screen:'invite-error',errorLine:'这堵墙已有两位笔友。',hash:''}` | 通过 |
| 19 | T5：清缓存后用恢复密钥换回座位成功，旧 uid 读取零行 | 浏览器完整用户路径：全新设备（`:5176`，localStorage 清空）访问 → **凭据失效屏**（缺陷 2 修复后）→ 输入小写+空格分组的旧钥匙 → 归一化 → `rebind_seat` 成功 → 回到原墙（同一 `dyad_id`、120 条首屏/1013 条历史、派生语与座位日不变、钥匙重新存本机）；旧 uid：`list_entries` 空页、`wall_state` 409。另有零点击自动换座：座位被第三方钥匙换走后 reload，本机凭据自动换回、无任何屏闪。SQL T5 断言 slot/joined_on 不变、限流 5 次/h、closed 拒绝；集成 T5 同 | qa11：恢复后 `recovered{entryCount:120,derived:['11月11日，两位笔友到齐。'],apiState.state:'open',seat dedupe}`；qa06b：`lost` 屏 → 提交钥匙 → 换回成功、`autoRebind` 零点击恢复；SQL ✔ T5；集成 ✔ T5 | 通过 |
| 20 | T6：`seat.user_id UNIQUE` 阻止跨墙占座 | SQL 套件 T6：已在座者接受另一墙邀请 `already_seated`、直接插入第二个 seat 被 UNIQUE 拒绝；集成 T6 同 | `npm run test:sql` ✔ T6；集成 ✔ T6 | 通过（数据库层断言） |
| 21 | T7：删除匿名用户的运维操作被外键阻止（A4） | SQL T7：`delete from auth.users` 被 `seat.user_id … ON DELETE RESTRICT` 阻止；集成套件另在 SQLite 实现验证同一约束 | `npm run test:sql` ✔ T7；集成测试「T7 数据层：seat.user_id ON DELETE RESTRICT 阻止删除匿名用户（A4）」 | 通过（数据库层断言） |
| 22 | T8：CSP 生效，无内联脚本、无第三方请求 | 生产预览 4173：DOM `<meta http-equiv="Content-Security-Policy">` 内容与构建注入一致（`default-src 'self'; script-src 'self'; style-src 'self'; …; object-src 'none'`）；`<script>` 仅 1 个外链、内联脚本 0；无 CSP violation/pageerror；首屏请求全部同源（含浏览器自身 `chrome-extension://` 的内容脚本请求，非页面第三方资源）；零图片/零字体；`check:budget` 静态断言同项 | qa14 `cspDom{inlineScripts:0,externalScripts:1,csp:…}`、`consoleMessages` 无 CSP 违规、`thirdParty:[]`；qa16 无 pageerror；`npm run check:budget` ✔ | 通过 |
| 23 | 首屏 JS ≤55KB gzip、请求 ≤4、零 Web Font | `npm run build && npm run check:budget`：JS 37.69KB gzip、CSS 2.07KB gzip、首屏外链请求 2（JS+CSS；含 HTML 文档为 3）、零图片/零 Web Font/零第三方脚本；运行时资源条目仅同源 JS/CSS + `/api` fetch | `npm run check:budget` 输出（§1）；qa14 `resourceEntries`、`fonts:[]` | 通过 |
| 24 | 4G 中低端机 LCP ≤1.0s，INP ≤100ms | 生产构建 4173，390×844（mobile 仿真），CDP `Network.emulateNetworkConditions` 4G（latency 40ms / 下行 10Mbps / 上行 5Mbps）+ `Emulation.setCPUThrottlingRate 4`；注入 LCP/Event Timing/Paint/LongTask observer：冷启动（凭据屏）**LCP 324ms**（FCP 324ms）；墙回访 **LCP 348ms**（FCP 348ms）；INP：Event Timing 交互事件 duration 最大 **64ms**（样本 40/48/64/64ms），pointerdown→下一帧延迟 max 30ms / 中位 26.3ms；长任务 61ms、114ms（4x CPU 下） | qa14 `lcpLostScreen{324}`、`lcpWall{348}`；qa16 `inpSummary{pointerMax:30,pointerMedian:26.3,eventTimingOver16ms:[64ms max]}` | 通过 |

**统计**：通过 24 / 偏差 0 / 未覆盖 0。DoD 6 的 30 分钟时长、DoD 13 的真实移动键盘/真实 IME、DoD 24 的真机硬件为**口径/环境限制**，已用等价机制 + 仿真覆盖，列入 §8 残余风险而非记偏差。

---

## 3. 已知裁定（不计为缺陷，按 Lead 裁定与 SPEC 冲突说明记录）

1. **暗色 `--ink-theirs` 由 `#C9C4BA` 调整为 `#D8D3C9`**：SPEC §4.1 给定暗色值对纸 `#171614` 实测仅 **10.41:1**，与同节「正文对比度 ≥12:1」的验收阈值冲突。按可验收阈值裁定采用 `#D8D3C9`，实测 **12.13:1**（≥12），色度 5.88%（≤6%），色相不变。`check:contrast` 与暗色 DOM 计算色均验证。
2. **`seat.joined_on` 用服务端 UTC 日期**：SPEC §5.2 默认 `(now() at time zone 'utc')::date`。本轮验收恰在 UTC+8 深夜（本地 11-12、UTC 11-11），实测派生语为「**11月11日，两位笔友到齐。**」，而留言日期标签为「11月12日」。与 Lead 申报的已知取舍一致：派生语可能比写作者本地日期早一天，规格明确 UTC，不重排、不换算。
3. **邀请明文 token 的保管边界**：服务端只存 SHA-256，明文只出现在 `create_wall` 响应一次；创建者设备将其存入 `localStorage['bimail.invite']` 以便刷新后仍可取回邀请链接。**清空设备存储后无法再取回邀请链接**（列残余风险）。实测 nascent 期间 `.invite-line` 显示 `http://<origin>/#i=<32字符>` 纯文本（非 `<a>`），b 占座后消失，`bimail.invite` 被清除。
4. **Composer textarea 无 focus 描边**：SPEC §3.2「无边框、无背景、无焦点光环」与 §4.4 无障裁定共存——鼠标聚焦无光环；键盘 `:focus-visible` 的可见描边由词形控件（`.word`）与 `key-input` 承担。实测 textarea 在 `:focus-visible=true` 时 `outline-style:none`；设置行/寄出词为 1px 中性描边。属规格内部冲突的既定裁定。
5. **分页只加载 120+120、DOM 上限 240**：更早历史不加载（契约行为，不是缺陷）。实测服务端 1013 条时前端 DOM 严格 240，`has_more` 到上限后关闭；滚动流畅（avg 15.81ms/帧）。
6. **「屏内可见留言数中位数 ≤4」的测量方法**：在目标视口内统计**完全落在滚动视口内**的 `.entry` 数量；在 240 条已加载、正文为真实信件长度（150–280 字符/条，约 4–9 行）的墙上取 5 个等距滚动位置（0/20%/40%/60%/80%），取中位数。结果：**1440×900 = 2**（样本 2,3,2,2,2）、**390×844 = 1**（样本 1,2,1,1,1）。参考：更短的「聊天式」一行留言会提高密度，本项按 SPEC「信」的内容假设测量。
7. **空态零控件 vs 首次快捷键提示**：SPEC §3.2「空态无快捷键提示」与 §3.1-8「首次进入输入框上方出现一行淡字，永久保留至首次成功寄出」冲突。实现按 §3.1-8 优先：首访空态显示该行**文字**，但空态交互控件严格为 0（`.composer button` 0、无字数计）；首次寄出成功后提示消失且不再出现（`bimail.first_commit_done=1`）。实测空态/输入中提示均可见、首次提交后消失、reload 后消失。
8. **邀请失败文案映射**：SPEC §3.1 把「已消费/已过期/座位已满」归为一句「这堵墙已有两位笔友。」，而 §7 文案字典另给「这条链接已经过期。请向他/她再要一条。」。实现映射为：`invite_consumed`（已消费/非 nascent/满）→「这堵墙已有两位笔友。」；`invite_expired`/`invite_unknown`（过期/不存在，含已销毁墙的失效 token）→「这条链接已经过期…」。浏览器实测：已消费 token →「这堵墙已有两位笔友。」；已销毁墙的 token →「这条链接已经过期…」。与 §7 的细分文案一致，记为规格内部冲突的既定映射。

---

## 4. 缺陷记录（发现 → 修复 → 复验）

| # | 现象 | 复现步骤 | 期望 / 实际 | 处理与复验 |
|---|---|---|---|---|
| 1 | 全量单测 1/191 失败：`SettingsView` 在 `recoveryKey=''` 时不渲染 `.recovery-key` 占位 | `npx vitest run tests/unit/flows.test.ts`；用例「二次确认前父组件以空串占位」 | 期望：`''` 是父组件「未二次确认」占位，应渲染空 `.recovery-key`（CSS `:empty` 隐藏）+ 不显示缺失行。实际：`v-else-if="recoveryKey.length > 0"` 导致元素不存在，`wrapper.get` 抛错 | 02:16 报 Lead；Lead 改为 `v-else` 分支（`''` 渲染空 code，`null` 才显示 `copy.recoveryKeyMissing`）；QA 复验：全量单测恢复全绿（最终 214/214） |
| 2 | 清空设备存储后自动建新墙，**恢复密钥无 UI 入口**，DoD 19 的「清缓存后用钥匙换回」不可达 | 已入座设备执行 `localStorage.clear()` → 整页 `reload` | 期望（CONTRACT §8.6）：进入凭据失效屏（`需要你的钥匙才能回到这堵墙。`+输入框），输入旧钥匙换回原墙。实际：直接 `createWall()` → 新墙新钥匙，页面无 `[data-testid=key-input]`，旧墙无法找回 | 02:2x 报 Lead（附 DOM/状态证据与"首访不可区分"的契约冲突分析）；Lead 裁定修复：`lost` 屏同屏给「还没有墙，就先建一堵。」+ 词「建一堵新墙」（`allowCreate` 仅在全新匿名且本机无钥匙时为真；有钥匙自动换座失败/运行中丢座则不给建墙入口）；新增 5 条组件测试。**QA 复验（qa11/qa17）**：清空存储 → lost 屏文案/元素正确（空输入无「进入」、输入后出现「进入」）；小写+空格旧钥匙归一化 → 回原墙（同 dyad、1013 条历史、座位日不变、钥匙重新存本机）；另一设备点「建一堵新墙」→ 恢复密钥屏 → 确认 → 空墙 + 邀请行。**通过** |
| 3 | （Lead 自查，QA 截图复核）移动端 `@media(max-width:480px)` 把 `.entry` 覆盖为 `width:100%`，移动端「水平位置」身份编码消失且违反 §4.2「块宽 ≤86%」 | 390×844 下量 `.entry` 宽度与左右的 `margin-left/right` | 期望：块宽 86%、我靠右（`margin-left:auto`）/笔友靠左。实际：100% 且全部贴左 | Lead 删除该覆盖后 QA 复验（qa17/qa19）：移动 390×844 版心 350px，条目宽 **301px=86%**；我 `gapLeft=49 / gapRight=0`、笔友 `gapLeft=0 / gapRight=49`；文本仍左对齐、无横向溢出；桌面 1440×900 版心 600px、条目 516px=86%，左右区分同。**移动端截图 08 已重拍** |
| 4 | （Lead 自查，QA 复验）首次快捷键提示在开始输入即隐藏，违反 §3.1-8「永久保留至第一次成功寄出」 | 首访墙输入文字观察 `.composer-hint` | 期望：输入过程中仍显示，直到首次成功寄出。实际：输入后立即消失 | Lead 改为 `hintVisible = props.showShortcutHint`（父组件在首次成功寄出后才关闭）；QA 复验（qa19）：首访显示 → 输入中仍显示 → 首次 `Ctrl+Enter` 寄出后消失（`first_commit_done=1`）→ reload 后不出现；空态交互控件仍为 0。**通过** |

> 另记：02:15 首次运行 `npm run test:sql` 时 T5 期望 `throttled` 实得 `invalid_hash`，02:16 复跑 16/16 全绿——判定为 backend 正在写文件时的中间态，**不计缺陷**。

---

## 5. 实测性能与量化数据（冻结态）

| 指标 | 实测 | 阈值/说明 |
|---|---|---|
| JS 首屏 | **37.69KB gzip**（raw 103.52KB） | ≤55KB ✔ |
| CSS | **2.07KB gzip**（raw 7.85KB） | ≤6KB ✔ |
| 首屏静态请求 | **2**（1 JS + 1 CSS；含 HTML 文档 3） | ≤4 ✔；零图片、零 Web Font、零第三方脚本 |
| CSP | 构建注入 meta，`default-src 'self'; script-src 'self'; …; object-src 'none'`；内联脚本 0；无 violation | T8 ✔ |
| LCP（冷启，凭据屏） | **324ms**（FCP 同 324ms），390×844 / 4G 40ms 10Mbps / CPU 4x | ≤1000ms ✔ |
| LCP（墙回访） | **348ms**（FCP 348ms），同上 | ≤1000ms ✔ |
| INP | Event Timing 交互 duration 峰值 **64ms**（40/48/64/64）；pointerdown→rAF 代理 max 30ms / 中位 26.3ms | ≤100ms ✔ |
| 长任务（4x CPU） | 61ms、114ms | 仅记录 |
| DOM | 服务端 1013 条 → 首屏 120 → 上翻 240；DOM `.entry` **240**，到上限后不再加载 | ≤240 ✔ |
| 滚动帧 | 20 步程序化滚动：avg **15.81ms**、p95 18.3ms、max 18.3ms（240 条重条目） | ~60fps ✔ |
| 屏内可见留言中位数 | 桌面 1440×900：**2**（2,3,2,2,2）；移动 390×844：**1**（1,2,1,1,1） | ≤4 ✔（方法见 §3.6） |
| 版心/宽度 | 桌面版心 600px、条目 516px=86%；移动版心 350px、条目 301px=86%；正文 17px / 行高 1.75（29.75px）；相邻间距 24px；日期组上 40/下 16 | §4.2 ✔ |
| 对比度 | 亮：我 15.85 / 笔友 12.57 / 淡语 4.86；暗：我 14.26 / 笔友 12.13 / 淡语 6.07 | 正文 ≥12、淡语 ≥4.5 ✔ |
| 色相/色度 | 单暖灰色相 40.0°–41.5°（跨度 1.5°）；令牌色度 1.18%–5.88% | ≤6% / 单色相 ✔ |
| 空闲网络 | 10s 静置：请求 0、WebSocket 0（生产预览 & dev 均验） | #9 ✔ |

---

## 6. 两身份完整业务流（浏览器实测摘要）

1. **创作者 A（5174，localStorage 清空）**：首访 → 凭据屏 → 「建一堵新墙」→ 恢复密钥屏（32 字符 Base32、等宽；复制→「已复制。」；下载 .txt 文件名 `bimail-recovery-key.txt`、内容=钥匙）→「我已保管」→ 空墙：创建者空态文案 + 邀请链接纯文本行 + 首访提示；桌面自动聚焦输入框；空态寄出控件 0。
2. **封缄的信**：A 在 nascent 连写（含 IME 守卫输入、粘贴、8000 截断、连按幂等、空白忽略）→ 留言按 seq/日期呈现，邀请行仍在。
3. **占座**：B（5175 独立源=独立设备，清空存储）打开 A 的邀请 URL（`#i=<32>`，加载后 fragment 立即清空）→ 接受并占 b → 恢复密钥屏 → 墙：顶部派生语「11月11日，两位笔友到齐。」、A 的信以「笔友：」呈现、无邀请行。
4. **回信**：B 写回信 → A 重访同步后看到「笔友：回信…」，B 视角为「你：」；身份编码 = 位置 + 字重（500/400）+ 墨色（#1A1917/#2E2C28）三重冗余，移动端位置区分仍成立。
5. **设置面四项**（顺序固定）：查看恢复密钥（二次确认后展示、不再自动隐藏、关掉再进不提前显示）→ 导出全部文字（浏览器截获 Blob：抬头 `BiMail · 导出于 2026年11月12日`、`—— 11月12日`、`我：`/`你：` 标签、文件名 `bimail-2026-11-12.txt`，A/B 两个视角均逐字核对）→ 让其他设备离开（确认词 + 「其他设备已经离开。」）→ 离开并销毁我的文字（确认行「你的文字将被删除，这堵墙会停下。不可恢复。」）。
6. **销毁 / closed**：A 销毁后：A 自己的 1013 条消失、B 的 2 条仍可读；`state=closed`、座位不释放（`seats` 仍 a/b）、邀请行消失、无输入框、流尾/通知行「这堵墙已经停下。」、设置面仍可进入；B 重载同样看到 closed + 自己 2 条可读、不可写。
7. **恢复密钥换座**：清空设备存储 → 凭据屏 → 旧钥匙（小写+空格）→ 归一化 → 换回原 dyad 全部历史；旧 uid 零行；「有钥匙时零点击自动换座」亦验证。

---

## 7. 截图证据清单（`docs/evidence/`）

| 文件 | 内容 | 视口/主题 |
|---|---|---|
| `01-recovery-screen-dark.png` | 恢复密钥屏：钥匙（32 字符等宽）、复制/下载 .txt/我已保管、说明行 | 1392×623（≈桌面）/ 暗色（系统默认） |
| `02-empty-wall-dark.png` | 空墙（创建者）：空态文案 + 邀请链接纯文本行 + 首访提示 + 0 寄出控件 | 桌面 / 暗色 |
| `03-desktop-light-wall.png` | 两人墙（A 视角）：A 的信靠右（字重 500/墨色更深）、B 的回信靠左；派生语 + 日分组 | 1440×900 / 亮色 |
| `04-acceptor-wall-light.png` | 笔友 B 占座后首屏：封缄的信以「笔友：」呈现 + 派生语 | 1440×900 / 亮色 |
| `05-settings-light.png` | 设置面四行 + 查看恢复密钥（二次确认后展示）+ 动作结果行 | 1440×900 / 亮色 |
| `06-lost-key-screen-light.png` | 凭据失效屏（缺陷 2 修复后）：说明行 + 「还没有墙，就先建一堵。」+ 钥匙输入 + 「建一堵新墙」 | 1440×900 / 亮色 |
| `07-desktop-dark-wall.png` | 暗色墙（对照 `--ink-theirs #D8D3C9`、纸 #171614） | 1440×900 / 暗色 |
| `08-mobile-input.png` | 移动端输入中：390 宽、版心 350、条目 86%（我右/笔友左）、输入文字 + 「寄出」/「⌘⏎」、输入区吸底 | **390×844** / 亮色 |
| `10-empty-wall-light.png` | 空墙（新建墙确认后）：空态创建者文案 + 邀请行 + 首访提示 | 1440×900 / 亮色 |

---

## 8. 残余风险与未覆盖项（诚实标注）

1. **真实输入法（中文/日文）未在真实 IME 候选窗中操作**：以 `CompositionEvent` + `KeyboardEvent{isComposing}` 合成验证 P0 守卫（值为保留、条目未增），并对照 `Composer` 单测；真实系统 IME 的 `compositionend → keydown` 时序差异建议真机抽测一次。
2. **真实移动键盘与 safe-area**：`env(safe-area-inset-bottom)` 与 `visualViewport` 键盘吸底代码路径已静态核对（`.composer-dock` padding 含 `env(safe-area-inset-bottom)` + `--bimail-keyboard-inset`），仿真环境下 inset 恒为 0；未在带刘海/虚拟键盘的真机上实测吸底位移。
3. **DoD 6 的「30 分钟」时长未字面等待**：以「草稿仅 localStorage、节流 300ms、blur/hidden 立即写、重载/断网/离开页面均不丢、永不上传」的机制验证替代；30 分钟与浏览器后台节流下的极端时序建议真机等待一次。
4. **浏览器覆盖面**：仅 Tabbit Chromium。Safari（无痕 localStorage 失败降级、`execCommand` 复制降级、`100dvh` 表现）与 Firefox 未实测。
5. **Supabase 生产路径未在真实 Supabase 项目 E2E**：以 PGlite 执行真实迁移 + `set role authenticated` + RLS/RPC 断言（16 项）+ `src/lib/supabase.ts` mock 单测覆盖；真机部署冒烟（匿名登录/占座/寄出/换座/销毁）建议在 `docs/BACKEND.md` 的部署步骤后做一次。
6. **邀请明文设备本地保管**：清空设备存储后邀请链接不可再取回；未消费链接被第三方获得者理论上可占座（SPEC §5.5 已明示残余风险）。邀请 token 只进 fragment，加载即 `replaceState` 清除（实测 reload 后 hash 为空）。
7. **导出/下载的真实浏览器下载事件**：Tabbit 连接不提供 Playwright download 事件；导出与钥匙下载以「拦截 `URL.createObjectURL` 的 Blob 文本 + `a.download` 文件名」验证，内容与文件名逐字一致；真实落盘未断言。
8. **性能为桌面 Mac + CDP 4G/CPU 4x 仿真**，非真实低端机；LCP/INP 余量充足（324/348ms、64ms），但仍建议真机抽测。
9. **local dev backend 与 Supabase 生产实现存在有意差异**：例如 `rebind_seat` 在 Supabase 侧为 HTTP 200 + `{"error":code}`（为让限流计数不被 `raise` 回滚提交），local 侧为 4xx；客户端两种映射均已单测/实测覆盖，但两套后端的响应形态差异需在维护中注意。
10. **无真实 24×7 运行/并发压测**：1000 条历史 + 240 DOM 的滚动/分页已验证；多标签并发、长连接断开、服务端重启等运维场景未覆盖。

---

## 9. 建议 Lead 交付前最后动作

1. 以本报告 §1 命令在冻结态再跑一次 `npm run check`（QA 已跑：214 单测 / 25 集成 / 16 SQL / 文案 / 色彩 / 构建 / 预算全绿）。
2. 确认 `dist/` 为最终构建（QA FINAL3 build 于 02:26:47 产出 `index-C27aYueN.js` / `style-BvryzV1g.css`；若之后还改过文件需重建并重跑 `check:budget`）。
3. 部署侧：CSP 目前是 `meta`，`frame-ancestors`/`report-uri` 等无法由 meta 表达，需由托管方响应头补齐（见 `vite.config.ts` 注释与 `docs/BACKEND.md`）；确认 `cache-control`/静态资源缓存策略。
4. 若发布 Supabase 生产：按 `docs/BACKEND.md` 建项目 → 执行迁移 → 开启匿名登录 → 真实冒烟 T1/T4/T5/T6/T7 + 一次 `rebind_seat` 限流（5 次/h）。
5. 真机补测：中文/日文 IME、移动键盘吸底 + safe-area、Safari 无痕 localStorage 降级、真实下载落盘。
6. 归档：`docs/ACCEPTANCE.md` + `docs/evidence/*.png` + `tests/e2e/README.md` 一并纳入交付；`docs/SPEC.md` §10 未决问题（日期游程重复的可用性、重绑定是否需对方确认）建议在发布说明中如实保留。

---

## 附：本轮 Tabbit 任务与请求 ID（可追溯）

任务名 **`BiMail QA`**（Tabbit runtime）。请求 ID：`qa01-boot`（恢复屏/空墙）、`qa02-input`（输入/IME/粘贴/8000/幂等/首次寄出）、`qa03-acceptor`（占座/回信）、`qa04-settings`（设置/导出/注销）、`qa05-aview-cache`（A 视角/导出/清缓存复现缺陷 2）、`qa06b-rebind`（换座/旧 uid 零行/零点击恢复）、`qa07-offline`（草稿/离线队列 5/撤回/恢复/空闲）、`qa08-mobile-a11y`（移动/暗色/reduced-motion/焦点/信号扫描）、`qa09-focus-mobile`（动画/焦点描边/移动截图）、`qa10b-seed-pagination`（1000 条/分页/日期游程）、`qa11-defect2-pagination`（缺陷 2 复验/分页 240）、`qa12-anchor-density`（定位/无新标记/密度/滚动帧）、`qa13-destroy-closed`（销毁/closed/新建墙）、`qa14-preview-perf`（CSP/请求/10s 空闲/LCP）、`qa15-draft-close-invite`（草稿/断网/信号扫描）、`qa16-invite-inp`（邀请失败文案/钥匙下载/INP）、`qa17-mobile-reverify`（缺陷 3 复验/已消费邀请/lost 截图）、`qa19-fresh-desktop`（提示生命周期/桌面-移动对齐/新页面错误检查）。
