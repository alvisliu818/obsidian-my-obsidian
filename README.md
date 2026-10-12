# obsidian-my-obsidian

把几个自用 Obsidian 插件合成一个：一个 manifest、一个 main.js，设置里可单独开关每个子功能。

## 已并入的子功能

| 子功能 | 来源插件 | 说明 |
| --- | --- | --- |
| Logseq Editor | obsidian-logseq | Logseq 式块大纲编辑器（桌面端） |
| Browser | obsidian-browser | 多标签 webview 浏览器、书签、历史、下载、剪藏 |
| Jupyter Notebook | obsidian-jupyter-notebook | 在库内查看/编辑/运行 .ipynb |
| Breadcrumb Nav | obsidian-breadcrumb-nav | 笔记顶部面包屑（文件 › 标题/块层级） |

历史用 `git subtree` 挂在 `modules/<子功能>/` 下，各插件原来的提交都能追溯。

## 待并入

- **My Terminal**（obsidian-myterminal）：工具链是 bun + svelte + i18next + 原生 pty-helper + Python/uv，
  和其余四个的 esbuild 体系不同，作为第二阶段单独迁入。
