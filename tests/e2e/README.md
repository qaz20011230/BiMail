# BiMail 浏览器端验收复跑手册（QA，Tabbit）

本目录记录独立验收（`docs/ACCEPTANCE.md`）的浏览器复跑步骤。验收通过 **Tabbit CLI**（Playwright API 封装）在真实 Chromium 中执行，任务名固定为 **`BiMail QA`**；不引入额外 npm 依赖。

## 0. 前置

```bash
# 1) Lead 的 dev 栈在跑：API :8787（不要重启/占用 5173/8787）
curl -s http://127.0.0.1:8787/api/health          # {"ok":true}

# 2) 自起独立 Vite（验收用干净 localStorage 的多个 origin 模拟多台设备）
cd /Users/leon/Documents/BiMail
npx vite --port 5174 --strictPort &                # 设备 A（创作者）
npx vite --port 5175 --strictPort &                # 设备 B（笔友）
npx vite --port 5176 --strictPort &                # 第三设备（换座/清缓存/已消费邀请）

# 3) 生产验收
npm run build
npx vite preview --port 4173 --strictPort &        # CSP / 请求数 / LCP / INP
```

> `browser.newContext()` 在本 Tabbit 运行时被拒绝；用**不同 origin**（不同端口）或「localStorage 快照 → 清空 → about:blank → 打开邀请 URL → 还原快照 → reload」模拟第二身份。
> **注意**：仅改变 URL 的 hash 不会重载页面；需要 `about:blank` 中转，或改变 path 后整页导航，才能让 app 重新读取 fragment / 重新 boot。

## 1. 两身份主流程

1. 打开 `http://localhost:5174/`，清空 `localStorage` 后刷新：应出现**凭据失效屏**（`需要你的钥匙才能回到这堵墙。` + 「还没有墙，就先建一堵。」+ 输入框 + 「建一堵新墙」；空输入时**不出现**「进入」）。
2. 点「建一堵新墙」→ 恢复密钥屏（32 字符 Base32，等宽；复制/下载 .txt/我已保管）→「我已保管」→ 空墙（创建者文案 + `#i=<32>` 邀请链接纯文本行 + 首访提示）。
3. 输入文字并 `Ctrl+Enter` 寄出；断言流中出现日分组与留言、首访提示消失、无任何"成功/已读/在线"提示。
4. 从 `localStorage['bimail.invite'].token` 取邀请 token，在 `:5175`（清空 localStorage）打开 `http://localhost:5175/#i=<token>`，占座 → 恢复密钥屏 → 确认 → 断言封缄的信以「笔友：」呈现、顶部派生语「11月12日，两位笔友到齐。」（服务端 UTC 日期可能早一天，属已知取舍）。
5. 用 B 回信；A 整页重载后应看到「笔友：」回信。

## 2. 输入规格（Composer）

在墙内聚焦 `[data-testid="composer-input"]` 后逐项断言（详见 `docs/ACCEPTANCE.md` §2 DoD 1–8）：

- `Enter` 换行；`Ctrl/Cmd+Enter` 寄出；
- 合成 IME：`compositionstart` + `keydown Enter{isComposing:true}` → 不寄出、值保留；`compositionend` 后返回键不寄出；
- 空态：`.composer button` 数 = 0、无字数计；
- 非空：`.composer-word`（寄出）+ `.composer-shortcut` 出现，字号与正文同为 17px；
- 连按两次 `Ctrl+Enter` 只产生一条；纯空白静默忽略；
- 粘贴含 `text/html`（`<b>`、`<img>`）的内容 → 只保留 `text/plain`；
- 8001 码点输入 → 截断 8000 + 「已超出 1 字，未纳入。」；
- 草稿：输入后等 300ms 写 `bimail.draft`；reload / 离开页面 / 断网 reload 后回填；寄出后清空；
- 离线：CDP `Network.emulateNetworkConditions{offline:true}` 后连发 5 条 → 5 条 queued + 「尚未寄出，联网后自动寄出。」；点该行 → 「撤回这段未寄出的文字。」→ 撤回；恢复网络后自动按序 flush，无重复。

Tabbit 关键片段：

