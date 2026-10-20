<div align="center">
    <h1>Music Player</h1>
    <p>
        <img src="https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22music-player%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json" alt="Obsidian Downloads">
        <img src="https://img.shields.io/github/downloads/TracingOrigins/obsidian-music-player-plugin/total?logo=github" alt="GitHub Downloads">
    </p>
    <p>[中文 | <a href="https://github.com/TracingOrigins/obsidian-music-player-plugin/blob/master/README.md">English</a>]</p>
    <p><a href="https://community.obsidian.md/plugins/music-player" target="_blank">Music Player</a> 是一个在 Obsidian 侧边栏播放本地音乐文件的插件，集本地音乐库管理、歌词显示、歌单与收藏、播放模式控制于一体。</p>
</div>

## 功能特性

### 🎵 音频播放

- **多格式支持**：MP3 / WAV / OGG / M4A / FLAC / AAC
- **播放控制**：播放 / 暂停、上一首 / 下一首
- **进度与时间**：播放进度条与当前 / 总时长显示
- **播放速度**：0.5x – 2.0x 可调
- **音量控制**：静音、25%、50%、75%、100%
- **播放队列**：查看当前播放队列并快速切换歌曲

### 🎛️ 播放模式

- **顺序播放**：按列表顺序播放，播放完后停止
- **列表循环**：列表播放完后从头开始
- **单曲循环**：重复播放当前歌曲
- **随机播放**：随机选择歌曲播放

### 📚 歌曲管理

- **全部歌曲**：显示所有扫描到的音乐文件
- **收藏列表**：一键收藏，快速访问常听歌曲
- **歌单管理**：创建 / 编辑 / 删除自定义歌单
- **艺术家分类**：按艺术家自动分类歌曲
- **专辑分类**：按专辑自动分类歌曲
- **搜索功能**：快速搜索歌曲、艺术家、专辑

### 🎤 歌词功能

- **歌词来源**：歌词**只从音频文件的元数据标签中提取**，不支持从外部文件读取，也不会联网获取歌词。
  - **普通歌词**：支持标准 LRC 格式歌词文件
  - **逐字歌词**：支持带时间戳的逐字歌词（Karaoke 风格）
- **歌词显示**：
  - **三行歌词显示**：显示上一行、当前行、下一行
  - **全屏歌词显示**：完整歌词列表，自动滚动高亮
- **歌词同步**：自动根据播放进度同步显示歌词

