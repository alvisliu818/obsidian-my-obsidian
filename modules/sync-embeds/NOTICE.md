Sync Embeds v2.0.3
==================

Upstream    https://github.com/uthvah/sync-embeds
Author      uthvah (Verity)
License     MIT (see LICENSE, Copyright (c) 2025 Verity) — the aggregate
            plugin is GPL-3.0; MIT is permissive and may be redistributed
            inside it provided this notice and the upstream license travel
            with the code.
Version     2.0.3, minAppVersion 0.15.0

What it does
------------
把 Obsidian 的静态嵌入（![[Note]] / ![[Note#Header]]）变成**双向实时同步块**：
在嵌入处直接编辑源笔记（或指定标题段），改动即时写回原文件，无需打开源
文件。核心能力：真实编辑器实例 reparent 到当前文档（非只读预览）、完整
快捷键支持（复选框/格式化/列表/标题）、标题段嵌入的视口限制与层级保护、
`{{date}}` 等动态路径（日记/按标题）、自定义显示名、嵌入间距/高度/折叠
属性等显示设置、命令拦截（在嵌入内执行 Obsidian 命令）。

Integration verdict: require bridge (source is CommonJS)
---------------------------------------------------------
上游源码是 6 个纯 JavaScript 文件（CJS：`require` / `module.exports`），无
TypeScript、无类型声明，进不了宿主的严格 tsc 程序。按收编判据走 require 桥：
`const SyncEmbedsPlugin = require("../modules/sync-embeds/src/main")`
（上游是 `module.exports = class`，直接取模块导出，无 `.default`）
——不进宿主 tsc，运行时照常打进 bundle。`obsidian` 已 external；唯一外部
依赖 `monkey-around`（上游用于命令拦截的 `around()`）根 package.json 已有
（^3.0.0，多个模块共用），无需新增依赖。

Changes relative to upstream
----------------------------
1. **数据片**：插件用 `this.loadData()` / `this.saveData()` 存设置（默认键
   embedHeight / maxEmbedHeight / collapsePropertiesByDefault 等），宿主在
   startModule 时把这些调用影子化到 `settings.modules["sync-embeds"].data`
   ——与所有收编模块相同，源码无需改动。
2. **manifest**：宿主传给模块的 manifest 是浅拷贝（`id` / `dir` 固定为宿主
   值 `obsidian-my-obsidian`），descriptor 的 `manifest: { version: "2.0.3" }`
   保持上游版本语义；模块自身 manifest.json 保留作出处与版本记录。
   `migrateFrom: "sync-embeds"`：老用户独立版 data.json 首次启用时自动迁入
   数据片（宿主 migrateStandaloneSettings 机制）。
3. **Styles**：上游 `styles.css`（470 行，`.sync-*` / `.metadata-container`
   等前缀）整段并入根 `styles.css` 的 Sync Embeds 分段；模块目录保留副本
   供出处核对，根构建对模块目录的 css import 按 empty 处理。
4. **无源码改动**：6 个 src/*.js 与上游逐字节一致（CJS 源码直连 require 桥，
   不需要改导入路径或依赖）。

本模块的设置入口由宿主内嵌渲染（单 id 策略：addSettingTab 被截获进
capturedTabs，通过宿主设置页「其他模块」区直达），不再单独成栏。
