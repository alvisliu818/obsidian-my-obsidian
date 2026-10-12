# obsidian-my-obsidian

把几个自用 Obsidian 插件合成一个：一个 manifest、一个 main.js，设置里可单独开关每个子功能。

## 已并入的子功能

| 子功能 | 来源插件 | 说明 |
| --- | --- | --- |
| Logseq Editor | obsidian-logseq | Logseq 式块大纲编辑器（桌面端） |
| Browser | obsidian-browser | 多标签 webview 浏览器、书签、历史、下载、剪藏 |
| Jupyter Notebook | obsidian-jupyter-notebook | 在库内查看/编辑/运行 .ipynb |
| Breadcrumb Nav | obsidian-breadcrumb-nav | 笔记顶部面包屑（文件 › 标题/块层级） |
| Doc Assist | obsidian-doc-assist | 文档加工流水线：剪藏清洗、关键内容筛选、中英空格/标点、删区间 |
| Material Icon Theme | obsidian-material-icon-theme | 文件浏览器 Material Design 图标（第三方） |
| TraceTime | obsidian-tracetime | 段落旁显示最后编辑时间（第三方，fork 维护） |
| AI image analyzer | ai-image-analyzer | 用 AI 给图片生成关键词并反查（第三方） |
| Omnisearch | obsidian-omnisearch | 库内全文搜索引擎（第三方） |

历史用 `git subtree` 挂在 `modules/<子功能>/` 下，各插件原来的提交都能追溯。

## 许可：GPL-3.0

**本仓库整体按 GPL-3.0 分发**（根 `LICENSE`）。

原因：并入了两个 GPL-3 的第三方插件（AI image analyzer、Omnisearch）。
GPL-3 是强 copyleft——衍生作品必须整体以 GPL-3 分发，这不是可选项。
自研的六个子功能由作者本人重新许可，不存在障碍。

各第三方模块**自己的许可声明仍然保留**，各自的版权与义务不因合并而消失：

| 模块 | 原作者 | 许可 | 上游 |
| --- | --- | --- | --- |
| Material Icon Theme | GilbertzzzZZ | MIT | https://github.com/gilbertzzzzz/obsidian-material-icon-theme |
| TraceTime | QuincySx | MIT | https://github.com/QuincySx/obsidian-tracetime |
| AI image analyzer | Swaggeroo | GPL-3.0 | 见 `modules/ai-image-analyzer/README.md` |
| Omnisearch | Simon Cambier | GPL-3 | https://github.com/scambier/obsidian-omnisearch |

- **Material Icon Theme** 另外打包了 Material Icon Theme 的图标美术资源（来源
  `material-icon-theme` npm 包），其许可声明见
  `modules/material-icon-theme/NOTICE`（© Material Extensions，MIT）。
- 这些第三方模块的源码未作功能性修改，仅为主仓的构建与装载方式做了适配；
  如需同步上游更新，可在各自目录用 `git subtree pull`。

## 构建

```sh
npm install
npm run build      # 先生成图标数据，再类型检查，最后打包
```

`npm run build` 比一般的 Obsidian 插件多两步：

1. **Material Icon Theme 的图标数据**（`modules/material-icon-theme/src/icon-data.ts`，
   约 2MB 内联 SVG）由 `scripts/build-icons.mjs` 从 `material-icon-theme` npm 包
   生成，未入库——这一步由 `npm run build:icons` 完成。
2. **Omnisearch 的 Svelte 组件**由主仓 esbuild 里的 `esbuild-svelte` 插件编译
   （`css: 'injected'`，与上游配置一致）；它依赖的 dexie 在打包时由
   `dexie-patch` 插件套用上游的补丁（移除 dual-package-hazard 检查，见
   `modules/omnisearch/patches/dexie.patch`），因为 pnpm 的补丁格式与
   patch-package 不兼容。

## 待并入

- **My Terminal**（obsidian-myterminal）：工具链是 bun + svelte + i18next + 原生
  pty-helper + Python/uv，作为第二阶段单独迁入。