```js
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
  offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
});
// …写入 + Ctrl+Enter ×5…
await cdp.send('Network.emulateNetworkConditions', {
  offline: false, latency: 20,
  downloadThroughput: Math.round(10 * 1024 * 1024 / 8),
  uploadThroughput: Math.round(5 * 1024 * 1024 / 8),
});
```

## 3. 设置面 / 导出 / 销毁 / 换座

- 设置入口：流底部 `.settings-entry` 的「设置」词（非齿轮）→ 设置面四行固定顺序。
- 查看恢复密钥：点击 → 「再次确认：现在显示这把钥匙。」→「确认」→ `.recovery-key` 展示且**不再自动隐藏**；关闭再进入时不提前显示。
- 导出：拦截 `URL.createObjectURL` 与 `a.click` 捕获 Blob 文本与文件名，核对：

  ```
  BiMail · 导出于 2026年11月12日
  —— 11月12日
  我：……
  你：……
  ```

  文件名 `bimail-YYYY-MM-DD.txt`；自己的留言 `我：`、笔友 `你：`。
- 销毁：设置面「离开并销毁我的文字」→ 确认行「你的文字将被删除，这堵墙会停下。不可恢复。」→ 自己的留言消失、对方可读、`state=closed`、座位不释放、无输入框、行「这堵墙已经停下。」。
- 换座：清空设备 localStorage → 凭据屏 → 输入旧钥匙（允许小写+空格分组）→ 「进入」→ 回原墙；断言旧 uid `list_entries` 空页、`wall_state` 409 `no_seat`。

## 4. 安全 / 网络 / 性能（生产预览 4173）

```js
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });      // 中低端机 CPU
await cdp.send('Network.emulateNetworkConditions', {                 // 4G
  offline: false, latency: 40,
  downloadThroughput: Math.round(10 * 1024 * 1024 / 8),
  uploadThroughput: Math.round(5 * 1024 * 1024 / 8),
});
// LCP：注入 PerformanceObserver({type:'largest-contentful-paint', buffered:true})
// INP：PerformanceObserver({type:'event', durationThreshold:16, buffered:true}) 的 interactionId 事件时长
```

断言：

- 无 `webSocketCreated`；稳定后静置 10s，`requestWillBeSent` 数 = 0（无轮询/Realtime）；
- 首屏资源仅同源 HTML/JS/CSS（`check:budget`：JS 37.69KB gzip、CSS 2.07KB、请求 2、零图片/字体/第三方）；
- CSP meta 存在、无内联脚本、无 CSP violation；
- LCP ≤1s、INP ≤100ms（本次实测 324/348ms、64ms）。

## 5. 视觉 / 无障碍

```js
await page.emulateMedia({ colorScheme: 'dark' });          // 暗色跟随系统，无开关
await page.emulateMedia({ reducedMotion: 'reduce' });      // .entry--new animation: none
await page.setViewportSize({ width: 390, height: 844 });   // 移动端
```

- 移动端：`(pointer:fine)` 为 false 时不自动聚焦；输入区 `bottom=844` 吸底；版心 350px、条目 86%（我靠右 / 笔友靠左，`margin-left:auto` / `margin-right:auto`），文本仍左对齐；
- 键盘 Tab：设置 → 输入框 → 寄出词；`:focus-visible` 为 1px 中性描边（textarea 按 SPEC §3.2/§4.4 裁定无描边）；
- 暗色/亮色下抽查 computed color 与 `--paper/#171614`、`--ink-mine/#E8E4DC`、`--ink-theirs/#D8D3C9`、`--ink-faint/#9A958B`；
- 全站无「在线/正在输入/已读/同步中/送达/成功/刚刚/分钟前/今天/昨天」等过程信号；无 `<a>` 内容链接、无 `<img>`、无弹窗/Toast/角标。

## 6. 截图

Tabbit `page.screenshot()` 返回 artifact 回执，取 `result.nextAction.path` 后 `cp` 到 `docs/evidence/`，命名见 `docs/ACCEPTANCE.md` §7。注意：移动端截图需 `page.setViewportSize({width:390,height:844})`（若同时用 CDP `Emulation.setDeviceMetricsOverride`，Playwright 截图尺寸会按其 viewport 输出；本目录手册以 setViewportSize 为准）。
