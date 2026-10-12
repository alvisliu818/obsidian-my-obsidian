# obsidian-my-obsidian

把几个自用 Obsidian 插件合成一个：一个 manifest、一个 main.js，设置里可单独开关每个子功能。

## 已并入的子功能

| 子功能 | 来源插件 | 说明 |
| --- | --- | --- |
| Logseq Editor | obsidian-logseq | Logseq 式块大纲编辑器（桌面端） |
| Browser | obsidian-browser | 多标签 webview 浏览器、书签、历史、下载、剪藏 |
| Jupyter Notebook | obsidian-jupyter-notebook | 在库内查看/编辑/运行 .ipynb |
| Breadcrumb Nav | obsidian-breadcrumb-nav | 笔记顶部面包屑（文件 › 标题/块层级） |
| Doc Assist | obsidian-doc-assist | 文档加工流水线：剪藏清洗、中英空格/标点、列表段落整理、删区间 |
| Material Icon Theme | obsidian-material-icon-theme | 文件浏览器 Material Design 图标（第三方） |
| TraceTime | obsidian-tracetime | 段落旁显示最后编辑时间（第三方，fork 维护） |

历史用 `git subtree` 挂在 `modules/<子功能>/` 下，各插件原来的提交都能追溯。

## 第三方模块与许可

其中两个子功能是**第三方插件**，按 MIT 许可的要求原样保留其版权声明与许可全文
（分别在 `modules/material-icon-theme/LICENSE` 与 `modules/tracetime/LICENSE`）：

| 模块 | 原作者 | 许可 | 上游 |
| --- | --- | --- | --- |
| Material Icon Theme | GilbertzzzZZ | MIT | https://github.com/gilbertzzzzz/obsidian-material-icon-theme |
| TraceTime | QuincySx | MIT | https://github.com/QuincySx/obsidian-tracetime |

- **Material Icon Theme** 另外打包了 Material Icon Theme 的图标美术资源（来源
  `material-icon-theme` npm 包），其许可声明见
  `modules/material-icon-theme/NOTICE`（© Material Extensions，MIT）。
- 这两个模块的源码未作功能性修改，仅为主仓的构建与装载方式做了适配；
  如需同步上游更新，可在各自目录用 `git subtree pull`。

## 构建

```sh
npm install
npm run build      # 先生成图标数据，再类型检查，最后打包
```

`npm run build` 比一般的 Obsidian 插件多一步：Material Icon Theme 的图标数据
（`modules/material-icon-theme/src/icon-data.ts`，约 2MB 内联 SVG）是由
`scripts/build-icons.mjs` 从 `material-icon-theme` npm 包生成的，未入库——
这一步由 `npm run build:icons` 完成，单独跑它可以只重新生成图标。

## 待并入

- **My Terminal**（obsidian-myterminal）：工具链是 bun + svelte + i18next + 原生
  pty-helper + Python/uv，和其余模块的 esbuild 体系不同，作为第二阶段单独迁入。
