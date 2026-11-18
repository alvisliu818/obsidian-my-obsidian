# NOTICE — modules/easy-sync

本模块是第三方插件 **EasySync / 易同步**（Jiao Yingxing）的**完整收编副本**，
非本仓自有代码，按其上游许可证（**MIT**，见同目录 LICENSE）原样保留并注明
出处——与聚合宿主 GPL-3.0 兼容。

- 上游仓库: https://github.com/jiaoyingxing/easy-sync
- 收编版本: v1.7.1（main 分支快照，2026-11-17 拉取，`package.json` 版本
  1.7.1；当时最新 release 提交 `7d8401c`）
- 收编方式: **源码快照** + require 桥。上游 git 在本网络不可达（clone 与
  直连均 TLS 失败），无法走 git subtree 连合历史——同 cm-chs-patch /
  text-extractor 的快照收编先例，出处以本文件为准。
- 体量: 172 个 TS 文件 / 13.9 万行（`sync-executor.ts` 单文件 3.4 万行），
  本仓收编体量第二（仅次于 livesync）。
- manifest: `id: my-easy-sync`（2026-10-30 前缀政策）、
  `minAppVersion: 1.13.4`、`isDesktopOnly: false`（上游支持移动端，聚合内
  同样移动端装载）。

## 功能

双向 OneDrive 同步：笔记/附件按内容哈希双向同步，首次同步先预览计划再执行；
单边变化、内容一致、不重叠的文本修改自动处理，其余冲突由用户逐条裁决；中断
可恢复；编辑器设置/外观/主题/快捷键/书签/核心插件/社区插件可分项控制；大文件
分片上传；Windows/macOS/Linux/iOS/Android 全平台。云端数据在用户自己的
OneDrive 应用目录（`应用/EasySync/vaults/<仓库名>/`），不设中转服务器。

## 并入时的适配

1. **require 桥接线**（`src/main.ts`）：体量与上游自有工具链（strict tsconfig、
   vitest 4、eslint、文档自检脚本）决定了它进不了宿主 tsc 程序——同
   livesync / vault-explorer / custom-attachment-location 判据：类型由本模块
   自带 tsconfig 独立校验，运行时经 `require("../modules/easy-sync/src/main")`
   打进 bundle。上游全部相对导入，无 svelte / electron 依赖，无需 alias 或
   resolver 插件。
2. **依赖上提根**：`core-js-pure@3.49.0`（pinned，`structured-clone-compat`
   的 structuredClone ponyfill）新增进根 package.json；`idb` 沿用根
   ^8.0.3（上游同样 ^8.0.3）。
3. **tsconfig 重写**（模块根）：以上游 tsconfig 为底（strict、ES2020、DOM、
   moduleResolution bundler）+ `noEmit`；去掉 `baseUrl`（宿主 TS 5.9 已移除
   该选项，且本模块全是相对导入用不着它）。
4. **⚠️ descriptor 覆盖 `manifest: { version: "1.7.1" }`（关键）**：宿主以
   浅拷贝 manifest 传给模块（`id`/`dir` 固定是宿主的），version 缺省会变成
   宿主 0.1.0——模块的存储布局代际与升级判定读 `manifest.version`，必须钉
   上游值。同 vault-explorer / terminal / CAL 先例。
5. **内部存储路径随宿主 id**：`getEasySyncPaths(configDir, manifest.id)` 使
   状态文件落在 `.obsidian/plugins/<宿主 id>/state/v2/...`、`objects/`、
   `logs/`、`runtime/`——在自身插件目录内，默认即被「自身插件文件」排除
   逻辑罩住，不会进同步；IndexedDB 命名空间同样随宿主 id。**云端布局按仓库名
   （`应用/EasySync/vaults/<仓库名>/`），与插件 id 无关**，独立版与聚合版可
   指向同一云端空间。旧独立版目录 `.obsidian/plugins/easy-sync/` 会被社区
   插件选择逻辑按非代码文件排除，内部状态文件不会泄进同步范围。
6. **`migrateFrom: "easy-sync"`**：老用户独立版 `data.json` 首次启用时自动
   迁入聚合的 `modules.my-easy-sync` 切片（宿主既有机制，terminal/advanced-uri
   同款）。独立版的设备级 localStorage（更新检查记账）不迁移——无意义，
   见第 8 条。
7. **样式并入根 `styles.css`** 的 EasySync 分段：上游 `styles.css`（2557 行，
   全部 `easy-sync-*` 前缀）整段并入；根 esbuild 对 `.css` 按 empty 处理，
   模块目录不保留样式文件。
8. **上游更新检查构建期禁用**：上游每 24h 向其 GitHub 仓库探测新版本并弹
   提醒；聚合包不跟进上游发布（升级随宿主仓构建走），故根 esbuild
   `define __EASY_SYNC_UPDATE_CHECK_DISABLED__: "1"`，`runUpdateCheckFlow`
   入口短路（`update-check.ts` 的 `isUpdateCheckDisabledByBuild`）。上游
   bundle 不定义该常量，行为不变。
