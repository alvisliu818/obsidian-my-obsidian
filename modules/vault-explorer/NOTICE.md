# NOTICE — modules/vault-explorer

本模块是第三方插件 **Vault Explorer**（DecafDev）的**完整收编副本**，
非本仓自有代码，按其上游许可证（MIT，见同目录 LICENSE）原样保留并注明出处。

- 上游仓库: https://github.com/decaf-dev/obsidian-vault-explorer
- 收编版本: v1.47.4（master 分支 tip `c8a4c5fd29842470e82d48b95bb5e373ff666be0`，
  共 802 次提交历史经 `git subtree add` 连合进本仓——合并提交
  `46260af2` 的第二父提交即上游 tip，`git log modules/vault-explorer` 可全程追溯）
- 收编方式: git subtree 全历史挂载；源码**零语义改动**（见下方适配清单，
  全部是构建/装载层面的机械适配）
- manifest: `id: vault-explorer`、`isDesktopOnly: true`（聚合内
  desktopOnly: true，移动端不装载）

## 功能

用 frontmatter 属性与文件元数据浏览、过滤、整理库文件：网格/列表/表格/动态
（feed）四种版式、按属性分组过滤、自定义过滤器可保存复用、卡片封面图与
SMI（社交媒体图片）缓存、侧栏 ribbon 入口。上游文档见 vaultexplorer.com。

## 并入时的适配（均为机械适配，不改运行时语义）

1. **require 桥接线**（`src/main.ts`）：模块源码用 `src/...` 非相对导入
   （上游 baseUrl 约定），而宿主 tsconfig 的 `src/*` 别名已被 obsidian-git
   占用，不能让它进宿主 tsc 程序；类型由本模块自带 tsconfig 独立校验，
   运行时照常打进 bundle（media-extended / custom-attachment-location 同款）。
2. **依赖上提根**：`js-logger`、`lodash`（+ devDeps `@types/lodash`）新增进
   根 package.json；`nanoid` 根版本 ^5.0.6 → ^5.1.5 统一；`idb`/`svelte`
   沿用根依赖。上游声明的 `crypto` 依赖在源码中无任何 import（残留声明），
   **未上提**——esbuild 的 builtin external 已覆盖 node:crypto。
3. **tsconfig 重写**（PnP 自包含）：上游 extends `@tsconfig/svelte`，PnP 下
   该包不在根依赖、无法解析，故把生效选项内联：`verbatimModuleSyntax: true`
   （@tsconfig/svelte 原有关，必须保留——否则 sveltePreprocess 转译会删掉
   只被 `$store` 引用的 import，momentum 收编时踩过同款坑）、
   `paths: { "src/*": ["./src/*"] }`、noImplicitAny + strictNullChecks
   （上游同款严格度）。include 收窄到 `src/**` + svelte shim，上游 jest
   测试不进 tsc 程序（jest + bun 工具链未随迁，测试文件原样留档）。
4. **`svelte-shims.d.ts`**（模块根、src 之外）：`.svelte` 导入的 ambient
   声明（omnisearch 同款）。放 src 外是为了直连/桥接两种路线下都不与
   omnisearch 的全局声明重复。宿主程序里 `.svelte` 组件由根 esbuild 的
   svelte 插件（Svelte 5，css injected）编译。
5. **样式并入根 `styles.css`** 的 Vault Explorer 分段：上游 `src/styles.css`
   全部内容只有 4 行（`.vault-explorer-status-bar { display: none }`，
   视图激活时隐藏状态栏）。根 esbuild 对 `.css` 按 empty 处理，模块目录里
   的文件仅作留档。
6. **⚠️ manifest 覆盖 `{ id: "vault-explorer", version: "1.47.4" }`（关键）**：
   - `version`：模块把 `manifest.version` 写进自己的数据切片当
     `pluginVersion`，之后每次启动 `preformMigrations()` 会对所有
     `isVersionLessThan(loadedVersion, to)` 为真的迁移项执行迁移——宿主
     的 0.1.0 会让 0.3.3→1.46.0 **整条迁移链（36 项）** 在正常设置上反复
     运行，把搜索过滤器改写成 `{ isEnabled: true, value: undefined }`，
     视图首个 effect 即崩溃（实测：视图空白 + `e.toLowerCase is not a
     function`）。上游版本号让 `isVersionLessThan` 全假、永不迁移。
     （e2e 实测还发现：宿主 `loadData` 遮蔽对空切片返回 `{}` 而非 null，
     首次启动即写入 pluginVersion，所以第二次启动就进迁移链。）
   - `id`：命令命名空间随之变为 `vault-explorer:`（上游原样），命令
     `id: "open"` 在宿主命名空间里会与 momentum 的同名命令撞车
     （先注册者胜，后来者被静默丢弃）；设置页齿轮的
     `openTabById(manifest.id)` 也才能打开自己的设置页。
     同类先例：advanced-rename-and-delete-handler、custom-attachment-location。
7. **数据不迁移**：若库里曾装过独立版 Vault Explorer，其
   `.obsidian/plugins/vault-explorer/data.json` 不会搬进聚合的
   `modules.vault-explorer` 切片（audio-player 同款约定），首次启用为全新默认设置。
8. 上游 `bun.lockb`、`.github/`（CI 工作流）在收编后移除：聚合构建不经它们。
   `test-vault/`、`__mocks__/`、jest 配置原样保留留档。

## 已知边界

- e2e 冒烟（本地探针 `tests/e2e/_vaultexplorer-smoke.mjs`，不入库）：
  测试库实启 Obsidian，10/10 通过（模块启动/视图注册与渲染/别名/命令/
  ribbon/数据切片/零致命错误）。
- 上游构建链（bun + svelte-check + jest）未随迁；本模块的类型门是
  `yarn tsc -p modules/vault-explorer --noEmit`（0 错误），运行时门是聚合
  `yarn run build` + 上述 e2e 冒烟。
