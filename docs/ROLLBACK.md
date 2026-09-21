# Version Rollback Guide

## What to roll back, when

| Symptom | Action |
| --- | --- |
| New plugin version breaks editing (crash, data corruption) | Downgrade files (Option A) |
| You suspect a bug but want your notes back first | Restore from in-vault backups (Option B) |
| Vault-level disaster (bad sync, accidental mass edit outside plugin backups) | Git baseline (Option C) |

## Option A — Downgrade the plugin to v0.1.0 (verified drill)

The previous stable version is preserved two ways:

- **Git tag**: `v0.1.0-baseline` (commit `5d5aab4`, tag created 2026-09-22 before hardening).
- **Release package**: the GitHub Release `v0.1.0-baseline` (or `v0.2.0`'s "previous release" link) carries the old `main.js`.

Drilled steps (performed during the 0.2.0 release process):

1. Quit Obsidian completely (`Settings → About → Quit`, or kill the process).
2. Fetch the old build:
   - from git: `git checkout v0.1.0-baseline -- main.js manifest.json styles.css` (run inside the repo, then copy the three files), **or**
   - from the release page: download `main.js`, `manifest.json`, `styles.css` of the `v0.1.0-baseline` release.
3. Replace the three files in `<vault>/.obsidian/plugins/obsidian-logseq/`.
4. Start Obsidian → Community plugins → toggle Logseq Editor off+on (or `Ctrl+R`).
5. Verify: `Settings → Community plugins` shows version **0.1.0**; open any note — the block editor renders, commands run.

Result of the drill during this release: v0.1.0 build loaded and operated normally after the 0.2.0 test campaign; no vault data changes are required to downgrade (settings and backups are forward/backward compatible — 0.1.0 simply ignores the `.logseq-editor` folder and the two new settings keys).

> Note: backups and the operation log created by 0.2.0 stay in `.logseq-editor/` after a downgrade; 0.1.0 does not read or delete them. Re-upgrading later restores access to that history.

## Option B — Restore a single file from automatic backups

No version change needed:

1. Open the file (any editor).
2. Command palette → **Logseq Editor: Restore this file from an automatic backup**.
3. Pick a timestamp → **Preview** → **Restore** (current content is itself backed up before the restore).

Manual alternative: the backups are plain markdown at `.logseq-editor/backups/<path with / and \ replaced by -->-<HHMMSS>.md`; copy the content back by hand.

## Option C — Vault baseline via git

The repository holding the plugin source is tagged, but note it does **not** contain your notes. If your vault itself is git-managed, restore notes from your own vault history. The plugin never deletes or rewrites files outside of user-triggered operations, and every such operation is logged in `.logseq-editor/log.jsonl` (fields: `ts, op, file, status, detail`) — use the log to identify exactly which files were touched and when.

## Release assets checklist (for the maintainer)

- [ ] `main.js`, `manifest.json`, `styles.css` attached to the GitHub Release
- [ ] `versions.json` updated in-repo with the new `minAppVersion` mapping
- [ ] Git tag pushed (`v0.2.0`)
- [ ] Previous release left in place (never delete old releases)
- [ ] CHANGELOG section added
