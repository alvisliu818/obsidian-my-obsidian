Advanced URI v2.2.1
===================

Upstream    https://github.com/Vinzent03/obsidian-advanced-uri
Author      Vinzent (Vinzent03)
License     MIT (see LICENSE) — the aggregate plugin is GPL-3.0; MIT is
            permissive and may be redistributed inside it provided this
            notice and the upstream license travel with the code.
Version     2.2.1, minAppVersion 1.5.7

What it does
------------
Obsidian URI 的增强：obsidian://advanced-uri（旧版双重编码）与
obsidian://adv-uri（v1.44+）两个 protocol handler，支持打开/新建文件、
写入/追加/前置内容（data/new/append/prepend + heading/block/line 定位）、
打开指定标题/块/行/列/偏移、执行命令、搜索与替换、打开设置页、
工作区保存与加载、canvas 节点与视口、插件启停、UID（frontmatter uid）、
日记（daily）与剪贴板写入等；配套一组「Copy URI for …」命令与
文件右键菜单，以及 x-success/x-error 回调。

Integration verdict: require bridge (same as media-extended / CAL)
--------------------------------------------------------------------
上游 tsconfig 非 strict 且其构建链只有 esbuild（不过 tsc），直连会在宿主
严格 tsconfig 下报 175 处类型错误：约 1/3 是 obsidian 类型版本漂移
（getActiveViewOfType(MarkdownView) 重载在宿主 View.file: TFile | undefined
签名下失配、internalPlugins 形状收窄、ObsidianProtocolData 无索引签名），
其余是 strictNullChecks / noImplicitReturns 噪音。按收编判据走 require 桥：
不进宿主 tsc 程序，类型由模块自带 tsconfig（钉 obsidian@1.13.1，上游声明
版本）独立校验；运行时照常打进 bundle（`obsidian` 与 `obsidian/canvas`
均 external，后者需在根 esbuild.mjs 显式列出——external 按包路径精确匹配，
不覆盖子路径）。

Changes relative to upstream
----------------------------
1. 去外部依赖：
   - `obsidian-community-lib` 仅用到 `stripMD`（去 .md 后缀一行正则），
     内联进 src/utils.ts 并导出；src/main.ts 改从 ./utils 引入。
   - `uuid` 仅用到 `v4()`（给文件写 frontmatter uid），改为
     `crypto.randomUUID()`（Electron/Chromium 原生支持）。

2. `src/modals/general_modal.ts` — 上游按 baseUrl 约定写的是
   `import AdvancedURI from "src/main"`；宿主 tsconfig 的 `src/*` 别名已被
   obsidian-git 占用（同 code-link 收编时的问题），改为相对导入 `../main`。

3. 修 6 处上游遗留类型瑕疵（上游构建不过 tsc，属存量问题；全部仅加断言
   /收窄签名，运行时行为不变）：
   - src/main.ts decodeParameterValues：Parameters 接口无索引签名，原泛型
     约束 `T extends Record<...>` 在严格模式下不成立——改为非泛型方法 +
     内部 Record 视图读写；3 处 protocol handler 调用点把
     ObsidianProtocolData 断言为 Parameters（运行时键集一致）。
   - src/handlers.ts handleBookmarks：openmode 的 "silent"/"window" 等运行
     时合法值不在 getLeaf 的 boolean | PaneType 签名里，加断言；
     PaneType 加入 obsidian 导入清单。

4. Styles: 上游 `styles.css` 并入根 styles.css 的
   `Advanced URI (modules/my-advanced-uri)` 分段（选择器均带
   `.advanced-uri-` 前缀，无冲突）。

5. manifest.json / versions.json / .github / docs / CHANGELOG / pnpm-lock
   不随迁：模块不再是独立插件，由根 main.ts 的 descriptor 注册（见下）。
   模块自带 package.json 只含 devDeps（obsidian@1.13.1 / typescript /
   tslib），pnpm 安装（注意：宿主根声明 packageManager=yarn，需
   COREPACK_ENABLE_STRICT=0）；校验命令 `pnpm exec tsc -p tsconfig.json
   --noEmit`（在模块目录内）。

Manifest / id
-------------
上游 id `obsidian-advanced-uri`；按 2026-10-30 约定模块以 `my-advanced-uri`
注册（descriptor 的 manifest.id 覆盖 —— 设置页 id 与命令命名空间隔离），
`legacyId: "my-advanced-uri"` 保持插件表可查，`migrateFrom:
"obsidian-advanced-uri"` 走宿主 migrateStandaloneSettings，独立版遗留的
data.json 首次启动时一次性迁入。
protocol handler（obsidian://advanced-uri / adv-uri）按 handler 名全局注册，
不依赖插件 id，URI 语义与独立版完全一致。
