# Audio Timestamp Player

[English](README.md) | [简体中文](README.zh-CN.md)

Audio Timestamp Player is an Obsidian community plugin for transcripts, interviews, lectures, podcasts, and meeting notes. Select a timestamp link to seek an embedded audio file and start playback immediately.

## Features

- Seek and play audio from timestamp links.
- Support `MM:SS` and `HH:MM:SS` timestamps.
- Work in Reading view and Live Preview.
- Support MP3, WAV, M4A, OGG, and FLAC embeds.
- Create a sticky player when Obsidian unloads an off-screen audio embed in a long note.
- Run entirely locally without telemetry or network requests.

## Usage

Embed an audio file in the note:

```markdown
![[meeting-recording.mp3]]
```

Add timestamp links using the following format:

```markdown
[00:13](#audio-timestamp=00:13) Speaker 1: Welcome to the meeting.
[05:22](#audio-timestamp=05:22) Speaker 2: Let us review the proposal.
[01:05:30](#audio-timestamp=01:05:30) Speaker 1: Closing remarks.
```

If you want square brackets to appear around the timestamp, escape them in the link label:

```markdown
[\[00:13\]](#audio-timestamp=00:13)
```

The plugin uses the first supported audio embed in the active note. Keep each transcript and its recording in the same note when possible.

## Installation

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create this folder inside your vault:

   ```text
   <vault>/.obsidian/plugins/audio-timestamp-player/
   ```

3. Copy the three release files into that folder.
4. Open **Settings → Community plugins**, reload the installed plugins, and enable **Audio Timestamp Player**.

### Development installation

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to the plugin folder shown above.

## Development

Requirements:

- Node.js 18 or later
- npm

Commands:

```bash
npm install
npm run dev
npm run lint
npm run build
```

The production build is generated at the project root as `main.js`. Build artifacts are excluded from Git and attached to GitHub releases by the release workflow.

## Privacy

The plugin works entirely inside Obsidian. It does not collect analytics, transmit vault data, or make network requests.

## License

This project is released under the 0BSD license.