9. **`__EASY_SYNC_BUILD_VERSION__: "1.7.1"`**（根 esbuild define）：上游
   构建烧版本进 bundle 供诊断报告对照 manifest 代际；聚合构建沿用同机制，
   模块版本随收编更新时同步改这里。
10. **上游 `tests/`（267 个）、`docs/`、`scripts/`、eslint/jest 配置不随迁**：
    vitest 4 + fake-indexeddb 工具链与根 vitest 2.1.9 不同代；上游测试留档
    在上游仓库。本模块的类型门是
    `yarn tsc -p modules/easy-sync --noEmit`（0 错误），测试门是
    `yarn test:easy-sync`（本仓新增测试，见下节），运行时门是聚合
    `yarn build`。

## 功能增强（本仓改动，上游没有）

**同步排除扩展：黑名单 / 白名单 / 正则模式**（2026-11-17，用户需求）。上游
只有「不同步的文件夹」（`excludedFolders`，目录级、设备本地）；本仓在
`SyncPathSettings` 增加两个设备本地的模式列表，条目语法相同：

- **普通文本** = 目录/文件路径（边界前缀匹配、大小写不敏感，同
  `excludedFolders` 语义——`私人` 命中 `私人`、`私人/a.md`，不命中
  `私人日记/`）；
- **`/正则/flags`** = 对整条 vault 相对路径做 `RegExp.test`（如
  `/\.obsidian\/.*\.log$/i`）。

语义与优先级（`sync/local-scanner.ts` 的 `isExcluded`/`isExcludedDirectory`
挂接，本地扫描与执行器远端决策共用 `shouldSyncPath`/`shouldSyncFolderPath`
入口，一处生效两处遵守）：

1. EasySync 内部路径恒排除（硬，任何条目压不过）；
2. `excludedFolders`（原有文件夹排除）；
3. **黑名单**（`pathBlacklist`）——命中即排除，**优先于白名单**（安全优先：
   宁可不传，绝不传被明确禁止的东西）；
4. 自身插件目录 / 社区插件选择逻辑（原有）；
5. 内部 includePaths（同步范围开关纳管的 app.json/bookmarks.json 等）；
6. **白名单**（`pathWhitelist`）——非空时内容文件须命中至少一条才参与同步；
   插在内部 includePaths 之后，**插件/配置文件不受白名单影响**（它们由
   同步范围开关管辖）；目录级用保守判定（目录自身可能命中或有后代可能命中
   才保留递归，正则条目乐观放行交由文件级裁决）；
7. 内部 excludePaths、默认文件名排除（原有）。

实现清单：

- `src/sync/path-pattern-filter.ts`（新文件）：条目解析/归一化/校验/匹配，
  坏正则在保存期被 UI 拒绝（`SyncPathSettingsUpdateError("invalid-pattern")`，
  code 收窄自 `"busy" | "recovery"`），运行时兜底按不匹配处理——坏条目绝不
  阻塞同步。
- `src/sync/types.ts`：`ScanConfig` 加 `pathBlacklist`/`pathWhitelist`
  （可选字段，DEFAULT 空数组）。
- `src/sync/local-scanner.ts`：`isExcluded`/`isExcludedDirectory` 按上述顺序
  挂接；`FolderSyncScopeSnapshotV1` 透传两字段（**可选、向后兼容**——旧快照
  无此字段照常读取）；构造器与 `setConfig` 归一化。
- `src/main.ts`：`SyncPathSettings` + 两字段；数据键
  `sync-path-blacklist` / `sync-path-whitelist`；load/capture/write/publish
  管线；`syncPathSettingsFingerprint` 纳入；**保守扩张事务**——黑名单条目
  消失（含正则条目，覆盖范围不可证明时一律按扩张）或白名单新增条目，走
  `requiresCompleteRemoteIdentitySnapshot`（与移除排除文件夹同款语义）；
  `buildSyncPathScanConfig` 传入 scanner；诊断报告新增「本机黑名单模式 /
  本机白名单模式」计数与条目。
- `src/ui/settings-tab.ts` + `src/ui/settings-page-rows.ts`：同步范围页
  「不同步的文件夹」之后新增「不同步的模式（黑名单）」「只同步的模式
  （白名单）」两行（chips 可移除 + 输入框回车添加 + 保存前校验坏条目）。
- i18n：`zh-cn.ts` / `en.ts` / `types.ts` 补
  `settings.syncExclusion.patterns.*` 与 `notice.syncPathSettings.invalidPattern`，
  并扩写 `settings.syncExclusion.intro` 的语法说明。
- 测试（本仓 vitest 2.1.9）：`tests/path-pattern-filter.test.ts`（20 例：
  语法/去重/校验/匹配/目录保守判定/坏正则兜底）与
  `tests/local-scanner-patterns.test.ts`（12 例：scanner 挂接顺序——黑名单
  压白名单、白名单不伤配置文件、excludedFolders 仍更强、内部路径恒排除等）；
  `vitest.config.ts` + `obsidian-stub.js`（save-control 同款），已登记进根
  `vitest.workspace.ts` 与根 `test` / `test:easy-sync` 脚本。
