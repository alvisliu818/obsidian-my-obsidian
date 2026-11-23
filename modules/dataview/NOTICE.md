Dataview 0.5.70
================

Upstream    https://github.com/blacksmithgu/obsidian-dataview
Author      Michael Brenan (blacksmithgu)
License     MIT (see LICENSE.txt) — the aggregate plugin is GPL-3.0; MIT is
            permissive and may be redistributed inside it provided this notice
            and the upstream license travel with the code.
Version     0.5.70 (upstream master@5ad0994), minAppVersion 0.13.11

What it does
------------
DQL 查询与 dataviewjs 代码块（TABLE / LIST / TASK / CALENDAR）、内联字段
（`key:: value` / `[key:: value]`）渲染、页面/任务/列表语义索引。收编体量：
69 源文件，DQL 引擎 + Preact 渲染层 + 索引 worker。

Integration verdict: require bridge + 解析归一（用户选定 B 方案，2026-11-23）
---------------------------------------------------------------------------
上游自有 tsconfig（部分 strict：noImplicitAny/strictNullChecks 等单项开但
strict 总闸关、baseUrl 裸导入、jsxFactory: h + preact），进不了宿主的严格
tsc 程序 → require 桥：`require("../modules/dataview/src/main").default`，
不进宿主 tsc，运行时打进主 bundle。类型由模块自带 tsconfig 独立校验
（`yarn tsc -p modules/dataview/tsconfig.json --noEmit`，已清零，见下）。

**解析归一（与其它收编模块的关键差异）**：dataview 的解析/缓存两条链路上收
到统一索引 daemon——

1. **daemon 侧**（modules/unified-search/src/daemon/dvMeta.ts + dvImport.ts）：
   dvMeta 复刻 dataview parsePage 消费的 CachedMetadata 形状（frontmatter/
   headings/links/embeds/tags/sections/listItems），随后调 **dataview 自家
   parsePage**（require 桥进 MyKernel.cjs；parsimmon 文法/luxon 类型化与上游
   一字不差，obsidian 仅类型引用擦除后 daemon 无依赖）→ Transferable +
   Map/Set JSON 标记层（shared/dvSerialize）→ daemon 库 `dv_pages` 表
   （不进 TABLE_NAMES，全量重建不清，同 file_props 判例）。sync/turbo/
   upsert 管线随主索引同批写；`dvPage`/`dvPages`/`dvPrune`/`dvRecreate`
   直通 op 供渲染端取数。
2. **渲染端**（src/dataviewBridge.ts，宿主 onload 前装原型垫片）：
   - `FileImporter.prototype.reload` → daemon `dvPage` 取现成页面数据
     （miss/失败/排除目录逐文件回落上游 worker 路径）；
   - `LocalStorageCache.prototype.*`（上游 localforage/IndexedDB）→
     `dvPages` 冷启动快照 + daemon 转发，daemon 不可达回落 IndexedDB。
   - 客户端发现：md-editor 模块实例的 `daemonIndex`（启动窗轮询 5s）。
   dataview 渲染端从此零解析、零 worker 工作、零 IndexedDB；链接解析仍在
   finish()→canonicalize() 用渲染端 metadataCache（正确性不变）。
3. **兼容别名**：模块启动后宿主在 `app.plugins.plugins` 上挂守卫式只读
   `dataview` 别名（指向 live 实例；独立版 dataview 仍启用时键已存在不覆盖，
   onunload 摘除）——hearth 的 dataview 卡片（getDataviewApi）、tasknotes 等
   外部插件与用户 dataviewjs 的 `app.plugins.plugins.dataview.api` 查找不断。
4. **数据片**：`migrateFrom: "dataview"`——独立版 data.json 首启迁入
   `settings.modules["dataview"].data`；设置页由宿主内嵌渲染（capturedTabs）。

**daemon 缺席（移动端/内核停机）时自动整体回落上游自解析路径**：worker 代码
照常打包（esbuild `web-worker:` 插件移植 rollup-plugin-web-worker-loader 的
inline+forceInline 语义），IndexedDB 缓存代码原样保留——dataview 行为退化为
独立版原样。desktopOnly: false。

Changes relative to upstream（全部类型层，零运行时语义变化）
-----------------------------------------------------------
1. `api/data-array.ts` first()/last()：`undefined` 返回与 `T` 签名矛盾
   （上游 check:false 从不门禁）→ `(undefined as T)` 断言。
