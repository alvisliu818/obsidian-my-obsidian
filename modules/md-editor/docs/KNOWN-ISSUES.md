# Known Issues & Risks

Status at v0.2.0 (2026-09-22). Severity: 🔴 blocks release · 🟠 workaround exists, fix planned · 🟡 cosmetic/edge.

## Functional

- 🟡 **Org-mode drawers are preserved verbatim, not converted.** `:PROPERTIES:`/`:id:` lines inside a block become part of the block's raw text rather than Logseq-style properties. Workaround: convert `:id:` drawers to `id::` lines manually when migrating a file. (Covered by fixture tests to ensure no crash/data loss.)
- 🟡 **Dataview coexistence guard** skips block-ref/embed enhancement inside ```` ```dataview ```` blocks; if the Dataview plugin is missing, those blocks render as plain code with a hint banner.
- 🟡 **Duplicate block ids**: last one indexed wins for `((ref))` navigation. Deterministic (index rebuild order = file order), no data impact. Fixture-tested.
- 🟡 **Unterminated code fences** swallow subsequent list lines into the block's text (CommonMark-ish behavior). The file is never altered unless you edit; reopen in native editor to fix the fence.

## Performance

- 🟡 **Very large files** (>1 MB): virtualized rendering keeps interaction smooth; the initial full-file parse is synchronous and measured at ~1.7 MB / ~30k blocks in well under the 10 s CI budget (actual: ~2 s on the test machine). Files > 2 MB are skipped by the query index by design.

## Platform

- 🟠 **Mobile** loads without crashing but is not feature-complete (desktop-only plugin flag is set; drag & drop and some context-menu paths assume a pointer).
- 🟡 **Obsidian ≥1.13 / Electron ≥39 automation**: Playwright's `_electron.launch` no longer attaches (Chromium removed `--remote-debugging-pipeline`); our E2E uses CDP attach instead. End users are unaffected; this note is for contributors running `npm run e2e`.

## Safety-layer notes

- 🟡 **Backup pruning is per-file (10)** — a file edited many times in one second gets suffixed backups (`-1.md`, `-2.md`) and older states roll off faster than wall-clock time suggests.
- 🟡 **The operation log ring keeps 500 in-memory records**; the on-disk JSONL keeps everything up to the 256 KB rotation (one previous generation kept). Export before deleting `.logseq-editor/` if you need the full trail.
- 🟡 **Conflict modal appears only when you have unsaved local edits** at the moment an external change lands; otherwise the external version is adopted silently (by design — that is the non-destructive path).

## Out of scope (explicitly, this release)

- Submitting to the official community plugin store (pending author decision).
- Logseq DB-version / cloud sync interop.
- Architecture rewrites or license changes.
