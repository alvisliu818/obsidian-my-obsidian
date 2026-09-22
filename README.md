# Logseq Editor

[![Tests](https://img.shields.io/badge/tests-201%20passing-brightgreen)]() [![E2E](https://badgen.net/badge/E2E%20(real%20Obsidian)/28%20passing/blue)]() [![Version](https://img.shields.io/badge/version-0.2.1-blue)]()

A [Logseq](https://logseq.com)-style **block outliner editor** for [Obsidian](https://obsidian.md) — replaces the native markdown editor with outliner blocks, block references, and Logseq-compatible journaling. A superset: **switch back to the native editor anytime; files stay 100% standard markdown.**

## Why

- Your vault remains plain markdown files; the plugin only changes how they are **edited and rendered**.
- Logseq muscle memory works: outline blocks, `TODO/DOING/DONE`, `id::` block properties, page `key:: value` props, `((block refs))`, `{{embed ((id))}}`, `[[links]]`, `#tags`, journals.
- Safety-first: automatic pre-write backups, a full operation log trail, and a restore UI.

## Features

| Area | What you get |
| --- | --- |
| Outliner editing | Logseq-style blocks with Tab/Shift+Tab indent, drag & drop, multi-select bulk ops, zoom-in, collapse |
| Markers | `TODO / DOING / DONE` cycling (Ctrl+Enter), Tasks panel |
| Block ids & refs | `id::` properties, `((id))` chips, `{{embed ((id))}}` live embeds, in-place embed editing, block graph |
| Page properties | Top-of-file `key:: value` rendered as a read-only page-props card (Logseq md parity) |
| Tags | `#tag` autocomplete + vault-wide **Tags panel** with filterable block lists (Logseq md parity) |
| Journals | Today's journal + **previous/next daily note navigation** anchored on the open file (Logseq md parity) |
| Collapse all | `Collapse all` / `Expand all` / toggle (Ctrl+\) — `collapsed:: true` round-trips to disk (Logseq md parity) |
| Backlinks | Linked mentions **and Unlinked mentions** (title text without `[[links]]`) (Logseq md parity) |
| Queries | `{{query}}` / `{{query-table}}` blocks with Logseq-compatible filters |
| Flashcards | `#card` blocks with SM-2 spaced repetition |
| Templates | `<% today %>`, `<% time %>`, custom vars; journal template support |
| Backups | Every write path backs up the original first (10 most recent per file) under `.logseq-editor/backups/`; restore via command palette |
| Operation log | Every edit/move/review/backup recorded to `.logseq-editor/log.jsonl` (auto-rotating); view & export in-app |
| Conflict safety | External file changes while you have unsaved edits → merge modal; never silently overwritten |

## Requirements

- Obsidian **desktop** ≥ 1.5.0 (tested on current stable 1.13.x). Mobile loads but is not feature-complete.
- No network access, no remote code, no eval — see [review self-check](docs/REVIEW-SELF-CHECK.md).

## Installation (local, no marketplace needed)

### From the release package

1. Grab `main.js`, `manifest.json`, `styles.css` from `DELIVERY/release-v0.2.0/` (kept current with the latest build) or a GitHub release if you mirror one.
2. In your vault: `Settings → Community plugins` — make sure *Restricted mode* is off.
3. Open the plugins folder (folder icon on the Community plugins page) and create `obsidian-logseq/`.
4. Copy the three files in, then enable **Logseq Editor** and reload once (`Ctrl+R`).

### From source

```bash
npm install
npm run build        # tsc + esbuild → main.js
npm test             # 201 unit tests
npm run e2e          # real-Obsidian E2E (OBSIDIAN_PATH + OBSIDIAN_VAULT env)
```
Then copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/obsidian-logseq/` as above.

## Quick start

1. Enable the plugin. With **Take over markdown files** on (default), every markdown file opens in the block editor.
2. Click any bullet to edit; `Tab`/`Shift+Tab` indent; `Ctrl+Enter` cycles TODO; `Ctrl+\` collapse/expand all; type `((` for block refs, `[[` for links, `#` for tags, `/` for the slash menu.
3. Ribbon: list-tree = toggle block/native editor; calendar = today's journal.
4. Command palette: *Open previous/next daily note* walks journals day by day from the file you are in.

## Configuration

Settings → **Logseq Editor**:

| Setting | Default | Meaning |
| --- | --- | --- |
| Take over markdown files | on | Open .md files with the block editor by default |
| Excluded folders | — | Paths that keep the native editor |
| Automatic backups | on | Pre-write backups to `.logseq-editor/backups/` (10/file) |
| Operation log | on | Append trail to `.logseq-editor/log.jsonl` (rotates at 256 KB) |
| Journal folder / format / template | — | Daily-note location, date format (YYYY-MM-DD tokens), new-file template |
| Custom template variables | — | `name = value` lines, usable as `<% name %>` |

Settings persist in `data.json` (sanitize-guarded) and survive reloads/restarts (E2E-verified).

## Data safety & recovery

- **Backups**: before any plugin write (edit save, flashcard review, block move, embed edit, restore) the original is copied to `.logseq-editor/backups/<path>-<HHMMSS>.md`; 10 most recent kept.
- **Restore**: command palette → *Restore this file from an automatic backup* → Preview/Restore/Delete (restores re-backup first).
- **Interrupted writes**: writes go through Obsidian's atomic `vault.process`; a hard kill mid-edit leaves either the previous or the new complete file — never a torn state (E2E kills the process tree mid-debounce to prove it).
- **Operation log**: command palette → *Show the operation log* → view newest 300 + export; raw JSONL at `.logseq-editor/log.jsonl`.
- The data folder is dot-prefixed: Obsidian search & graph ignore it; the plugin uses the adapter API (the vault API cannot see dot-folders).

## Uninstall

1. Disable/remove the plugin in Community plugins.
2. Optional: delete `.logseq-editor/` (contains backups + log — export first if needed).
3. Nothing else in the vault is touched.

## Known limitations

- org-mode support is intentionally out of scope: org lines in .md files are kept verbatim as raw text (never parsed, never converted, never lost).
- No Logseq DB-version / cloud sync interop (md-version format only).
- Dataview blocks render via Dataview if installed; block-ref/embed enhancement is skipped inside them.
- Very large files (>2 MB) skip the query index; rendering is virtualized (a 1.7 MB / ~30k-block sample is E2E-covered).

See [KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) and the [parity matrix](DELIVERY/parity-matrix.md) for details.

## Development

```bash
npm install
npm test          # 201 unit tests (vitest)
npm run build     # tsc strict + esbuild production
npm run e2e       # CDP-attached real-Obsidian suites in tests/e2e/
```

- `src/core/` — parser/serializer/treeOps/journalDate: pure, unit-tested; `parse(serialize(parse(x)))` idempotence invariant.
- `tests/fixtures/make-edge-vault.mjs` — regenerates the 13-sample hostile vault.
- E2E drives a real Obsidian desktop via CDP (Electron ≥39 removed the old Playwright pipeline); `tests/e2e/use-vault.mjs` switches vaults with automatic registry backup/restore.

## License

MIT
