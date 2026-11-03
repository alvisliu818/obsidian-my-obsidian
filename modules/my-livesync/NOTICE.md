Self-hosted LiveSync
====================

出处
----
- 上游仓库：<https://github.com/vrtmrz/obsidian-livesync>
- 版本：v1.0.44
- 作者：vorotamoroz（vrtmrz）
- 许可证：**MIT**（见同目录 LICENSE）—— 与聚合宿主 GPL-3.0 兼容
- minAppVersion：1.7.2；isDesktopOnly：false
- 收编日期：2026-11-03

并入方式：require 桥（不进宿主 tsc）
-----------------------------------
- 体量：453 个源文件 / 6.8MB（58 个 .svelte 组件，排除 *.spec.ts）——
  本仓收编体量之最。require 桥 + 模块自带 tsconfig 独立校验。
- Svelte 5.56 组件经根 esbuild 的 svelte 插件编译（版本与上游一致）。
- 依赖树补进根 package.json：@aws-sdk/client-s3 + @smithy 系（S3 远端
  适配器）、@vrtmrz 五包（livesync-commonlib/obsidian-plugin-kit/
  ui-interactions/value-store/browser-ui-kit）、diff-match-patch、idb、
  markdown-it、minimatch、qrcode-generator、xxhash-wasm。

单一插件 id 适配（2026-11-03）
------------------------------
- descriptor：`id: "obsidian-livesync"`（**上游 id 存活**——同步插件的
  配置/行为识别对 id 敏感，且保持插件表连续）、`migrateFrom:
  "obsidian-livesync"`（主库独立版 data.json 170 键配置一次性迁移）、
  `manifest: { version: "1.0.44" }`。
- 上游 src 对 `manifest.id` 的直接引用仅 3 处，均为「自身是否启用」检查
  （config sync/hidden file sync 的 pluginManager.enabledPlugins.has）——
  合并后 manifest.id = 宿主 id 且宿主必然 enabled，天然通过，无需改。
- **数据安全（重要）**：主库独立版正以 S3 远端 + E2EE + 60s 周期复制活跃
  同步。收编后主库切换时必须：①先停独立版同步（或卸载独立版）避免双实例
  并发同步同一远端；②本地 IDB/PouchDB 库名若含插件 id，首次同步会重建
  本地库（全量重拉，E2EE 下数据安全但流量/时间有成本）；③迁移前备份
  `.obsidian/plugins/obsidian-livesync/` 与 data.json。
