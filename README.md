# Obsidian Jupyter Notebook

在 Obsidian 里直接查看、编辑并**运行** Jupyter Notebook（`.ipynb`）。

![demo](https://img.shields.io/badge/obsidian-desktop%20only-blue)

## 功能

- **查看**：解析 nbformat 4，代码格带语法高亮（只读 CodeMirror 实例，视口懒加载），markdown 格用 [obsidian-logseq](https://github.com/alvisliu818/obsidian-logseq) 的 logseq 风格块编辑器渲染（未安装时降级 Obsidian 原生 MarkdownRenderer）
- **编辑**：单元格源码就地编辑（Ctrl+S / Shift+Enter 提交），支持增删、上下移动、代码⇄Markdown 互转
- **运行**：持久 Python 内核（`tools/syfe-kernel.py` 自定义行协议），变量跨单元格保留；单个运行 / 全部运行 / 中断 / 重启；输出支持图片（png/jpeg/gif/svg）、HTML（沙箱 iframe）、markdown、富文本
- **Jupyter 语义**：内核工作目录 = 笔记本所在目录，相对路径读写与 Jupyter 一致

## 安装

- 需要本机安装 Python 3（在 PATH 中）
- 可选：安装 obsidian-logseq 插件以获得 markdown 单元格的 logseq 风格渲染与点击编辑

手动安装：将 `main.js`、`styles.css`、`manifest.json`、`syfe-kernel.py` 放入 `<vault>/.obsidian/plugins/obsidian-jupyter-notebook/`。

## 使用

右键 `.ipynb` 文件 → 「用 Notebook 打开」，或命令面板 → 「Open current notebook (.ipynb)」。

## 开发

```sh
npm install
npm run build   # tsc 检查 + esbuild production 产物
npm run dev     # watch 模式
```

## 说明

- 仅桌面端（需要 Node 子进程跑内核）
- Windows 中断 = 杀进程 + 重启 + 重放已执行历史（SIGINT 无法打断 GIL）
