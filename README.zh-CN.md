# 音频时间码播放器

[English](README.md) | [简体中文](README.zh-CN.md)

音频时间码播放器是一款 Obsidian 社区插件，适用于会议转写、访谈、课程、播客和录音笔记。点击笔记中的时间码链接，即可跳转到嵌入录音的对应位置并立即播放。

## 功能

- 点击时间码后跳转并播放音频。
- 支持 `MM:SS` 和 `HH:MM:SS` 两种时间格式。
- 支持阅读视图和实时预览。
- 在源码模式编辑 Markdown 时也能识别时间码链接。
- 支持 MP3、WAV、M4A、OGG 和 FLAC 音频嵌入。
- 使用插件级悬浮播放器，在视图模式切换、长笔记滚动和分栏重渲染时保持播放状态。
- 完全在本地运行，不包含遥测，也不发起网络请求。

## 使用方法

首先在笔记中嵌入音频文件：

```markdown
![[会议录音.mp3]]
```

然后按照以下格式添加时间码链接：

```markdown
[00:13](#audio-timestamp=00:13) 发言人1：欢迎参加本次会议。
[05:22](#audio-timestamp=05:22) 发言人2：下面开始审阅方案。
[01:05:30](#audio-timestamp=01:05:30) 发言人1：会议总结。
```

如果需要在显示文本中保留方括号，请转义链接标题中的方括号：

```markdown
[\[00:13\]](#audio-timestamp=00:13)
```

插件使用当前活动笔记中的第一个受支持音频嵌入。建议将每份转写原文及其录音放在同一篇笔记或同一个会议文件夹中。

## 安装

普通用户不需要安装 Node.js，不需要运行 `npm install` 或 `npm run build`。

### 方法一：从 Obsidian 社区插件安装

当本插件被 Obsidian 官方社区插件目录收录后，可以直接安装：

1. 打开 Obsidian 的 **设置 → 第三方插件**。
2. 选择 **浏览**。
3. 搜索 **Audio Timestamp Player**。
4. 选择 **安装**，然后选择 **启用**。

> 当前项目只有在发布到公开 GitHub 仓库，并向 Obsidian 官方社区插件目录提交申请且审核通过后，才会出现在社区插件搜索结果中。

### 方法二：从 GitHub Release 手动安装

1. 从最新 GitHub Release 下载：

   ```text
   audio-timestamp-player.zip
   ```

   不要下载 GitHub 自动生成的 `Source code.zip` 或 `Source code.tar.gz`。
2. 解压 `audio-timestamp-player.zip`。解压后会得到完整的插件文件夹：

   ```text
   audio-timestamp-player/
   ├── main.js
   ├── manifest.json
   └── styles.css
   ```

3. 将整个 `audio-timestamp-player` 文件夹复制到需要安装插件的 Obsidian 仓库：

   ```text
   <仓库>/.obsidian/plugins/
   ```

   例如，本机 Notes 仓库的完整路径是：

   ```text
   E:\Aa-works\Notes\.obsidian\plugins\
   ```

   复制完成后的最终结构应为：

   ```text
   E:\Aa-works\Notes\.obsidian\plugins\
   ├── audio-timestamp-player\
   │   ├── main.js
   │   ├── manifest.json
   │   └── styles.css
   ├── templater-obsidian\
   └── 其他插件文件夹\
   ```

4. 打开 Obsidian 的 **设置 → 第三方插件**。
5. 选择已安装插件列表旁边的刷新按钮；如果没有出现插件，也可以完全退出并重新打开 Obsidian。
6. 找到 **Audio Timestamp Player** 并启用。

## 开发

本节只适用于需要修改插件源码、参与开发或自行构建插件的开发者。普通用户可以跳过本节。

环境要求：

- Node.js 18 或更高版本
- npm

常用命令：

```bash
npm install
npm run dev
npm test
npm run lint
npm run build
```

- `npm install`：下载项目的开发依赖，通常在第一次获取源码后执行一次。
- `npm run dev`：进入开发监听模式，源码修改后自动重新构建。
- `npm test`：运行时间码解析和源码模式链接识别回归测试。
- `npm run lint`：检查代码是否符合 TypeScript 和 Obsidian 插件规范。
- `npm run build`：执行类型检查并生成正式版本的 `main.js`。

`npm run build` 完成后，项目根目录会出现 `main.js`。开发者可以把以下三个文件复制到测试仓库的插件目录：

```text
main.js
manifest.json
styles.css
```

`main.js` 是由 TypeScript 源码生成的构建文件，不直接提交到 Git 仓库。创建正式 GitHub Release 时，项目自带的发布工作流会重新构建插件，将 `main.js`、`manifest.json` 和 `styles.css` 放入 `audio-timestamp-player` 文件夹，再自动生成 `audio-timestamp-player.zip`。普通用户只需要下载这个压缩包、解压并复制整个文件夹，不需要自己构建。

Release 中仍会同时保留 `main.js`、`manifest.json` 和 `styles.css` 三个独立附件，用于满足 Obsidian 官方社区插件的发布和校验要求；普通用户可以忽略这些独立附件。

自动检查和人工回归清单见 [TESTING.md](TESTING.md)，覆盖模式切换、长笔记、多分栏和连续跳播场景。

## 隐私

插件完全在 Obsidian 内部运行，不收集分析数据、不传输仓库内容，也不发起网络请求。

## 许可证

本项目采用 0BSD 许可证发布。
