# Logseq Editor for Obsidian

[![Tests](https://img.shields.io/badge/tests-195%20passing-brightgreen)]() [![E2E](https://badgen.net/badge/E2E%20(real%20Obsidian)/21%20passing/blue)]() [![Version](https://img.shields.io/badge/version-0.2.0-blue)]()

A [Logseq](https://logseq.com)-style **block outliner editor** for [Obsidian](https://obsidian.md) — replaces the native markdown editor with outliner blocks, block references, and Logseq-compatible journaling. A superset: **switch back to the native editor anytime; files stay 100% standard markdown.**

## Why

- Your vault remains plain markdown files; the plugin only changes how they are **edited and rendered**.
- Logseq muscle memory works: outline blocks, `TODO/DOING/DONE`, `id::` block properties, `((block refs))`, `{{embed ((id))}}`, `[[links]]`, `#tags`, journals.
- Safety-first v0.2.0: automatic pre-write backups, a full operation log trail, and a restore UI.

## Features

| Area | What you get |
| --- | --- |
| Outliner editing | Logseq-style blocks with Tab/Shift+Tab indent, drag & drop, multi-select bulk ops, zoom-in, collapse |
| Markers | `TODO / DOING / DONE` cycling (Ctrl+Enter), Tasks panel |
| Block ids & refs | `id::` properties, `((id))` chips, `{{embed ((id))}}` live embeds, in-place embed editing, block graph & backlinks panel |
| Properties | `key:: value` block props and page props; `priority/scheduled/deadline` power a query engine |
| Queries | `{{query}}` blocks with Logseq-compatible filters (and/or/not, priority, tags, links) |
| Journals | Open/create today's journal (folder/format/template configurable; falls back to core Daily notes settings) |
| Flashcards | `#card` blocks with SM-2 spaced repetition (`memory-*` props) |
| Templates | `<% today %>`, `<% time %>`, custom vars; journal template support |
| **Backups (new in 0.2.0)** | Every write path backs up the original first (10 most recent per file) under `.logseq-editor/backups/`; restore via command palette |
| **Operation log (new in 0.2.0)** | Every edit/move/review/backup is recorded to `.logseq-editor/log.jsonl` (auto-rotating); view & export in-app |
| **Conflict safety (existing, hardened)** | External file changes detected while you have unsaved edits → merge modal; never silently overwritten |

## Requirements

- Obsidian **desktop** ≥ 1.5.0 (tested on current stable 1.13.7). Mobile loads but is not feature-complete.
- No network access, no remote code, no eval — see [Security & review self-check](docs/REVIEW-SELF-CHECK.md).

## Installation

### From a release package (recommended)

1. Download the latest release assets from the GitHub Releases page: `main.js`, `manifest.json`, `styles.css`.
2. In your vault: `Settings → Community plugins` — make sure *Restricted mode* is off.
3. Open the plugins folder: click the folder icon on the Community plugins page (or open `<vault>/.obsidian/plugins/` in your file manager).
4. Create a folder `obsidian-logseq` and copy the three files into it.
5. Back in Obsidian, enable **Logseq Editor** in Community plugins.
6. Reload Obsidian (or press `Ctrl+R`) once after copying files.

### From source

```bash
git clone <this repo>
cd obsidian-logseq
npm install
npm run build        # type-checks + bundles to main.js
```
Then copy `main.js`, `manifest.json`, `styles.css` from the repo root into `<vault>/.obsidian/plugins/obsidian-logseq/` as above.

## Quick start

1. Enable the plugin. With **Take over markdown files** on (default), every markdown file opens in the block editor.
2. Click any bullet to edit; `Tab`/`Shift+Tab` to indent; `Ctrl+Enter` cycles TODO; type `((` for block refs, `[[` for links, `/` for the slash menu, `{{query}}` for live queries.
3. Ribbon buttons: list-tree = toggle block/native editor; calendar = today's journal.

## Configuration

Settings → **Logseq Editor**:

| Setting | Default | Meaning |
| --- | --- | --- |
| Take over markdown files | on | Open .md files with the block editor by default |
| Excluded folders | — | Comma-separated paths that keep the native editor |
| **Automatic backups** | on | Pre-write backups to `.logseq-editor/backups/` (10/file) |
| **Operation log** | on | Append trail to `.logseq-editor/log.jsonl` (rotates at 256 KB) |
| Journal folder / format / template | — | Daily-note location, date format (YYYY-MM-DD tokens), new-file template |
| Custom template variables | — | `name = value` lines, usable as `<% name %>` |

All settings persist in `data.json` and survive plugin reloads and Obsidian restarts (verified by E2E test 03).

## Commands

Command palette (`Ctrl+P`) — plugin commands are prefixed *Logseq Editor*:

- Open current file with the block editor / native editor
- Show the operation log · Restore this file from an automatic backup · Browse all automatic backups
- Rebuild block reference index · Search blocks across the vault · Open the block reference graph
- Open the tasks / backlinks / flashcard panels · Open today's journal · Find(/replace) in page
- Block commands: zoom in/out, toggle collapse, cycle TODO (act on the focused block)

## Data safety & recovery

- **Backups**: before the plugin writes a file (edit save, flashcard review, block move, embed edit, restore), the original is copied to `.logseq-editor/backups/<path>-<HHMMSS>.md`. The 10 most recent per file are kept.
- **Restore**: command palette → *Restore this file from an automatic backup* → Preview/Restore/Delete. Restores are themselves backed up first.
- **Interrupted writes**: writes go through Obsidian's atomic `vault.process`; a hard kill mid-edit leaves either the previous or the new complete file — never a torn state (verified by E2E test 08 which SIGKILLs Obsidian mid-debounce).
- **Operation log**: command palette → *Show the operation log* → view newest 300 records, export a timestamped `.log`, or read `.logseq-editor/log.jsonl` directly (JSONL, one record per line: `ts, op, file, status, detail`).
- **Backups live in a dot-folder**: Obsidian's file indexer ignores `.logseq-editor/`, so your search & graph stay clean; the plugin reads/writes it via Obsidian's adapter API.

## Uninstall

1. Settings → Community plugins → Logseq Editor → toggle off (and/or the trash icon to remove files).
2. Optional cleanup of plugin data: delete the `.logseq-editor` folder in your vault root (contains backups + operation log). **If you want the backups, export/copy them before deleting.**
3. No other vault files are created or modified by uninstalling.

## Known limitations

- Org-mode files: `#+TITLE` lines and `:PROPERTIES:` drawers are preserved as raw text (parser keeps them verbatim; they are not converted into Logseq properties).
- The block editor intentionally replaces the native editing surface; files with very heavy Dataview usage render Dataview blocks but block-ref/enhancement passes are skipped inside them (coexistence guard).
- Files > 2 MB are indexed for queries/refs but may render slower (virtualized rendering mitigates this; a 1.7 MB / ~30k-block sample is covered in E2E).
- Mobile: plugin loads without crashing, but is not feature-complete there (desktop-only official stance).

See [KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) for the full list with severity and workarounds.

## Development

```bash
npm install
npm test          # 195 unit tests (vitest)
npm run build     # tsc + esbuild production bundle
npm run e2e       # real-Obsidian E2E; requires OBSIDIAN_PATH + OBSIDIAN_VAULT env
```

- `src/core/` parser/serializer/treeOps — pure, unit-tested; the parser guarantees `parse(serialize(parse(x)))` idempotence.
- `tests/fixtures/make-edge-vault.mjs` regenerates the hostile-sample vault (empty/broken YAML/org-mode/huge/special chars/circular embed/...).
- E2E runs against a real Obsidian desktop via CDP (`tests/e2e/*.spec.ts`); the runner switches vaults through `%APPDATA%\obsidian\obsidian.json` with automatic backup/restore of your registry (`use-vault.mjs`).

## License

MIT
