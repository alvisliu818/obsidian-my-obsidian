# NOTICE — modules/hearth

本模块是第三方插件 **Hearth**（ondreu）的**完整收编副本**，非本仓自有代码，
按其上游许可证（MIT，见同目录 LICENSE）原样保留并注明出处。

- 上游仓库: https://github.com/ondreu/Hearth
- 收编版本: v3.4.0（master 分支 tip `5d34e3793cfeaf043fc3918951df437144082349`，
  共 563 次提交历史已连合进本仓——嫁接提交的第二父提交即上游 master tip。
  注意 `git log --follow` 会在嫁接提交处断开（上游路径与仓内
  `modules/hearth/` 不同），查上游历史用 `git log 5d34e37 -- <上游路径>`；
  本仓路径下的变更从嫁接提交起）
- 收编方式: 工作区整体拷贝（`src/`、`CHANGELOG.md`、`LICENSE`、`README.md`、
  `README.zh-CN.md`、`manifest.json`、`versions.json`、`tsconfig.json`、
  `package.json`、`styles.css` 与上游 HEAD 逐文件一致），未改源码语义
- manifest id: `hearth`（聚合内 id 与 legacyId 均保持此真实上游 id）

## 功能

库首页（home screen）：全局搜索/快速切换器、仪表盘卡片（日记/任务/看板/日历/
热力图/RSS 阅读/天气/书签/最近文件/画册/启动器等）、工作区布局切换与壁纸外观，
移动端可用。全部能力见上游 README。

## 未拷贝的上游文件

`assets/`（README 截图，约 3.5MB）、`test/`、`docs/`、`scripts/`、`.github/`、
`.claude/`、`flake.*`、`eslint.config.mjs`、`esbuild.config.mjs`、
`manifest-beta.json`、`package-lock.json`、`.editorconfig`、`.gitignore`、
`.npmrc`：聚合构建不经它们。`CHANGELOG.md` 保留——`src/whatsnew.ts` 以
text loader 原样打包它（"What's new" 弹窗直接镜像上游日志）。
