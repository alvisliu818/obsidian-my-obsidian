# Media Recorder

**Media Recorder** is an in-app recorder designed for Obsidian. It provides a lightweight, dockable workspace panel to record daily webcam reflections, screen captures, and voice memos directly into your vault notes.

Whether you are conducting daily study reviews, documenting practical labs, or keeping a quick audio diary, Media Journal streamlines the capture workflow without cluttering your system with third-party recording software.

---

## Features

- **Dockable & Movable Interface:** Lives inside Obsidian's workspace leaves. Place it in the right or left sidebar, dock it as a tab, or pop it out into an independent floating window.
- **Multiple Capture Sources:**
  - **Webcam:** Record video reflections using your device camera.
  - **Screen Capture:** Capture your desktop or specific application windows alongside microphone narration.
  - **Audio Only:** Record lightweight `.webm` voice notes to save storage space.
- **Picture-in-Picture (PiP):** Pop out the live video preview to monitor your camera while writing or reading notes in full screen.
- **Dynamic Quality & Size Optimization:** Switch between **Low**, **Normal**, and **High** quality profiles to aggressively limit bitrates and keep your vault file sizes small.
- **Microphone Echo Prevention:** Built-in live audio mute toggle so you don't hear your own feedback during recording.
- **Pause & Resume:** Built-in timer with full pause and resume control, producing a single combined file.
- **Automatic Note Embedding:** Automatically inserts a markdown embed link (`![[recording.webm]]`) right where your cursor is placed in your active note.
- **Configurable Save Directory:** Specify a custom folder path in settings (e.g., `Media/Daily Recordings`). The plugin creates the folder automatically if it does not exist.

---

## Installation

### From Community Plugins (Once Approved)
1. Open Obsidian **Settings**.
2. Navigate to **Community plugins** and turn off **Safe mode**.
3. Click **Browse** and search for `Media Recorder`.
4. Click **Install**, then **Enable**.

### Manual Installation
1. Download the latest release assets (`main.js` and `manifest.json`) from the [Releases](https://github.com/Alaxanalax10/obsidian-media-journal/releases) tab.
2. Navigate to your vault folder: `<VaultFolder>/.obsidian/plugins/`.
3. Create a new folder named `obsidian-media-journal`.
4. Place `main.js` and `manifest.json` inside this folder.
5. In Obsidian, go to **Settings > Community plugins** and enable **Media Journal**.

---

## How to Use

1. Click the **Camera** icon in the left ribbon to reveal the Media Recorder panel.
2. Select your desired **Source** (*Webcam*, *Screen Capture*, or *Audio Only*).
3. Select your preferred **Quality** setting (*Low*, *Normal*, or *High*).
4. Click **Start Preview** to initialize the hardware stream.
5. Click **Record** to begin capturing.
6. Use **Pause** / **Resume** as needed.
7. Click **Stop & Save**. The recording will save to your vault and automatically embed into your active note if the option is checked.

---

## Settings

- **Save Folder:** Define the vault folder where your media files are stored. Defaults to `Video Journals`.

---

## 💬 Feedback and Reviews

Your feedback drives the development of Media Journal! Since Obsidian doesn't have a built-in rating system, I rely on the community to tell me what works and what needs improving.

- **Found a bug?** [Open an Issue](https://github.com/Alaxanalax10/obsidian-media-journal/issues) so I can squash it.
- **Have a feature idea?** [Start a Discussion](https://github.com/Alaxanalax10/obsidian-media-journal/discussions) to request new capabilities.
- **Love the plugin?** Please consider starring the repository on GitHub! It helps others discover the tool.

## Development

If you want to contribute or build the plugin locally:

1. Clone this repository:
   ```bash
   git clone [https://github.com/Alaxanalax10/obsidian-media-journal](https://github.com/Alaxanalax10/obsidian-media-journal.git)