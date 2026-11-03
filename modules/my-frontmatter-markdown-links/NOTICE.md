Frontmatter Markdown Links
==========================

出处
----
- 上游仓库：<https://github.com/mnaoumov/obsidian-frontmatter-markdown-links>
- 版本：v3.1.0
- 作者：Michael Naumov（mnaoumov）
- 许可证：**MIT**（见同目录 LICENSE）—— 与聚合宿主 GPL-3.0 兼容
- minAppVersion：1.14.5；isDesktopOnly：false
- 收编日期：2026-11-03

并入方式：require 桥（不进宿主 tsc）
-----------------------------------
- 体量：33 个源文件（排除 *.test.ts 与 src/demo-vault 示例库未收）。
- 与 CAL/ARDH 同款 mnaoumov 系收编：上游 import 全部带 `.ts` 扩展名、
  obsidian-lib 版本区间与根 PnP 实装的 5.1.0 兼容；按本仓收编判据走
  require 桥——`src/main.ts` 用 `require("../modules/my-frontmatter-markdown-links/src/main")`
  引入，模块不加入宿主 tsconfig include；类型由模块自带 tsconfig
  （拷自上游）独立校验，esbuild 打包不受影响。

样式
----
- 上游 `src/styles/main.scss`（54 行，纯嵌套）由 sass 编译为 CSS 后并入根
  `styles.css` 的「Frontmatter Markdown Links」分段；模块内
  `import './styles/main.scss'` 经根 esbuild 的 `.scss -> empty` loader
  置空（与 .css/.less 同款既有机制）。

单一插件 id 适配（2026-11-03）
------------------------------
- descriptor：`id: "frontmatter-markdown-links"`（插件表保持上游 id 存活，
  同 material-icon-theme/music-player 先例）、`migrateFrom: "frontmatter-markdown-links"`
  （首次启动从 `<configDir>/plugins/frontmatter-markdown-links/data.json`
  一次性迁移独立版设置）、`manifest: { version: "3.1.0" }`（保持上游版本语义）。
- 设置页经 addSettingTab 截获进宿主二级页（1.15 openPage 形态，见
  src/settings.ts）。
- lib 版本缺口：FML 上游要 obsidian-lib ^10.5.0 / typescript-lib ^2.0.0，
  根 PnP 实装 5.1.0 / 1.6.1。10.x-only 的四个子路径（data-stores×3、
  open-bug-report-command-handler）经 esbuild alias 劫持到模块 vendor/
  （10.5.0 自包含 dist cjs 12 个文件按原目录结构拷入，依赖闭包闭合：
  debug/library/bug-report/mobile-app-info/desktop-operating-system 等）。
  其余 obsidian-lib 路径不受影响，CAL/ARDH 照走 PnP 5.1.0。typescript-lib
  1.6.1 提供的 4 个基础子路径（type-guards/function/debug/library）运行时
  实测可用。
- RENAME_DELETE_HANDLER_OWNERS：本插件 3.0.0 起不再自带 rename/delete
  handler（交给 ARDH 生态），收编后从 ARDH 的 conflict 检查表移除对应条目
  ——同 bundle 共生不存在「旧版独立安装」形态。
