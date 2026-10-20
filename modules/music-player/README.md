<div align="center">
    <h1>Music Player</h1>
    <p>
        <img src="https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22music-player%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json" alt="Obsidian Downloads">
        <img src="https://img.shields.io/github/downloads/TracingOrigins/obsidian-music-player-plugin/total?logo=github" alt="GitHub Downloads">
    </p>
    <p>[<a href="https://github.com/TracingOrigins/obsidian-music-player-plugin/blob/master/README.zh.md">中文</a> | English]</p>
    <p><a href="https://community.obsidian.md/plugins/music-player" target="_blank">Music Player</a> is an Obsidian sidebar plugin for playing local music files, combining local library management, lyrics display, playlists and favorites, and playback mode controls.</p>
</div>

## Features

### Audio playback

- **Multiple formats**: MP3 / WAV / OGG / M4A / FLAC / AAC
- **Playback controls**: Play / pause, previous / next track
- **Progress and time**: Progress bar with current / total duration
- **Playback speed**: Adjustable from 0.5x to 2.0x
- **Volume**: Mute, 25%, 50%, 75%, 100%
- **Queue**: View the current queue and switch tracks quickly

### Playback modes

- **Sequential**: Play in list order; stop when the list ends
- **Loop list**: Restart from the beginning when the list ends
- **Loop one**: Repeat the current track
- **Shuffle**: Play tracks in random order

### Library management

- **All tracks**: Every scanned music file
- **Favorites**: One-tap favorites for quick access
- **Playlists**: Create / edit / delete custom playlists
- **Artists**: Tracks grouped by artist
- **Albums**: Tracks grouped by album
- **Search**: Search tracks, artists, and albums

### Lyrics

- **Source**: Lyrics are **read only from embedded metadata in audio files**. The plugin does not read external lyric files from disk and does not fetch lyrics online.
  - **Standard lyrics**: Standard LRC-style lyrics in tags
  - **Word-by-word lyrics**: Timestamped syllable/word lyrics (karaoke style)
- **Display**:
  - **Three-line view**: Previous line, current line, next line
  - **Full-screen lyrics**: Full list with auto-scroll and highlight
- **Sync**: Lyrics follow playback position automatically

