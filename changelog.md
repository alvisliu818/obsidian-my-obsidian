# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [semver](https://semver.org).

## [0.2.0] — 2026-09-22

Production-readiness release: write-safety layer, operation trail, hardened error handling, full test matrix (195 unit + 21 real-Obsidian E2E), complete docs.

### Added

- **Automatic pre-write backups** (`src/core/backup.ts`, `backupPure.ts`): every guarded write path snapshots the original to `.logseq-editor/backups/<path>--<HHMMSS>.md`; 10 most-recent per file kept (pruning plan unit-tested); restore UI with preview (`.logseq-editor` is a dot-folder, so vault search/graph are not polluted; all backup IO goes through the adapter API because the vault API does not index dot-folders).
- **Operation log** (`src/core/operationLog.ts`, `src/features/logger.ts`): append-only JSONL trail `.logseq-editor/log.jsonl` (auto-rotates at 256 KB), in-memory ring (500), viewer modal with export-to-`.log`, records every edit/move/backup/review/journal-create/plugin-load with ts/op/file/status/detail.
- **New commands**: `Show the operation log`, `Restore this file from an automatic backup`, `Browse all automatic backups`.
- **Settings**: `Automatic backups`, `Operation log` toggles; settings loader now sanitizes corrupt/legacy `data.json` values (debounce, string fields, boolean flags).
- **Once-per-session pre-edit snapshot** of every file the block editor touches (ensures a restorable pre-session original even if only debounced saves follow).
- **Test suite**: +41 unit tests (operation log encode/decode/ring/format, backup naming/pruning, edge-vault fixture invariants incl. 1.7 MB huge-file parse round-trip); acceptance E2E (8 scenarios: commands, log modal, settings persistence across disable/enable, write→backup, log trail on disk, restore via UI, reopen idempotency, hard-kill mid-debounce integrity); edge-vault E2E (13 hostile samples opened in real Obsidian with zero pageerrors).
- **Edge fixture vault generator** (`tests/fixtures/make-edge-vault.mjs`): 13 hostile samples — empty, whitespace-only, unclosed frontmatter, broken YAML (tabs/dup keys/anchor), org-mode drawers, ZWJ/RTL/CJK/control chars, circular `{{embed}}`, 200-level nesting, CRLF, mixed indent, unterminated fence, duplicate block ids, 1.7 MB generated monster.
- **E2E infrastructure**: CDP-attach runner for Obsidian ≥1.13 (Electron 39 removed the old Electron pipeline), vault-registry switcher with automatic backup/restore of the user's `obsidian.json`, trust-dialog handling for localized vaults.

### Fixed

- **Backup dir creation**: `adapter.mkdir` throws when the folder already exists — ensureDir now probes with `exists` first (was silently disabling all backups after the first session).
- **Cross-file embed edits** now go through the guarded write path (backup + log) instead of raw `vault.modify`.
- **Flashcard review writes** and **move-to-file appends** now back up the target file first and record the operation.
- Journal creation failures are logged (previously silent).
- Backup prune order fixed (oldest-first deletion, matching the documented contract).

### Security

- Self-check against Obsidian plugin review guidelines: no `eval`/`Function` constructor, no network requests, no remote code, no innerHTML with dynamic content additions (verified by grep audit — see `docs/REVIEW-SELF-CHECK.md`).

### Verification highlights

- `npm test` → **195/195 passing**; `npm run build` → zero errors (tsc strict + esbuild).
- Real Obsidian 1.13.7 desktop: acceptance E2E **8/8**, edge-vault E2E **13/13** (zero uncaught exceptions across hostile inputs).
- Rollback target preserved: git tag `v0.1.0-baseline`; downgrade drill documented in `docs/ROLLBACK.md`.

## [0.1.0] — baseline

Initial feature-complete implementation (Logseq-style outliner, block refs/embeds, queries, journals, flashcards, templates) plus partial hardening from the earlier development sprint.
