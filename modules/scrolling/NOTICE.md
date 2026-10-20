# NOTICE — modules/scrolling

本模块是第三方插件 **Scrolling**（omeyenburg / Oskar Meyenburg）的**完整收编副本**，
非本仓自有代码，按其上游许可证（MIT，见同目录 LICENSE）原样保留并注明出处。

- 上游仓库: https://github.com/omeyenburg/obsidian-scrolling
- 收编版本: v1.4.0（master 分支 tip `bd1565759c9a849ed723db2a71952d7373b7fb72`，
  共 369 次提交历史已连合进本仓——嫁接提交的第二父提交即上游 master tip。
  注意 `git log --follow` 会在嫁接提交处断开（上游路径与仓内
  `modules/scrolling/` 不同），查上游历史用 `git log bd156575 -- <上游路径>`；
  本仓路径下的变更从嫁接提交起）
- 收编方式: 工作区整体拷贝（`src/`、`preview/`、`LICENSE`、`README.md`、
  `manifest.json`、`versions.json`、`tsconfig.json`、`package.json`、`styles.css`
  与上游 HEAD 逐文件一致），未改源码语义
- manifest id: `scrolling`（聚合内 id 与 legacyId 均保持此真实上游 id，
  使 `app.plugins.plugins["scrolling"]` 继续可解析）

## 功能

编辑/阅读体验的一组可选开关：光标居中（typewriter 模式）、记住恢复滚动/光标位置、
代码不换行横向滚动、长行内 MathJax 横向滚动、文件树横向滚动、置顶/置底按钮与快捷
命令、阅读模式 Vim 式导航快捷键、滚动条显隐策略、正文最大行宽。全部在设置页可选。

## 并入时的适配（均为机械适配，不改运行时语义）

1. **`obsidian` 依赖钉版本**：`package.json` 里上游的 `"obsidian": "latest"`
   改为 `1.14.4`，与聚合宿主的类型版本一致（音乐播放器模块同款处理）。
   本模块的 `@codemirror/{language,state,view}` 与 `monkey-around` 沿用宿主的
   根依赖（全局 external 已覆盖 @codemirror/@lezer）。
2. **别名 `@core/*` `@features/*` `@typings/*`**：由模块自带的 `tsconfig.json`
   的 `baseUrl: src` + `paths` 提供（esbuild 按文件就近读 tsconfig 解析，无需
   在根 esbuild 里加插件）。根 tsconfig 不必映射它们。
3. **CSS 不走上游「独立 styles.css 产物」路径**：合并进聚合根 `styles.css` 的
   `Scrolling (modules/scrolling)` 分段；模块目录里的 `styles.css` 仅作留档
   （root esbuild 对 `.css` 按 empty 处理，不会被打包）。
4. **数据隔离**：`loadData`/`saveData` 与 `manifest` 由宿主的装载三板斧遮蔽，
   所以本模块的设置落在宿主 data.json 的 `modules.scrolling.data` 切片、
   `manifest.dir` 指向真实插件目录——`remember scroll` 的磁盘状态文件落在
   `<库>/.obsidian/plugins/obsidian-my-obsidian/scrolling-positions.json`。
   适配改动为零，无需触碰源码。
5. **⚠️ 禁止在 `modules/scrolling/` 下执行 `npm install`**：会生成含
   `@codemirror/*` 实体的 `node_modules`，与宿主的 CM6 单体实例冲突（TS2345）。
   依赖一律由宿主根部提供。
6. 未拷贝上游的仓库机制文件（`.github/`、`flake.*`、`eslint.config.mjs`、
   `scripts/`、`package-lock.json`、`.editorconfig`）：聚合构建不经它们，
   独立构建链不使用。
