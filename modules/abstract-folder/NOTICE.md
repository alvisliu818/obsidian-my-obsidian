# NOTICE — modules/abstract-folder

本模块是第三方插件 **Abstract Folder**（Erfan Rahmani）的**完整收编副本**，
非本仓自有代码，按其上游许可证（GPL-3.0，见同目录 LICENSE）原样保留并注明出处。

- 上游仓库: https://github.com/erfyan-rahmani/obsidian-abstract-folder
- 收编版本: v1.14.0（master 分支 tip `56b82e7b9c1e9b0ebf7d756f337d34fe3626c1c4`，
  共 161 次提交历史已连合进本仓，可 `git log --follow modules/abstract-folder` 追溯）
- 收编方式: 工作区整体拷贝（`src/`、`main.ts`、`LICENSE`、`README.md`、
  `manifest.json`、`versions.json`、`tsconfig.json`、`package.json`），
  嫁接提交的树与上游 HEAD 逐文件一致
- manifest id: `abstract-folder`（聚合内 id 与 legacyId 均保持此真实上游 id，
  使 `app.plugins.plugins["abstract-folder"]` 继续可解析）
- `isDesktopOnly: true`，宿主 descriptor 同步标 `desktopOnly: true`

## 功能

动态虚拟文件夹：按父级关系/筛选条件把散落各处的笔记聚成虚拟文件夹，
提供树形与列式两种版式、拖拽整理、文件夹结构生成/转换（含冲突消解与
分组管理）、图标与配色自定义、转换进度显示。全部在设置页可选。

## 并入时的适配（均为机械适配，不改运行时语义）

1. **strict 适配 45 处**（主仓开 `strict` + `noUnusedLocals/Parameters`，上游
   tsconfig 只开 `strictNullChecks`）：
   - 43 处机械项：未用形参/局部加 `_` 前缀或删除、未初始化属性加 `!`、
     dropdown `onChange` 回调形参放宽为 `string` 后在赋值处窄化、`catch` 的
     `unknown` 传给 `Logger.error` 前 `String()`、删三处死代码
     （`resolveLinkToPath` 方法、`toggleSearch` 方法及其独占的 `isSearchVisible`
     字段——上游最后一个提交刚移除搜索按钮；debug-exporter 经松散转换读
     `isSearchVisible`，导出值由冻结的 `true` 变 `undefined`，仅影响调试转储）、
     删四个只写不读的私有字段/参数属性。
   - 2 处**聚合程序专属**（`debug-exporter.ts`）：聚合程序里 `App` 的真实类型
     比上游独立编译时宽得多——其它模块自带的 obsidian 类型
     （`@obsidian-typings/obsidian-public-*`，经 `require(mx-main)` 进程序）
     给 `App` 增补了 `plugins`/`customCss` 等内部成员，`AppWithInternal extends App`
     的窄化逐个冲突（TS2430/TS2352）。改为不继承 `App`、只描述本模块真正读取的
   内部形状，转换处 `as unknown as`（同文件里 `AbstractFolderViewInternal` 的同款
   做法）。单模块程序（探针 tsconfig）下同样编译通过。
2. **两处 baseUrl 相对导入**：上游 tsconfig 有 `baseUrl: .`，`src/indexer`
   与 `main` 这种裸路径导入在根配置下解析不到，改为相对路径
   （`../../indexer` / `../../main`）。
3. **CSS 不走上游「独立 styles.css 产物」路径**：上游 `main.ts` 以
   `import './src/styles/index.css'` 引入 8 个样式文件（esbuild 产出
   main.css 再改名 styles.css）；聚合里该 import 被根 esbuild 的 `.css`
   empty loader 吞掉，样式合并进根 `styles.css` 的
   `Abstract Folder (modules/abstract-folder)` 分段（按 index.css 的顺序逐文件拼接）。
   上游未被任何 TS 引用的 `src/ui/conversion-progress.css` 同样不进分段
   （与上游构建产物一致）。
4. **数据隔离**：`loadData`/`saveData` 与 `manifest` 由宿主的装载三板斧遮蔽，
   设置落在宿主 data.json 的 `modules.abstract-folder.data` 切片；
   本模块不写 `manifest.dir`/`configDir`/`vault.adapter`，无磁盘副作用。
5. **命令 id 无冲突**：`open-view` / `focus-active-file` 与现有模块不重名
   （已全仓 grep 校验）。
6. **⚠️ 禁止在 `modules/abstract-folder/` 下执行 `npm install`**：上游
   `package.json` 的 devDependencies 仅供独立构建使用，聚合构建一律由宿主
   根部提供依赖（obsidian 已由根 node_modules 钉 1.14.4）。
7. 未拷贝上游的仓库机制文件（`.github/`、`eslint.config.mjs`、
   `package-lock.json`、`.editorconfig`、`.npmrc`、`.gitignore`、
   `version-bump.mjs`、`inspect-config.mjs`、`generate_template.py`、
   `CHANGELOG.md`、`TECHNICAL_CHANGELOG.md`、`AGENTS.md`）：聚合构建不经它们。
