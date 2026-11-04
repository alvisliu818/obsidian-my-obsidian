# NOTICE — modules/ribbon-organizer

本模块是第三方插件 **Ribbon and Status Bar Organizer**（xooooooooox / X.O.）的
**完整收编副本**，非本仓自有代码，按其上游许可证（MIT，见同目录 LICENSE）原样
保留并注明出处。

- 上游仓库: https://github.com/xooooooooox/obsidian-ribbon-organizer
- 收编版本: v0.19.0（master tip
  `fd29e661df4f6fa2303ec17fb8bf3462961ad497`，工作区整体拷贝）
- 收编方式: 工区整体拷贝（`src/`、`tests/`、`vitest.config.ts`、`styles.css`
  并入根 styles.css 分段、`LICENSE`、`README.md`、`README.zh.md`、
  `CHANGELOG.md`、`manifest.json`、`versions.json`）。
- 本仓改动（接入聚合宿主所需的最小改动）:
  - 模块经宿主 descriptor 静态引入（源码量小且通过根 strict typecheck，不走
    require 桥），宿主统一 id `ribbon-organizer`，设置页经宿主 addSettingTab
    截获内嵌。
  - styles.css 全文并入根 styles.css 分段。
  - 上游 vitest 测试（8 个套件）随模块进入根 `yarn test` 链。
- 运行性质: isDesktopOnly: false（状态栏/侧栏图标整理全平台可用）。
