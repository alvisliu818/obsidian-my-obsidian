External Rename Handler
=======================

出处
----
- 上游仓库：<https://github.com/mnaoumov/obsidian-external-rename-handler>
- 版本：v4.1.0
- 作者：Michael Naumov（mnaoumov）
- 许可证：**MIT**（见同目录 LICENSE）—— 与聚合宿主 GPL-3.0 兼容
- minAppVersion：1.14.5；isDesktopOnly：**true**（chokidar 文件监听需要 Node）
- 收编日期：2026-11-03

并入方式：require 桥（不进宿主 tsc）
-----------------------------------
- 体量：12 个源文件（排除 *.test.ts 与 demo-vault 未收）。
- 与 FML/CAL/ARDH 同款 mnaoumov 系收编判据：require 桥，模块自带
  tsconfig 独立校验。

lib 版本缺口（与 FML 同款）
--------------------------
- 上游要 obsidian-lib ^10.5.0 / typescript-lib ^2.0.0，根 PnP 实装
  5.1.0 / 1.6.1。ERH 的 20 个 lib 子路径中 18 个在 5.1.0 已存在
  （components/loop/setting-ex 等），缺失的 2 个
  （data-stores/local-data-store、command-handlers/open-bug-report-command-handler）
  已由 FML 收编时的 vendor + esbuild alias 覆盖——本模块零新增 vendored。
- chokidar ^6.0.0（外部改动监听，desktop-only 路径使用）：补进根
  package.json 依赖（PnP 安装）。

单一插件 id 适配（2026-11-03）
------------------------------
- descriptor：`id: "external-rename-handler"`（上游 id 存活）、
  `migrateFrom: "external-rename-handler"`、`desktopOnly: true`、
  `manifest: { version: "4.1.0" }`。
- RENAME_DELETE_HANDLER_OWNERS：本插件 4.0.0 起不再自带 rename/delete
  handler，收编后从 ARDH 的 conflict 检查表移除对应条目。