> For detailed lyric formats, see **[Lyrics format](#lyrics-format)** below.

### UI and interaction

- **Album art**: Embedded or folder-based art with optional spinning disc animation
  - Cover resolution order:
    1. An image file named `cover` in the same folder as the track (e.g. `cover.jpg`, `cover.png`, case-insensitive)
    2. An image in the same folder with the same basename as the track (e.g. `song.mp3` → `song.jpg`)
    3. Embedded cover art from the audio file’s metadata
- **Disc transition animation**: When using previous/next or shortcuts, the disc shows a sliding transition
- **Disc view**: Full-screen disc-style playback UI
- **Lyrics view**: Focused lyrics screen
- **Responsive layout**: Works on desktop and mobile
- **Keyboard shortcuts**: See **[Keyboard shortcuts](#keyboard-shortcuts)** below

### Settings

- **Music folder**:
  - Search and pick a music folder;
  - Click the input to browse the folder list;
  - If left empty, the whole vault is scanned (for large vaults, a dedicated music folder is recommended).
- **Autoplay on open**: Whether to auto-play the first track when opening the player
- **Default playback mode**: Initial mode configurable in settings

### Auto-sync and indexing

- **File watching**: Watches for create, delete, rename, and move of music files
- **Library updates**: Updates library data when files move in or out of the music folder
- **Consistency check**: On startup, checks index vs. the file system
- **Rebuild hint**:
  - When a rebuild is suggested, a small dot appears on the rebuild control;
  - You can tap rebuild manually to re-index.

---

## Installation

### Manual install

For **local development builds** or when the plugin is not yet in the community catalog:

1. Go to [Releases](https://github.com/TracingOrigins/obsidian-music-player-plugin/releases) and download the latest plugin archive or files.
2. Extract / place the plugin folder under your Obsidian plugins directory (typically:
  - `<Your vault>/.obsidian/plugins/music-player/`).
3. In Obsidian, open **Settings → Community plugins → Installed plugins** and enable this plugin.

### Install with BRAT (recommended for testers)

For **beta / latest dev** builds:

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. In BRAT settings, choose **Add beta plugin**.
3. Enter the repo: `TracingOrigins/obsidian-music-player-plugin`.
4. After install, enable the plugin under **Settings → Community plugins → Installed plugins**.

---

## Usage

### Quick start

1. Enable the plugin (**Settings → Community plugins → Installed plugins**).
2. Click the music icon in the left ribbon, or use the command palette and run **Open music player**.
3. On first use, set a **dedicated music folder** in plugin settings (recommended):
  - Optional: leave empty to scan the entire vault for audio files.
4. Click any track in the list to start playback.

### Lyrics format

The plugin reads these lyric formats from **embedded tags** in audio files:

> **Note:** The plugin does **not** read standalone `.lrc` files next to tracks and does **not** download lyrics; only embedded lyric tags are parsed.

- **Standard (LRC-style) lyrics**
  Example:
  ```text
  [02:22.94]外婆她的期待
  [02:26.14]慢慢变成无奈
  [02:29.08]大人们始终不明白
  [02:34.97]她要的是陪伴
  [02:37.97]而不是六百块
  [02:40.96]比你给的还简单
  ```
- **Word-by-word (karaoke-style) lyrics**
  After the **line start timestamp**, each character or word is wrapped with `<time>`. Example:
  ```text
  [02:23.43]<02:23.43>外<02:23.65>婆<02:23.83>她<02:24.18>的<02:24.71>期<02:24.90>待<02:25.63>
  [02:26.00]<02:26.00>慢<02:26.28>慢<02:26.68>变<02:27.02>成<02:27.40>无<02:27.83>奈<02:28.68>
  [02:29.00]<02:29.00>大<02:29.30>人<02:29.69>们<02:30.03>始<02:30.28>终<02:30.61>不<02:30.83>明<02:31.18>白<02:34.00>
  [02:34.96]<02:34.96>她<02:35.25>要<02:35.65>的<02:36.02>是<02:36.34>陪<02:36.77>伴<02:37.62>
  [02:37.93]<02:37.93>而<02:38.22>不<02:38.53>是<02:38.88>六<02:39.19>百<02:39.63>块<02:40.61>
  [02:40.94]<02:40.94>比<02:41.21>你<02:41.55>给<02:41.96>的<02:42.31>还<02:42.68>简<02:43.03>单<02:44.84>
  ```

### Playback queue

Use the **queue / playlist button** in the bottom control bar to:

- See all tracks in the current queue;
- Search within the queue;
- Tap any row to switch playback;
- See cover, title, artist, and album for each item;
- Highlight the currently playing track.

### Keyboard shortcuts

When the music player view is focused:

- **Space**: Play / pause
- **↑**: Previous track
- **↓**: Next track
- **←**: Seek back 5 seconds
- **→**: Seek forward 5 seconds
- **Ctrl + ←**: Seek back 15 seconds
- **Ctrl + →**: Seek forward 15 seconds

(Exact bindings may follow Obsidian’s shortcut UI; future versions may add or change shortcuts.)

---

## FAQ

#### Q: What does the small dot on the rebuild control mean?

**A:** The index may be out of sync with the file system; a manual rebuild is recommended. Common causes:

- Music files deleted outside Obsidian (e.g. in File Explorer);
- Files moved or renamed without the index updating;
- Corrupt or incomplete index data.

**What to do:**

1. Tap **Rebuild index** (with the dot) to rebuild;
2. The dot disappears when rebuild finishes.

**Note:** Even without rebuilding, the library list reflects the file system in real time (removed files disappear from the list). Rebuild mainly cleans stale index entries and refreshes metadata.

---

## Development

- Clone the repo:
  - `git clone https://github.com/TracingOrigins/obsidian-music-player-plugin.git`
- Node.js **v16+** (current LTS recommended):
  - `node --version`
- Install dependencies:
  - `npm install`
- Dev (recommended):
  - `npm run dev`
  - Runs `node scripts/deploy.mjs dev`, symlinks `dist` into your vault, and runs the bundler in watch mode for local iteration.
- Production build and deploy to test vault:
  - `npm run build`
  - Runs TypeScript checks and production build, then `node scripts/deploy.mjs build` copies `dist` outputs into the vault plugin folder for testing or release.

> The deploy script reads `.env` at the project root. Set:  
> `VAULT_PATH=/path/to/your/Obsidian/vault`.  
> Plugin id comes from `manifest.json`; files end up at `<VAULT_PATH>/.obsidian/plugins/<pluginId>/`.

---

## Tech stack

- **TypeScript**
- **React** for UI
- **Obsidian API** for plugin integration
- **HTML5 Audio** for playback
- **esbuild** for bundling

---

## 📄 License

This project is licensed under the MIT License. See the [LICENSE](https://github.com/TracingOrigins/obsidian-music-player-plugin/blob/master/LICENSE) file for details.

---

## 🌟 Support & Help

If you find this plugin helpful, please consider:

- ⭐ **Starring** the repository.
- 🐛 Using the [bug report template](https://github.com/TracingOrigins/obsidian-music-player-plugin/issues/new?template=bug_report.md) to submit bug reports.
- 💡 Using the [feature request template](https://github.com/TracingOrigins/obsidian-music-player-plugin/issues/new?template=feature_request.md) to submit feature suggestions.
- ❓ Asking questions or sharing ideas in our [Discussions](https://github.com/TracingOrigins/obsidian-music-player-plugin/discussions).
- 📝 Referring to the [Contributing Guide](https://github.com/TracingOrigins/obsidian-music-player-plugin/blob/master/docs/contributing/contributing.md) to contribute code or documentation.
- 💰 Providing [sponsorship](https://support.tracingorigins.top) to the developer (if available).