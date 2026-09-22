# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [semver](https://semver.org).

## [0.2.4] — 2026-09-22

Embed-Enter fix (completed), page-props empty-state affordance, unlinked-mentions section.

### Fixed

- **Enter on an embedded block still only committed**: the v0.2.3 wiring was half-done — `startEmbedEdit` never passed the `onCommitAndNew` callback, so the embed's Enter fell back to plain commit. Now wired; semantics refined: Enter below an embed creates a NEW EMPTY BLOCK in the **host page**, directly below the block containing the embed (cross-file and same-file embeds behave identically), and focuses it. Verified live: new block inserted at the host index, focused, persisted.
- **Embed resolve race**: `resolveEmbed` gave up when the vault-wide index hadn't scanned the target file yet (fresh vaults, recently created blocks); it now retries once after 300 ms before showing the is-broken state.

### Added

- **Page-props empty state**: pages without properties now show the compact props card with a hint and the pencil affordance — the "first block as page properties" entry point; adding the first property works straight from the card (guarded write path).
- **Unlinked mentions section** (`src/features/unlinkedMentions.ts`): below the linked mentions, the page bottom now lists blocks whose plain text mentions this page's title without an existing `[[link]]` (title ≥ 3 chars, occurrence count per row, ±40-char context preview, max 50 rows).
- **One-click convert**: clicking an unlinked mention rewrites the first bare occurrence into `[[title]]` through the guarded write path (backup + operation log); the mention leaves the list on the next index refresh; lines already containing the title inside a `[[ ]]` are never double-linked.

### Verification

- 208/208 unit tests; real-Obsidian E2E 40/40: iter2 3/3 (embed Enter, props empty-state, unlinked convert) + regression 37/37 (acceptance 8, iter 6, UX 4, edge 13, parity 6).

## [0.2.3] — 2026-09-22

Editing-flow round: Enter behavior parity, page/block backlinks UI, block props display, editable page properties.

### Fixed

- **Enter exited the editor instead of creating a block**: two stacked root causes. ① `manifest.json` was saved with a UTF-8 BOM by a PowerShell write, so Obsidian failed to parse it and the whole plugin silently didn't load (`loaded: false` — takeover, commands, everything). ② With the plugin actually loading, CM6 fires a spurious `blur` right after the initial editor mount when the Electron window is not OS-focused; the view committed and tore the editor down on that phantom blur. Both fixed: BOM stripped (and all repo JSONs audited), and `onFocusedBlur` now re-checks focus on the next task before committing — a real blur still commits instantly.
- Enter now behaves Logseq-style everywhere: split at caret, new block focused below, embedded-block Enter creates a sibling below the source block (same-file embeds; cross-file embeds commit only).

### Added

- **Page-bottom backlinks section**: `N linked mentions` header under the outline, grouped by source page (icon + path, click to jump), each row shows marker + text and jumps to the referencing block via its `id::`.
- **Block-level backlinks**: blocks referenced via `((id))` get a count badge on the row's right side; click expands an inline panel directly under the block listing each referencing page/block with a jump link; independent expand/collapse per block, multiple panels can be open at once, counts update live on index rebuilds.
- **Block properties row**: `key:: value` pairs render under the block content (skip-list: `id`, `collapsed`, `style` are shown by their own UI affordances instead).
- **Editable page-properties card**: the page-props header is now editable — pencil enters edit mode with key/value inputs per row, delete buttons, an add-row, Save/Cancel; writes go through the guarded write path (automatic backup + operation log) and the view reloads from disk after saving.

### Verification

- 208/208 unit tests; real-Obsidian E2E 37/37: iteration suite 6/6 (Enter persistence, mid-block split, page-bottom backlinks, badge expand/collapse, props row, page-props editing) + regression suites 31/31 (acceptance 8, edge 13, parity 6, UX 4).

## [0.2.2] — 2026-09-22

UX round: last-node indent fix, reading-mode typography parity, self-drawn slash & angle command menus.

### Fixed

- **Last node could not be indented**: blocks created/promoted after the last root registration (Enter/split at page end, outdent/move to top level) were missing from the sibling registry, so Tab silently did nothing. `siblingsOf` now falls back to structural lookup over registered root arrays (7 new unit tests incl. single-node, deep-nested, restore-path edge cases).
- **Reading mode line spacing much larger than editing mode**: static markdown renders inherited Obsidian's `.markdown-rendered` paragraph margins and line-height. The whole static subtree is now pinned to the editor's vertical rhythm (line-height 1.55, paragraph gap 0; lists/headings/quotes/code tuned to match).

### Added

- **Self-drawn command menu** (`src/features/commandMenu.ts`): CM6's tooltip layer does not render inside the host DOM (verified: even built-in `[[` completions produced zero tooltip nodes), so `/` and `<` now open an own-DOM menu with type-to-filter, ↑↓ navigation, Enter/Tab execute, Esc/outside-click close.
- `/` slash commands (33): TODO/DOING/DONE, priorities, scheduled/deadline, headings, divider, code block, quote, bold/italic/highlight, today's date, current time, page link, block ref, embed, queries, indent/outdent/new-block/delete-block structure commands, template vars.
- `<` angle commands (16): HTML snippets (div/span/br/mark/u/sub/sup/kbd/center/font/details) and entities (&nbsp;/&lt;/&gt;/&amp;/&copy;).
- Prose safety: a bare `<` between words (`x < y`) is never rewritten; menus only trigger at line-start/whitespace.

### Verification

- 208/208 unit tests; real-Obsidian E2E: UX 4/4 (last-node indent + persistence, slash menu, angle menu, typography metrics), acceptance 8/8, edge-vault 13/13, parity 6/6.

## [0.2.1] — 2026-09-22

Logseq md 版功能对齐轮（本地交付，不涉及 GitHub/市场/org-mode/DB）。

### Added

- **Tags panel**（`logseq-tag-panel` 视图 + "Open the tags panel" 命令）：全库 #tag 标签云，点击过滤，点击块跳转。
- **Journal prev/next navigation**："Open previous/next daily note" 命令，日期锚定当前打开文件（YYYY-MM-DD / YYYYMMDD 文件名），跨月/年/闰年安全（`src/core/journalDate.ts` 纯函数 + 6 项单测）。
- **Page properties card**：文件首屏 `key:: value` 属性渲染为只读卡片（不进大纲、不改磁盘）。
- **Collapse all / expand all**：3 条命令 + Ctrl+\ 快捷键，`collapsed:: true` 落盘往返。
- **Unlinked mentions**：反链面板第二个 tab（标题文本匹配且无 [[链接]] 的块）。
- 新增 E2E：parity-core（5 项新功能）+ parity-roundtrip（文件往返一致性，独立实例）。

### Verification

- 201/201 单测；真实 Obsidian 回归：验收 8/8、边界 13/13、parity 6/6。

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
