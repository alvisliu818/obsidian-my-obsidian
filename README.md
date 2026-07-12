# Audio Timestamp Player

[English](README.md) | [简体中文](README.zh-CN.md)

Audio Timestamp Player is an Obsidian community plugin for transcripts, interviews, lectures, podcasts, meeting notes, and video notes. Select a timestamp link to seek an embedded audio or video file and start playback immediately.

## Features

- Seek and play audio or video from timestamp links.
- Support `MM:SS` and `HH:MM:SS` timestamps.
- Work in Reading view and Live Preview.
- Recognize timestamp links while editing in Source mode.
- Bind timestamps explicitly to multiple recordings in the same note.
- Support MP3, WAV, M4A, OGG, and FLAC embeds.
- Support MP4, WebM, OGV, MOV, and M4V video embeds.
- Keep a top-centered floating player alive across view-mode changes, long-note scrolling, and pane rerenders.
- Continue, pause, or close the player when switching pages, with continue as the default.
- Run entirely locally without telemetry or network requests.

## Usage

Embed an audio file in the note:

```markdown
![[meeting-recording.mp3]]
```

Add timestamp links using the following format:

```markdown
[00:13](#audio-time=00:13) Speaker 1: Welcome to the meeting.
[05:22](#audio-time=05:22) Speaker 2: Let us review the proposal.
[01:05:30](#audio-time=01:05:30) Speaker 1: Closing remarks.
```

If you want square brackets to appear around the timestamp, escape them in the link label:

```markdown
[\[00:13\]](#audio-time=00:13)
```

For multiple recordings, assign a stable alias on the same line as each embed and reference it from the timestamp:

```markdown
![[interview-part-1.mp3]] %%audio-id: part1%%
![[interview-part-2.mp3]] %%audio-id: part2%%

[\[00:13\]](#audio-time=00:13&audio=part1)
[\[00:13\]](#audio-time=00:13&audio=part2)
```

Aliases use 1-32 letters, numbers, hyphens, or underscores and are case-insensitive. A note with one recording may omit `audio`. A note with multiple recordings must specify it so playback is never routed to the wrong file.

For video, use the parallel `video-time`, `video-id`, and `video` syntax:

```markdown
![[demo-part-1.mp4]] %%video-id: part1%%
![[demo-part-2.webm]] %%video-id: part2%%

[\[00:13\]](#video-time=00:13&video=part1)
[\[00:13\]](#video-time=00:13&video=part2)
```

A single embedded video may omit the `video` parameter. Multiple videos require an explicit alias.

## Settings

The settings page has separate **Audio** and **Video** sections. Each **When switching pages** setting controls what happens after opening another note, image, PDF, canvas, or empty tab:

- **Continue playback** (default) preserves the current playing or paused state.
- **Pause playback** pauses audio but keeps the player available.
- **Close player** stops playback and removes the player.

**Video player display** chooses compact controls or an expanded player that shows the video picture. The expanded player starts at a compact 480 × 320 px size. An external double-corner handle resizes it while preserving the video's original aspect ratio, and the last size is remembered. The handle is enabled by default and can be disabled in settings; settings also provide a reset button.

**Language** changes only this plugin's interface and notices:

- **Follow Obsidian** uses Simplified Chinese for Chinese Obsidian locales and English for every other Obsidian language.
- **简体中文** always displays this plugin in Simplified Chinese.
- **English** always displays this plugin in English.

Changing the plugin language never changes Obsidian's own language. The close button on the player always stops playback, releases the media, and removes the floating bar.

## Installation

Regular users do not need Node.js and do not need to run `npm install` or `npm run build`.

### Option 1: Install from Obsidian Community plugins

After the plugin is accepted into the official Obsidian Community plugins catalog:

1. Open **Settings → Community plugins** in Obsidian.
2. Select **Browse**.
3. Search for **Audio Timestamp Player**.
4. Select **Install**, then select **Enable**.

> The plugin only appears in Community plugin search after it is published in a public GitHub repository and accepted into the official Obsidian community catalog.

### Option 2: Install from a GitHub release

1. Download the following file from the latest GitHub release:

   ```text
   audio-timestamp-player.zip
   ```

   Do not download GitHub's automatically generated `Source code.zip` or `Source code.tar.gz`.
2. Extract `audio-timestamp-player.zip`. It contains the complete plugin folder:

   ```text
   audio-timestamp-player/
   ├── main.js
   ├── manifest.json
   └── styles.css
   ```

3. Copy the entire `audio-timestamp-player` folder into:

   ```text
   <vault>/.obsidian/plugins/
   ```

   The final structure must be:

   ```text
   <vault>/.obsidian/plugins/
   ├── audio-timestamp-player/
   │   ├── main.js
   │   ├── manifest.json
   │   └── styles.css
   └── other-plugin-folders/
   ```

4. Open **Settings → Community plugins**.
5. Refresh the installed plugin list. If the plugin does not appear, fully restart Obsidian.
6. Find and enable **Audio Timestamp Player**.

## Development

This section is only for developers who want to modify the source code or build the plugin themselves. Regular users can skip it.

Requirements:

- Node.js 18 or later
- npm

Commands:

```bash
npm install
npm run dev
npm test
npm run lint
npm run build
```

- `npm install` downloads the development dependencies. It is normally required once after obtaining the source code.
- `npm run dev` watches the source files and rebuilds automatically during development.
- `npm test` runs timestamp parsing and Source-mode link regression tests.
- `npm run lint` checks the TypeScript and Obsidian plugin coding rules.
- `npm run build` type-checks the project and generates the production `main.js` file.

After `npm run build`, developers can copy these files to a test vault's plugin folder:

```text
main.js
manifest.json
styles.css
```

`main.js` is generated from the TypeScript source and is not committed directly to Git. When a formal GitHub release is created, the included workflow builds the plugin, places `main.js`, `manifest.json`, and `styles.css` in an `audio-timestamp-player` folder, and packages that folder as `audio-timestamp-player.zip`. Regular users only download the archive, extract it, and copy the complete folder.

The release also keeps `main.js`, `manifest.json`, and `styles.css` as individual assets for the official Obsidian community plugin release and validation process. Regular users can ignore those individual assets.

See [TESTING.md](TESTING.md) for the automated checks and the manual regression checklist covering mode switching, long notes, multiple panes, and continuous seeking.

## Privacy

The plugin works entirely inside Obsidian. It does not collect analytics, transmit vault data, or make network requests.

## License

This project is released under the 0BSD license.
