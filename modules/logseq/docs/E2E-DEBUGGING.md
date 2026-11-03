# E2E Debugging — 启动 Obsidian 进行调试

最后验证：2026-10-04（测试实例 CDP 9288 启动、Playwright 接入、双插件加载全部通过）。

本文档描述本仓库如何启动一个**隔离的** Obsidian 实例用于 E2E 调试/回归验证：不触碰用户主库实例、可通过 CDP 编程控制、可反复复用。

## 架构总览

```
Node 脚本（宿主进程）
 ├─ 1. 隔离准备：专用 profile + 测试库
 ├─ 2. 启动：Obsidian.exe + CDP 调试端口
 ├─ 3. 就绪等待：轮询 /json/version
 ├─ 4. 接入：Playwright connectOverCDP（或 raw-CDP 后备）
 ├─ 5. 操作：evaluate 探针 / mouse / keyboard
 └─ 6. 清理：只杀测试实例，绝不碰主库实例
```

## 1. 隔离策略（核心）

Electron 的单实例锁是 **per user-data-dir**：用独立 `--user-data-dir` 启动就是一个完全独立的实例，与用户正开着的主库互不影响。

| 用途 | 路径 |
| --- | --- |
| 测试库 | `E:\HOME\Local\logseq-e2e-vault` |
| 专用 profile | `E:\HOME\Local\logseq-e2e-obsidian-profile`（放库外，避免被索引） |

启动前由 `prepareTestProfile()`（见 `tests/e2e/obsidian-process.mjs`）完成：

1. 重置 workspace 状态——删除 profile 和测试库 `.obsidian/` 下的 `workspace.json`（`*.bak`），防止上一轮的叶子窗口跨会话累积；
2. 写入 profile 的 `obsidian.json` 注册表——只注册测试库且 `open: true`，启动后直达测试库。

## 2. 启动命令

```powershell
D:\programs\Obsidian\Obsidian.exe `
  --user-data-dir=E:\HOME\Local\logseq-e2e-obsidian-profile `
  --remote-debugging-port=9288 `
  obsidian://open?path=E:\HOME\Local\logseq-e2e-vault
```

要点：

- `detached + unref` 派生（脚本退出不影响实例）；
- **先杀旧测试实例再 spawn**——还在退出的实例持有单实例锁，新实例会静默退出；
- 一键脚本：`node tests/e2e/_spawn-9288.mjs`（spawn + 就绪等待 + 超时报错）。

## 3. 就绪等待

轮询 `http://127.0.0.1:9288/json/version` 直到返回 200（上限 60–90 秒）。这是唯一可靠的「Obsidian 已可操作」信号；不要用固定 sleep 代替。

## 4. 接入控制（两种驱动）

### a. Playwright connectOverCDP（当前主用）

```javascript
import { chromium } from '@playwright/test';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9288');
let page = null;
for (const c of browser.contexts())
  for (const p of c.pages()) if (p.url().startsWith('app://')) page = p;
if (!page) throw new Error('no Obsidian page target');

await page.bringToFront(); // 必须！后台窗口点击会丢（is-hidden-frame）
```

### b. raw-CDP（后备，`tests/e2e/cdp.mjs`）

当 Playwright 的 WS 链路在本环境不可靠（socket hang up / 502 / 帧不达）时的替代：手写 RFC 6455 握手 + 帧解析，attach 到 **browser-level** socket，会话路由用 legacy `Target.sendMessageToTarget` 信封（`flatten: true` 下带 sessionId 的命令会被静默丢弃）。

## 5. 操作与探针模式

标准探针脚本模板：

```javascript
// 1) 重载插件，加载最新构建
await page.evaluate(async () => {
  await window.app.plugins.disablePlugin('obsidian-logseq');
  await window.app.plugins.enablePlugin('obsidian-logseq');
});
await sleep(1500);

// 2) 打开目标文件
await page.evaluate(async (f) => {
  await window.app.workspace.openLinkText(f, '', false);
}, FILE);
await page.waitForSelector('.block-editor-container', { timeout: 60000 });
await sleep(4000);

// 3) 探针：读状态（DOM rect 计算必须全部在 evaluate 内部完成——
//    evaluate 的返回值是序列化值，不能把 DOM 元素带出来）
const state = await page.evaluate(() => { /* ... */ });

// 4) 输入：真实鼠标/键盘事件
await page.mouse.click(x, y);
await page.keyboard.press('Escape');
```

