obsidian-terminal v3.28.0
=========================

Upstream    https://github.com/polyipseity/obsidian-terminal
Author      polyipseity
License     AGPL-3.0-or-later（见 LICENSE.txt）——注意：AGPL 代码并入后，
            聚合插件整体按 AGPL-3.0-or-later 对待；本仓库其余模块多为
            GPL-3.0/MIT，合并作品不对外分发（个人库内使用）。
Version     3.28.0（commit 8cbff893，2026-11-03 收编）

What it does
------------
库内终端：xterm.js v6 多渲染器（webgl/canvas/dom），四种 profile
（default/select/integrated/external），Windows 集成配置走 ConPTY 或
Windows-PTY（Python 3.9+ 运行时自检、pip 安装 pywin32 等依赖，见
win32-doctor），文件夹右键与终端互跳，多窗口（popout）支持。

Integration verdict: require 桥接**源码**（同 advanced-uri/vault-explorer）
--------------------------------------------------------------------
上游钉 @polyipseity/obsidian ~1.8.7 的 obsidian 类型，与宿主 1.14.4 漂移；
且源码大量依赖 vendor 子库。故不进宿主 tsc 程序，esbuild 从 TS 源码直接
打包（`require("../modules/my-terminal/src/main")`）。

工具链决策（2026-11-03）：**不用上游 bun 链，统一走宿主 yarn PnP + 根
esbuild**。上游原生流程是 `bun install`（postinstall 先构建 vendor 子库，
其构建脚本硬编码 `bun x @typescript/native tsc` 发声明文件）+ 自有
esbuild 出 main.js。合并版改为：

- vendor 子库 obsidian-plugin-library（钉 b6eb90c5）以**纯源码**随仓收进
  `vendor/`（无 .git、无构建产物），根 esbuild 直接从其 TS 源码打包；
- 子库与终端的全部运行时依赖并入根 package.json（PnP 统一解析，
  ~29 个新包：xterm addons×7、capacitor、dompurify、espree、lucide、
  simple-icons、valibot、immutable、tmp-promise 等）；
- 终端源码**零改动**——上游客器风格（.js 后缀相对导入、import attributes、
  `declare module "*.py"`）经 esbuild 原样处理。

根 esbuild.mjs 的 terminal 适配
--------------------------------
1. `terminalSveltePlugin`：子库有 find.svelte 组件与 src/svelte.svelte.ts
   （$state runes 模块）。esbuild-svelte 默认 filter 只认 `\.svelte$`，
   此插件以 `/my-terminal[\\/]vendor.*\.svelte(?:\.ts)?$/` 作用域编译
   `.svelte.ts`（moduleCompilerOptions generate client），注册在根
   sveltePlugin 之前。上游的 PACKAGE_ID 定制 cssHash 未带（默认哈希无碰撞）。
2. `terminalPyPlugin`：`.py` → text loader（同上游 esbuild-compress 语义，
   无压缩）。运行时由插件写进 manifest.dir（= 宿主真插件目录）再由 python
   执行，sidecar 落点不变。
3. locales：子库 assets/locales + 终端 assets/locales（~50 语言）全部
   构建期内嵌（与上游一致）。

Known deviations from upstream
-------------------------------
1. **inject 计时器包装未启用**：上游 esbuild `inject` 把 setTimeout/
   setInterval/requestAnimationFrame 路由到 `self.activeWindow`（多窗口
   正确性）。该机制是全 bundle 级的，会改变聚合插件其他模块的计时器行为，
   故不带。Obsidian 的 `activeWindow` 全局本就存在，主窗口行为不变；
   popout 窗口里的终端若出现计时器怪象，再考虑按 importer 作用域实现。
2. 上游 esbuild-compress 的 JSON/lazy 压缩未带：包体大几 MB，行为一致。
3. `esbuildPluginGlobals({ moment })` 未带：上游把全局 moment 映射到 npm
   moment 包；宿主直接用 Obsidian 提供的 window.moment，语义一致。
4. manifest.version 由 descriptor 覆盖为上游 3.28.0（其内部语义读
   manifest.version，同 ARDH/CAL/vault-explorer 先例）；id 用 my- 前缀
   `my-terminal`（设置页命名空间隔离），legacyId 同值供迁移与查找。

Settings migration
-------------------
descriptor `migrateFrom: "terminal"`：若库里装有独立版 terminal 插件，
首次启用本模块时其 data.json（profiles、默认配置等）一次性导入数据片。
