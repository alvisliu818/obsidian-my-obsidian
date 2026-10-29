<!-- markdownlint-disable -->

<p align="center">
  <img src="logo.png" alt="logo" width="120">
</p>

<h1 align="center">Material Icon Theme</h1>

<p align="center"><em>为 Obsidian 打造的 Material Design 图标</em></p>

<p align="center">
  <a href="https://github.com/GilbertzzzZZ/obsidian-material-icon-theme/releases"><img src="https://img.shields.io/github/v/release/GilbertzzzZZ/obsidian-material-icon-theme?style=for-the-badge&colorA=263238&colorB=4CAF50&label=VERSION" alt="Release"></a>
  <a href="https://github.com/GilbertzzzZZ/obsidian-material-icon-theme"><img src="https://img.shields.io/badge/Icons-1126-43A047?style=for-the-badge&colorA=263238&colorB=43A047" alt="Icons"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-1976D2?style=for-the-badge&colorA=263238&colorB=1976D2" alt="License"></a>
</p>

<p align="center"><a href="README.md">English</a> | <b>简体中文</b></p>

<br />

<p align="center">
  <img src="docs/screenshots/file-explorer.png" alt="文件浏览器中的 Material 图标" width="480" />
</p>

### 文件图标

<details><summary>🏞️ <b>查看全部文件图标</b></summary><br/><img src="docs/images/fileIcons.png" alt="文件图标"></details>

### 文件夹图标

<details><summary>🏞️ <b>查看全部文件夹图标</b></summary><br/><img src="docs/images/folderIcons.png" alt="文件夹图标"></details>

<br />

## 目录

- [功能](#功能)
- [快速开始](#快速开始)
- [自定义](#自定义)
- [图标匹配规则](#图标匹配规则)
- [开发](#开发)
- [图标来源](#图标来源)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

## 功能

- 为 Obsidian 文件浏览器提供 Material Design 文件与文件夹图标
- 1126 个图标，覆盖 2135 个文件名、1379 个扩展名和 269 个文件夹名
- 通过可搜索的图标选择器自定义图标关联
- 文件图标与文件夹图标可独立开关
- 设置界面支持 10 种语言
- 开箱即用，并实时跟随明暗主题切换

## 快速开始

> 需要 Obsidian 1.13.0 或更高版本。

1. **安装插件**<br>
  从 [Releases](https://github.com/GilbertzzzZZ/obsidian-material-icon-theme/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放进 `.obsidian/plugins/material-icon-theme/`。

2. **启用插件**<br>
  打开 **设置 → 第三方插件**，开启 **Material Icon Theme**。

3. **享用新图标**<br>
  文件浏览器会立即生效，无需重启。

> Release tag 与 `manifest.json` 完全一致（例如 `1.0.0`，不带 `v` 前缀），这是 Obsidian 的要求。

### 从源码构建

```bash
git clone https://github.com/GilbertzzzZZ/obsidian-material-icon-theme.git
cd obsidian-material-icon-theme
npm ci
npm run build
cp main.js manifest.json styles.css /你的库路径/.obsidian/plugins/material-icon-theme/
```

## 自定义

所有选项都在 **设置 → Material Icon Theme** 中。

<p align="center">
  <img src="docs/screenshots/settings.png" alt="设置" width="480" />
</p>

### 文件与文件夹图标开关

文件图标和文件夹图标可以分别开关。关闭其中一项，对应部分会交还给主题自带的图标。

### 自定义图标关联

把任意扩展名映射到图标库中的任意图标。启用后，自定义规则优先于所有内置匹配。

<p align="center">
  <img src="docs/screenshots/custom-rule.png" alt="添加自定义规则" width="480" />
</p>

填写扩展名时不带前面的点（`vue`、`rs`、`myext`），然后选择图标。复合扩展名同样支持——`d.ts` 的规则优先于 `ts`。

选择时可以按名称搜索完整图标库：

<p align="center">
  <img src="docs/screenshots/icon-picker.png" alt="图标选择器" width="480" />
</p>

### 界面语言

设置界面提供 English、简体中文、繁體中文、日本語、한국어、Deutsch、Français、Español、Русский、Português，可在设置页顶部随时切换。

## 图标匹配规则

文件按以下顺序匹配，命中即停：

| 优先级 | 规则 | 示例 |
|---|---|---|
| 1 | 自定义规则（启用时） | `myext` → 你指定的任意图标 |
| 2 | 带目录的文件名 | `.config/prettierrc`、`.github/FUNDING.yml` |
| 3 | 精确文件名 | `CLAUDE.md`、`Makefile`、`docker-compose.yml` |
| 4 | 最长匹配的扩展名 | `d.ts` 优先于 `ts` |
| 5 | 默认文件图标 | 未命中的其余文件 |

文件夹按名称查表匹配，查不到时回退到通用文件夹图标。展开与折叠时会自动切换对应状态的图标。

匹配全程不区分大小写，`CLAUDE.md` 与 `claude.md` 结果一致。

## 开发

```bash
npm ci
npm test              # 回归测试
npm run dev           # watch 模式（不会重新生成图标数据）
npm run build         # 完整生产构建
npm run build-icons   # 仅重新生成 src/icon-data.ts
```

| 路径 | 用途 |
|------|------|
| `src/main.ts` | 插件逻辑 |
| `src/icon-data.ts` | 生成的图标注册表与查找表 |
| `scripts/build-icons.mjs` | 从 `material-icon-theme` 提取 SVG → `src/icon-data.ts` |
| `styles.css` | 图标与设置界面样式 |

`src/icon-data.ts` 是自动生成的，**不要**手改。要添加上游没有的映射，请修改 `scripts/build-icons.mjs` 末尾的自定义区块，然后重新运行 `npm run build-icons`。

`main.js` 和 `src/icon-data.ts` 都已被 gitignore，克隆后需先运行 `npm run build`。

## 图标来源

图标素材来自 [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)，通过 [`material-icon-theme`](https://www.npmjs.com/package/material-icon-theme) npm 包引入；该项目的素材又源自：

- [Material Design Icons](https://pictogrammers.com/library/mdi/)
- [Material Symbols](https://fonts.google.com/icons)

## 参与贡献

欢迎提交 Issue 和 Pull Request。

开发、测试、上游升级与发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

- 🐛 **报告问题或申请图标**<br>
  [提交 Issue](https://github.com/GilbertzzzZZ/obsidian-material-icon-theme/issues)，并附上 Obsidian 版本、插件版本和复现步骤。

- 💡 **提交改动**<br>
  [创建 Pull Request](https://github.com/GilbertzzzZZ/obsidian-material-icon-theme/pulls)。

某个文件类型缺图标？通常也值得到[上游](https://github.com/material-extensions/vscode-material-icon-theme/issues)提一份申请，这样所有编辑器都能受益。

## 许可证

[MIT](LICENSE)。随插件分发的图标素材有其上游许可证，见 [NOTICE](NOTICE)。
