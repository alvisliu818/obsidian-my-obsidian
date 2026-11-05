# NOTICE — modules/spaced-repetition

本模块是第三方插件 **Spaced Repetition**（Stephen Mwangi / st3v3nmw）的
**完整收编副本**，非本仓自有代码，按其上游许可证（MIT，见同目录 LICENSE）
原样保留并注明出处。

- 上游仓库: https://github.com/st3v3nmw/obsidian-spaced-repetition
- 收编版本: v1.15.4（master tip
  `3d5079f feat: add complete Hebrew (he) translation (#1598)`，
  工作区整体拷贝）
- 收编方式: 工区整体拷贝（`src/`、`styles.css` 并入根 styles.css 分段、
  `LICENSE`、`README.md`、`CHANGELOG.md`、`manifest.json`）。
- 本仓改动（接入聚合宿主所需的最小改动）:
  - 421 处 `from "src/..."` 路径别名改写为相对路径（与宿主 obsidian-git
    的 `src/*` 路径别名冲突）。
  - 模块经宿主 descriptor 静态引入，宿主统一 id `spaced-repetition`，
    设置页经宿主 addSettingTab 截获内嵌。
  - styles.css 全文并入根 styles.css 分段。
- 运行时依赖（已在根 PnP 环境）: ts-fsrs、clozecraft、minimatch、
  pagerank.js。chart.js/gridjs/short-uuid 上游声明但未使用。
- 运行性质: isDesktopOnly: false。
