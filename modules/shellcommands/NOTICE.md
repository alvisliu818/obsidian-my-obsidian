# NOTICE — modules/shellcommands

本模块是第三方插件 **Shell commands**（Jarkko Linnanvirta / Taitava，现由
david-shepard 维护）的**完整收编副本**，非本仓自有代码，按其上游许可证
（GPL-3.0，见同目录 LICENSE）原样保留并注明出处。

- 上游仓库: https://github.com/david-shepard/obsidian-shellcommands
  （插件原作与主体贡献: https://github.com/Taitava/obsidian-shellcommands）
- 收编版本: v1.0.2（manifest 版本；上游 master tip
  `afdf4183bcd7166c8816b201047dc5199c24cca5`，工作区整体拷贝）
- 收编方式: 工区整体拷贝（`src/`、`styles.css`、`LICENSE`、`README.md`、
  `CHANGELOG.md`、`manifest.json`、`versions.json`）。上游历史保留在
  E:/HOME/Code/obsidian/obsidian-shellcommands 本地克隆（含 .git），未嫁接。
- 本仓改动（接入聚合宿主所需的最小改动）:
  - 两个 GitHub 依赖以源码形式 vendor 进 `vendor/`（同为上游声明版本）:
    - `vendor/ansi_up/` — Taitava/ansi_up tag `for-obsidian-shell-commands-1`
      （drudru/ansi_up v5.1.0 的 fork，MIT）。经根 esbuild.mjs 的 alias
      `ansi_up` 指入。
    - `vendor/autocompleter/` — Taitava/autocomplete tag
      `obsidian-shellcommands-0.13.0`（autocompleter v6.1.3 的 fork，MIT）。
      经 alias `autocompleter` 指入。
  - 类型导入改为 `import type`（`AutocompleteResult` 等），避免 esbuild 对
    纯类型具名导入的运行时解析。
  - 模块经聚合宿主的 require 桥引入（同 livesync 模式），宿主统一 id
    `shellcommands`，设置页经宿主 addSettingTab 截获内嵌。
- 运行性质: isDesktopOnly（shell 执行依赖本机 shell 与 child_process）。