2. `src/main.ts` settings 字段：obsidian 1.14 基类新增同名属性触发 TS2612 →
   显式 `undefined` 初始化器（ES2022 useDefineForClassFields 下 emit 语义与
   上游空声明完全一致，loadSettings 仍整体赋值）。
3. `src/ui/lp-render.ts`：`tokenClassNodeProp` 在 @codemirror/language
   6.10+ 类型里已移除 → import 保持 external + `@ts-expect-error`。运行时取
   Obsidian 自带模块的同名导出；若 Obsidian 未来移除该导出，值为 undefined，
   inline-code 识别降级（上游运行时路径不变）。
4. `src/typings/window-cm5.d.ts` 新增：window.CodeMirror（CM5 全局）形状。
5. 模块 tsconfig：`skipLibCheck: true`（parse5 等三方 lib 的模块解析噪音）
   + `exclude: src/test/**`（上游 jest 套件不搬运：@types/jest/rollup-jest
   依赖链不随收编引入；语义保真由 vitest 的 dvMeta/dvImport round-trip 测试
   承担，37 例全绿——frontmatter 日期类型化、任务勾选态/块 id、括号内联
   字段、链接 display、embed 分流均经 JSON 往返验证）。

已修复的上游 dvMeta 对齐点（不是上游改动，是我们形状层的验收结论）
-----------------------------------------------------------------
- 页面级 `fields` 只收 frontmatter + 非任务列表项的上升字段；任务行的
  `[due:: …]` 留在任务项自己的 fields（parseLists Pass 2 上游语义）；
- 裸中段 `key:: value` 不是字段（extractInlineFields 只认括号包裹与整行）。

已知的形状近似（daemon 侧 dvMeta 对 Obsidian metadataCache 的偏差清单）
-----------------------------------------------------------------------
- YAML 用 js-yaml CORE_SCHEMA（YAML 1.2 core：日期保持字符串、无 1.1 的
  yes/no 布尔），对齐 Obsidian 的 yaml 包行为；破损 YAML → 无 frontmatter；
- 列表项续行按缩进近似，flush-left lazy continuation 会切成新段落；
- setext 标题（文字下一行 ---）按 ruling 处理；
- 引用块内列表产出 listItems 但 section 归 quote（containingListId 落 -1）；
- turbo 全量解析时 file.ctime 用 mtime 兜底（`dvPage` 按需取数用真实
  birthtime；单文件被 dvPage 重解析后自动修正）。

版本配对约定
------------
descriptor 的 `manifest.version`（0.5.70）必须与 daemon 侧 dvImport.ts 的
`DV_PARSE_VERSION` 一致——dv_pages 行按 (version, mtime, size) 判新鲜；
漂移不会坏数据，只会自愈为逐文件重解析。升级上游时改两处 + 本 NOTICE。

宿主构建适配（根 esbuild.mjs + 模块 tsconfig，2026-11-23 实测三个坑）
-------------------------------------------------------------------
1. **baseUrl 裸导入**：上游 `baseUrl: "src"` 让全仓用 `from "data-model/value"`
   这类裸导入；esbuild 不支持「无 paths 的 baseUrl」。改法：模块 tsconfig 把
   baseUrl 定成 "." 并显式枚举 paths（`"data-model/*": ["src/data-model/*"]`
   等，含裸段键 `data-index`）——tsc（baseUrl=. 后 paths 相对 tsconfig 目录）
   与 esbuild 两侧语义一致，上游解析语义不变。
2. **不能走 onResolve resolver**：实测 esbuild 对经插件 onResolve 返回路径的
   文件会丢 per-file tsconfig——tsx 的 jsxFactory: h 失效、退回默认
   React.createElement，运行时 `React is not defined`（直连 entry 则正常）。
   所以裸导入必须走 tsconfig paths 的原生解析，不能走 resolver。
3. **内建 external 撞车**：esbuild 的包名 external 覆盖其全部子路径——内建
   清单里的 `util` 会吞掉 dataview 的 `util/normalize`（tsconfig paths 救不
   回），变成运行时 require 并在渲染进程炸掉（Plugin failure 实测）。用
   importer 限定 modules/dataview/ 的窄口径 resolver（dataview-util-alias）
   把 `util/*` 解析回真实文件；主 bundle 与 daemon bundle 两处挂。

- `dataview-web-worker` 插件：`web-worker:` 导入 → 构建期 IIFE + Blob Worker
  工厂（回落通道用，daemon 模式不触发）。

Styles：上游 styles.css 整段并入根 styles.css 的 Dataview 分段
（.block-language-dataview / .table-view-table / .dv-* 为上游原样）。
