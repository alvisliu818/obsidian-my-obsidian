# 音频时间码播放器

[English](README.md) | [简体中文](README.zh-CN.md)

音频时间码播放器是一款 Obsidian 社区插件，适用于会议转写、访谈、课程、播客和录音笔记。点击笔记中的时间码链接，即可跳转到嵌入录音的对应位置并立即播放。

## 功能

- 点击时间码后跳转并播放音频。
- 支持 `MM:SS` 和 `HH:MM:SS` 两种时间格式。
- 支持阅读视图和实时预览。
- 支持 MP3、WAV、M4A、OGG 和 FLAC 音频嵌入。
- 当 Obsidian 在长笔记中卸载屏幕外的音频播放器时，自动创建一个置顶播放器。
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

### 手动安装

1. 从最新 GitHub Release 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 在 Obsidian 仓库中创建以下文件夹：

   ```text
   <仓库>/.obsidian/plugins/audio-timestamp-player/
   ```

3. 将三个发布文件复制到该文件夹。
4. 打开 **设置 → 第三方插件**，刷新已安装插件，然后启用 **Audio Timestamp Player**。

### 开发版安装

```bash
npm install
npm run build
```

将生成的 `main.js`、`manifest.json` 和 `styles.css` 复制到上述插件文件夹。

## 开发

环境要求：

- Node.js 18 或更高版本
- npm

常用命令：

```bash
npm install
npm run dev
npm run lint
npm run build
```

生产构建会在项目根目录生成 `main.js`。构建产物不会提交到 Git，而会由发布工作流附加到 GitHub Release。

## 隐私

插件完全在 Obsidian 内部运行，不收集分析数据、不传输仓库内容，也不发起网络请求。

## 许可证

本项目采用 0BSD 许可证发布。
