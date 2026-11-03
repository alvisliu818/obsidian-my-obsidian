# Obsidian Browser

把完整的 Chromium 浏览器搬进 Obsidian。基于 Electron `<webview>`，每个标签页跑在独立的渲染进程中 —— 不受 `X-Frame-Options` / CSP 限制，Google、GitHub、知乎这类拒绝被 iframe 嵌入的站点都能正常打开。

思源笔记同名插件（[siyuan-plugin-browser](https://github.com/alvisliu818/siyuan-plugin-browser)）的 Obsidian 移植版，架构与功能对齐。

> ⚠️ 仅桌面端可用。`<webview>` 是 Electron 专有能力，移动端没有。

## 功能

- **多标签页浏览**：标签栏、新建 / 关闭 / 中键关闭 / 拖拽滚动，每个标签一个独立 webview
- **两种标签页模式**：
  - `插件内页签条`（默认）—— 所有页面在一个 Obsidian 标签里，页签条由插件绘制
  - `Obsidian 原生标签页` —— 每个页面占一个 Obsidian 标签，可拖到分栏、`Ctrl/Cmd+W` 关闭、随工作区（workspace.json）自动恢复，标题显示在其他笔记旁边
  
  在设置里切换，切换后重新打开浏览器视图即可
- **地址栏**：自动补全协议（输入 `example.com` → `https://example.com`），非网址回退到搜索引擎（Google / Bing / 百度 / DuckDuckGo / 自定义）
- **导航控制**：后退 / 前进 / 刷新 / 强制刷新 / 停止 / 主页
- **页内查找**：查找栏 + 匹配计数 + 前后跳转
- **右键菜单**：新标签打开、复制链接、复制图片、图片 / 页面另存到仓库、复制选区、查看源代码、检查元素
- **网页摘录**：Readability 正文提取 → Markdown → 存入仓库（可配目录 / frontmatter / 模板 / 标签 / 图片本地化），也支持只摘录选区
- **书签 / 历史 / 下载** 三个侧栏视图：标签分组、日期分组、搜索、下载进度与落到仓库
- **内置广告过滤**：按 Adblock 元素隐藏规则注入 CSS，支持自定义规则
- **Chrome 扩展支持**：安装未打包目录 / CRX / ZIP / URL，按 match pattern 注入内容脚本与 CSS，提供 `chrome.storage` / `runtime` / `i18n` 垫片，工具栏图标与 popup
- **链接接管**：笔记里的 `http(s)://` 链接点击后在插件内打开，右键菜单也有入口（可配排除站点）
- **新窗口拦截**：`target="_blank"` 与 `window.open()` 在新标签页打开，而不是甩给系统浏览器
- **会话恢复**：关闭 Obsidian 时保存标签页，下次自动恢复

## 安装

### 手动安装

1. 下载或构建得到 `main.js`、`manifest.json`、`styles.css`
2. 放到 `<vault>/.obsidian/plugins/obsidian-browser/`
3. 重启 Obsidian，在 **设置 → 第三方插件** 中启用

### 从源码

```bash
npm install
npm run build   # 类型检查 + 打包，产出 main.js
```

把 `main.js`、`manifest.json`、`styles.css` 复制到插件目录即可。

## 使用

| 操作 | 默认快捷键 |
| --- | --- |
| 打开浏览器 | `Ctrl/Cmd + Alt + B` |
| 新建标签页 | `Ctrl/Cmd + Alt + T` |
| 关闭标签页 | `Ctrl/Cmd + Alt + W` |
| 刷新 / 强制刷新 | `Ctrl/Cmd + Alt + R`（+ `Shift`） |
| 后退 / 前进 | `Ctrl/Cmd + Alt + ←/→` |
| 聚焦地址栏 | `Ctrl/Cmd + Alt + L` |
| 页内查找 | `Ctrl/Cmd + Alt + F` |
| 摘录当前页为笔记 | `Ctrl/Cmd + Alt + S` |

书签 / 历史 / 下载通过命令面板（"显示书签" 等）打开，拖到侧边栏即可常驻。

## 架构

```
main.ts (Plugin)                     BrowserView (ItemView)
├── DataStore (单一 data.json)        ├── BrowserTab × N
├── Bookmarks/History/Downloads       │   ├── Toolbar (地址栏/导航/查找栏)
├── ExtensionHost (CRX/注入/垫片)     │   └── WebviewController (<webview>)
├── BrowserSettingTab                 └── PopupLayer (扩展 popup)
└── 命令 / ribbon / 链接接管

WebviewController 事件路由
  did-navigate / did-navigate-in-page / dom-ready / page-title-updated
  page-favicon-updated / found-in-page / will-navigate / did-fail-load
  ipc-message (preload: 新标签意图 + document_start 内容脚本)
```

每个标签页是一个 Electron `<webview>`，运行在独立 Chromium 进程中。插件还注册了 session 的 `will-download` 钩子，把下载直接落到仓库里。

## 已知限制

- **仅桌面端**：依赖 Electron `<webview>`
- **扩展无后台页**：background / service worker 不执行，依赖它们的扩展只能部分工作；`chrome.storage` 垫片按扩展 + 域名存 localStorage
- **广告过滤只做元素隐藏**：渲染进程拿不到网络层，AdGuard 这类以拦截为主的扩展无法工作
- **Cookie 共享**：同一会话分区内所有标签共享登录态（可在设置里改分区名获得全新登录态）
- **健康检查**：Obsidian 把标签拖到另一个分栏时 Electron 会销毁 guest，插件每 2 秒探测一次并自动重建（加载期间不探测，避免误判）

## 许可证

MIT
