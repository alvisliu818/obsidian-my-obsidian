Better Markdown Links
=====================

出处
----
- 上游仓库：<https://github.com/mnaoumov/obsidian-better-markdown-links>
- 版本：v6.4.0
- 作者：Michael Naumov（mnaoumov）
- 许可证：**MIT**（见同目录 LICENSE）—— 与聚合宿主 GPL-3.0 兼容
- minAppVersion：1.14.5；isDesktopOnly：false
- 收编日期：2026-11-03

并入方式：require 桥（不进宿主 tsc）
-----------------------------------
- 体量：48 个源文件（59 个 *.test.ts 与 showcase 集成测试未收）。
- 与 FML/ERH/CAL/ARDH 同款 mnaoumov 系收编判据：require 桥，模块自带
  tsconfig 独立校验。

lib 版本缺口（与 FML 同款）
--------------------------
- 上游要 obsidian-lib ^10.5.0 / typescript-lib ^2.0.0，根 PnP 实装
  5.1.0 / 1.6.1。43 个 lib 子路径中 40 个 5.1.0 已有；缺失 3 个
  （data-stores/local-data-store、open-bug-report-command-handler 已由
  FML vendor+alias 覆盖；undo-bulk-operation-command-handler 与
  components/bulk-operation-commit-component 为本模块新增——10.5.0 自
  包含 dist cjs 依依赖闭包 BFS vendored 进 vendor/（36 文件 891KB，
  i18n/file-manager/metadata-cache/queue/modals 等）。
- 闭包的运行时依赖补进根 package.json：compare-versions、remark、
  remark-parse、remark-wiki-link、unist-util-visit（i18next/monkey-around/
  type-fest 根已有）。i18next ~26.4.2 与 typescript-lib 1.6.1 运行时实测。
- @obsidian-typings/obsidian-public-latest ^6.54.0（implementations 的
  运行时函数 isFrontmatterLinkCache 等，2 处 import）补进根 devDeps。

单一插件 id 适配（2026-11-03）
------------------------------
- descriptor：`id: "better-markdown-links"`（上游 id 存活）、
  `migrateFrom: "better-markdown-links"`、`manifest: { version: "6.4.0" }`。
- RENAME_DELETE_HANDLER_OWNERS：本插件 5.0.0 起 handler 让给 ARDH 生态
  （rename-delete-handover），收编后 conflict 检查表清空、整体退役。