> 关于详细歌词格式，请参考下方「[歌词格式](#歌词格式)」。

### 🎨 界面与交互

- **专辑封面显示**：自动显示专辑封面，支持唱片旋转动画
  - 封面查找优先级：
    1. 同目录下名为 `cover` 的图片文件（如 `cover.jpg`、`cover.png`，不区分大小写）
    2. 同目录下与歌曲同名的图片文件（例如 `song.mp3` → `song.jpg`）
    3. 从音频文件的元数据中提取内嵌封面
- **唱片切换动画**：使用上一首 / 下一首按钮或快捷键时，唱片会显示滑动切换动画
- **唱片页面**：精美的唱片播放界面
- **歌词页面**：专注的歌词显示界面
- **响应式设计**：适配桌面端和移动端
- **键盘快捷键支持**：见下文「[键盘快捷键](#键盘快捷键)」

### ⚙️ 设置选项

- **音乐文件夹选择**：
  - 支持搜索并选择音乐文件夹；
  - 点击输入框可查看所有文件夹列表；
  - 若留空，将扫描整个仓库（体量较大时建议单独为音乐建一个文件夹）。
- **打开时自动播放**：控制打开播放器时是否自动播放第一首歌曲
- **默认播放模式设置**：可在设置中配置初始播放模式

### 🔄 自动同步与索引

- **文件监听**：自动监听音乐文件的创建、删除、重命名、移动
- **自动更新库**：文件移入 / 移出音乐文件夹时，自动更新库数据
- **数据一致性检查**：启动时自动检查索引与文件系统的一致性
- **重建索引提示**：
  - 当检测到需要重建索引时，重建按钮右上角会显示一个小圆点；
  - 用户可手动点击重建按钮进行索引重建。

---

## 安装

### 📦 手动安装

适用于 **本地开发版本** 或尚未上架社区插件市场的情况：

1. 前往 [Releases](https://github.com/TracingOrigins/obsidian-music-player-plugin/releases) 下载最新版本的插件压缩包或文件。
2. 将插件文件夹解压 / 放入你的 Obsidian 插件目录（通常为：
  - `你的库/.obsidian/plugins/music-player/`）。
3. 在 Obsidian 中打开 **设置 → 社区插件 → 已安装插件**，启用本插件。

### 🔧 通过 BRAT 安装（推荐给测试用户）

适合希望体验 **测试版 / 最新开发版** 的用户：

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件。
2. 在 BRAT 设置中点击「**Add beta plugin**」（添加测试插件）。
3. 输入仓库地址：`TracingOrigins/obsidian-music-player-plugin`。
4. 安装完成后，到 **设置 → 社区插件 → 已安装插件** 中启用本插件。

---

## 使用方法

### 快速开始

1. 在 Obsidian 中启用插件（**设置 → 社区插件 → 已安装插件**）。
2. 点击左侧边栏的音乐图标，或使用命令面板搜索「**打开音乐播放器**」。
3. 首次使用时，建议在插件设置中配置一个 **专用的音乐文件夹路径**：
  - 可选：若留空，则会扫描整个仓库中的音频文件。
4. 在歌曲列表中点击任意歌曲即可开始播放。

### 歌词格式

插件支持从音频文件的元数据标签中读取以下两种歌词格式：

> 注意：**插件不会读取同目录下的 .lrc 文本文件，也不会联网获取歌词，只解析音频文件内部的歌词标签。**

- **普通歌词（LRC 格式）**
  示例：
  ```text
  [02:22.94]外婆她的期待
  [02:26.14]慢慢变成无奈
  [02:29.08]大人们始终不明白
  [02:34.97]她要的是陪伴
  [02:37.97]而不是六百块
  [02:40.96]比你给的还简单
  ```
- **逐字歌词（Karaoke 风格）**
  逐字歌词在**行起始时间戳**后，使用 `<时间>` 包裹每个字 / 词的时间戳。示例：
  ```text
  [02:23.43]<02:23.43>外<02:23.65>婆<02:23.83>她<02:24.18>的<02:24.71>期<02:24.90>待<02:25.63>
  [02:26.00]<02:26.00>慢<02:26.28>慢<02:26.68>变<02:27.02>成<02:27.40>无<02:27.83>奈<02:28.68>
  [02:29.00]<02:29.00>大<02:29.30>人<02:29.69>们<02:30.03>始<02:30.28>终<02:30.61>不<02:30.83>明<02:31.18>白<02:34.00>
  [02:34.96]<02:34.96>她<02:35.25>要<02:35.65>的<02:36.02>是<02:36.34>陪<02:36.77>伴<02:37.62>
  [02:37.93]<02:37.93>而<02:38.22>不<02:38.53>是<02:38.88>六<02:39.19>百<02:39.63>块<02:40.61>
  [02:40.94]<02:40.94>比<02:41.21>你<02:41.55>给<02:41.96>的<02:42.31>还<02:42.68>简<02:43.03>单<02:44.84>
  ```

### 播放队列

点击播放器底部控制栏中的 **播放列表按钮**，可以：

- 查看当前播放队列中的所有歌曲；
- 通过搜索快速定位队列中的歌曲；
- 点击队列中的任意歌曲直接切换播放；
- 查看每首歌的封面、标题、艺术家、专辑信息；
- 当前播放中的歌曲会高亮显示。

### 键盘快捷键

在播放器视图中，支持以下键盘操作：

- **空格键**：播放 / 暂停
- **↑**：上一首
- **↓**：下一首
- **←**：快退 5 秒
- **→**：快进 5 秒
- **Ctrl + ←**：快退 15 秒
- **Ctrl + →**：快进 15 秒

（具体快捷键以 Obsidian 设置中的实际展示为准，后续版本可能新增或调整。）

---

## 常见问题

#### Q: 重建按钮右上角显示了一个小圆点是什么意思？

**A:** 表示检测到索引数据与文件系统不一致，建议手动重建索引。常见原因包括：

- 在 Obsidian 外部（如资源管理器）删除了音乐文件；
- 文件被移动或重命名，但索引数据未更新；
- 索引数据损坏或不完整。

**解决方法：**

1. 点击带小圆点的「重建索引」按钮，手动重建索引；
2. 重建完成后，小圆点会自动消失。

**注意：** 即使不重建索引，库列表也会实时反映文件系统的变化（已删除的文件会立即从列表中消失）。重建索引主要用于清理无效索引数据和更新元数据。

---

## 开发指南

- 克隆此仓库：
  - `git clone https://github.com/TracingOrigins/obsidian-music-player-plugin.git`
- 确保你的 Node.js 版本至少为 **v16**（推荐使用当前 LTS）：
  - `node --version`
- 安装依赖：
  - `npm install`
- 开发调试（推荐）：
  - `npm run dev`
  - 会调用 `node scripts/deploy.mjs dev` 在你的 Vault 中创建指向 `dist` 的软链接，并启动打包工具进行实时增量编译，方便本地开发调试。
- 构建并部署到测试/发布环境：
  - `npm run build`
  - 会先执行 TypeScript 类型检查并进行生产构建，然后调用 `node scripts/deploy.mjs build` 将 `dist` 中的构建产物复制到 Vault 插件目录，供测试或发布使用。

> 上述部署脚本依赖项目根目录下的 `.env` 文件，请在其中配置：  
> `VAULT_PATH=/你的/Obsidian/Vault/路径`。  
> 插件 ID 从 `manifest.json` 的 `id` 字段读取，最终会部署到：`<VAULT_PATH>/.obsidian/plugins/<pluginId>/`。

---

## 技术栈

- **TypeScript**：类型安全的 JavaScript
- **React**：构建用户界面
- **Obsidian API**：Obsidian 插件开发框架
- **HTML5 Audio API**：音频播放能力
- **esbuild**：快速构建工具

---

## 📄 许可证

本项目采用 MIT 许可证 - 详情请参阅 [LICENSE](https://github.com/TracingOrigins/obsidian-music-player-plugin/blob/master/LICENSE) 文件。

---

## 🌟 支持与帮助

如果这个插件对您有帮助，请考虑：

- ⭐ **给仓库“点星”**
- 🐛 使用 [bug 报告模板](https://github.com/TracingOrigins/obsidian-music-player-plugin/issues/new?template=bug_report.md) 提交错误报告
- 💡 使用 [功能请求模板](https://github.com/TracingOrigins/obsidian-music-player-plugin/issues/new?template=feature_request.md) 提交功能建议
- ❓ 在我们的 [讨论区](https://github.com/TracingOrigins/obsidian-music-player-plugin/discussions) 提问或分享想法
- 📝 参阅 [贡献指南](https://github.com/TracingOrigins/obsidian-music-player-plugin/blob/master/docs/contributing/contributing.zh.md)，为本项目贡献代码或文档
- 💰 为开发者提供[赞助](https://support.tracingorigins.top/zh)（如果可用）