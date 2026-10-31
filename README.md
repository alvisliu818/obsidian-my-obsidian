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
| Chs Patch | cm-chs-patch | 编辑器中文分词，兼作 Omnisearch 分词引擎（第三方） |
| Text Extractor | obsidian-text-extractor | 图片 OCR / PDF / Office 文本提取，兼作 Omnisearch 提取引擎（第三方） |
| Save Control | save-history + autosave-control | 库外文件的自动保存、版本快照、未保存圆点与关闭提示（两 MIT 插件合并） |
| Git | obsidian-git | 库内 git 集成：自动备份、源管理视图、行作者标注（第三方，支持分离布局） |
| Vault Explorer | obsidian-vault-explorer | frontmatter 可视化库浏览器：网格/列表/表格/动态四种版式、属性过滤与自定义过滤器（第三方） |
| LaTeX Delimiters | latex-delimiter-renderer | 渲染 `\(…\)` / `\[…\]` 公式而不改源文件：原生编辑器（实时预览/阅读模式）、logseq 块编辑器、内嵌、闪卡、库外文件（第三方） |
| Code Link | obsidian-code-link | 笔记里链接代码文件：悬停/嵌入预览、按符号（类/函数/方法）链接、tree-sitter 标签搜索（第三方） |

> 2026-10-30 起，各模块自己的插件 id 统一加 `my-` 前缀（如 `my-obsidian-logseq`），
> 不再与来源插件的上游 id 重名；下表「来源插件」列保持写上游原 id。

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
| AI image analyzer | Swaggeroo | GPL-3.0 | 见 `modules/my-ai-image-analyzer/README.md` |
| Omnisearch | Simon Cambier | GPL-3 | https://github.com/scambier/obsidian-omnisearch |
| Chs Patch | AidenLx | MIT | https://github.com/AidenLx/cm-chs-patch |
| Text Extractor | Simon Cambier | GPL-3 | https://github.com/scambier/obsidian-text-extractor |
| Save Control（save-history） | Sevoni | MIT | 见 `modules/my-save-control/NOTICE.md` |
| Save Control（autosave-control） | mihasm | MIT | 见 `modules/my-save-control/NOTICE.md` |
| Git | Vinzent03 | MIT | https://github.com/Vinzent03/obsidian-git |
| Vault Explorer | DecafDev | MIT | https://github.com/decaf-dev/obsidian-vault-explorer |
| LaTeX Delimiters | Andreas Burger | MIT | https://github.com/BurgerAndreas/latex-delimiter-renderer |
| Code Link | observerw | MIT | https://github.com/observerw/obsidian-code-link |

- **Material Icon Theme** 另外打包了 Material Icon Theme 的图标美术资源（来源
  `material-icon-theme` npm 包），其许可声明见
  `modules/my-material-icon-theme/NOTICE`（© Material Extensions，MIT）。
- **Save Control** 由两个 MIT 插件合并而成（save-history 为基座 +
  autosave-control 的延迟落盘控制器），两上游的版本、作者与 subtree 历史
  见 `modules/my-save-control/NOTICE.md`。
- **Chs Patch** 与 **Text Extractor** 为源码快照收编（上游 git 当时不可达，
  未能 subtree 拼接历史），出处/版本/适配见各自 `NOTICE.md`：前者构建期内嵌
  jieba wasm（免手动导入组件），后者的 `obsidian-text-extract` 核心库以
  `file:` 依赖接入（wasm 已内嵌其 dist）。
- **Code Link** 的 tree-sitter 核心 wasm 同样构建期内嵌（独立版运行时从 CDN
  拉，内嵌后 glue/wasm 同版本且离线可用），语言级解析器仍按上游设计运行时
  下载；出处/版本/适配见 `modules/my-code-link/NOTICE.md`。
- 这些第三方模块的源码未作功能性修改，仅为主仓的构建与装载方式做了适配；
  如需同步上游更新，可在各自目录用 `git subtree pull`。

## 构建

```sh
npm install
npm run build      # 先生成图标数据，再类型检查，最后打包
```

`npm run build` 比一般的 Obsidian 插件多两步：

1. **Material Icon Theme 的图标数据**（`modules/my-material-icon-theme/src/icon-data.ts`，
   约 2MB 内联 SVG）由 `scripts/build-icons.mjs` 从 `material-icon-theme` npm 包
   生成，未入库——这一步由 `npm run build:icons` 完成。
2. **Omnisearch 的 Svelte 组件**由主仓 esbuild 里的 `esbuild-svelte` 插件编译
   （`css: 'injected'`，与上游配置一致）；它依赖的 dexie 在打包时由
   `dexie-patch` 插件套用上游的补丁（移除 dual-package-hazard 检查，见
   `modules/my-omnisearch/patches/dexie.patch`），因为 pnpm 的补丁格式与
   patch-package 不兼容。
3. **Chs Patch 的 jieba wasm** 在构建期读 `jieba-wasm` 包（unplugged）算
   版本/sha256 并以 base64 内嵌进 main.js——上游要用户手动导入组件，合并后
   装上即用；上游 pnpm 补丁（去 wasm 胶水的隐式 URL 兜底）移植为
   `jiebaPatchPlugin`。Text Extractor 的语言多选组件（LangSelector）经根
   svelte5 工具链编译，`svelte-multiselect` 直引组件源文件（v11，svelte5
   原生）。

## 待并入

- **My Terminal**（obsidian-myterminal）：工具链是 bun + svelte + i18next + 原生
  pty-helper + Python/uv，作为第二阶段单独迁入。
