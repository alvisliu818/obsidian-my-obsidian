# Super Useful SQL — 并入说明

来源：https://github.com/serena-sheng/obsidian-super-useful-sql（v0.2.1，2026-11-22 克隆）。

- 上游仓库只发布构建产物（main.cjs 未压缩可读(宿主 ESM 环境下 .js 会被按 ESM 解析,产物必须 .cjs 后缀强制 CJS loader)、manifest.json、styles.css），无源码目录——
  本目录原样收录产物，更新时重新下载 release 替换 main.js/styles.css/manifest.json。
- 接入方式：宿主 `require("../modules/super-useful-sql/main.cjs")` 取导出的 Plugin 子类
  （产物为 `module.exports = SuperUsefulSqlPlugin` 直导出）；`require('obsidian')` /
  `require('node:sqlite')` 均为 esbuild external，运行时由 Obsidian/Electron 提供。
- 数据与索引：无——查询面板按需连接用户注册的外部 .db 文件（只读，node:sqlite
  query_only + authorizer），模块数据片仅存别名/查询历史（宿主 settings.modules 片）。
- 上游许可证见 LICENSE。