## 6. 清理（安全红线）

- **绝不 `taskkill /IM Obsidian.exe`**——会连同用户主库实例一起杀掉；
- `killTestVaultObsidian()`（`tests/e2e/obsidian-process.mjs`）：只匹配 **CommandLine 含 `remote-debugging-port=9`** 的 Obsidian.exe 进程，逐 PID tree-kill，并等待完全退出（给下一次 spawn 让出单实例锁）；
- `cdp.mjs` 里导出的 `killAll()` 会杀**所有** Obsidian——仅限「确认主库已关闭」的极端场景，正常流程禁止使用。

## 7. 调试前部署清单

1. 构建验证链：`vitest run` + `tsc -noEmit -skipLibCheck` + `node esbuild.mjs production`；
2. 部署到测试库 `.obsidian/plugins/obsidian-logseq/`（三件套：`main.js` / `manifest.json` / `styles.css`，覆盖复制）；
3. 插件 id 陷阱：breadcrumb-nav 插件的 manifest id 是 `breadcrumb-nav`（不是文件夹名 `obsidian-breadcrumb-nav`）——`community-plugins.json` 的启用列表必须与 manifest id 一致，否则插件静默不加载；
4. 测试库需要真实文件副本 + 图片资产（例如 `ai-library/尚硅谷大模型技术之深度学习2.2.0-logseq-clean.md` 及其 `_assets/`）。

## 8. 已知坑速查

| 现象 | 原因 | 对策 |
| --- | --- | --- |
| 点击全部丢失 | 后台窗口 is-hidden-frame | 先 `page.bringToFront()` |
| 新实例秒退 | 旧实例仍持有单实例锁 | 杀后等完全退出再 spawn |
| 修复「不生效」 | 测试库里的构建过期 | 重新部署后（grep 特性字符串核对）再探 |
| 探针找不到目标块 | 文档自带大量 `collapsed:: true`，新实例初始全折叠 | 用视图 API（`toggleCollapse`）沿祖先路径精准展开；不要盲点 caret（坐标会在展开过程中失效） |
| 点击落在错误位置 | 坐标在视口外，Playwright 自动滚动不可控 | 每步重新测量几何，确保点击点在视口内；超高元素（含整棵子树的块）要对目标子元素 `scrollIntoView` 而非整个 wrap |
| 意外进入缩放视图 | zoom 状态跨 `openLinkText` 残留 | 探针前 `view.zoomTo(null)` 重置 |
| 大 wrap 居中后标题跑出视口 | wrap 含整个子树（几千 px），center 对齐的是子树中心 | 点击块标题要定位 `:scope > .block-main > .block-content` |
| 打开文件把所有代码块移到底部 | 同缩进围栏被误判为顶层 raw 块（已在 `2016c85` 修复） | 回归测试：`tests/sameDepthFence.test.ts` |

## 9. 常用命令速查

```powershell
# 启动测试实例（spawn + 等就绪）
node tests/e2e/_spawn-9288.mjs

# 回归套件（按需）
node tests/e2e/_bcn-parity.mjs          # 面包屑交互
node tests/e2e/_mix-nolang-style.mjs    # 混合块无语言两态样式
node tests/e2e/_mix-prefix-edit.mjs     # 混合块三区域编辑
node tests/e2e/_pure-code-regression.mjs # 纯代码块回归

# 临时探针（内联 Playwright）
node -e "import('@playwright/test').then(async ({chromium}) => { /* ... */ })"
```

## 10. 主库直接调试

**不可行**：主库（用户日常库）插件数量大，历史探测中出现过插件加载失败（`enablePlugin`/`loadPlugin` 静默无效）的情况；且调试有改动用户真实数据的风险。

标准替代：**测试库 + 真实文件副本**——把主库里要复现的文件（及图片资产）复制到测试库，在测试实例上复现、修复、回归。

`tests/e2e/use-vault.mjs` 提供了切换「最后打开的库」的能力（备份/恢复 `%APPDATA%\obsidian\obsidian.json`），仅在确有需要操作主库注册表时使用，用完必须 `--restore`。