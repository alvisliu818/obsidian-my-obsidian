# Obsidian Plugin Review — Self-Check

Date: 2026-09-22 · Version: 0.2.0 · Against: [Obsidian plugin developer docs](https://docs.obsidian.md/Reference/Plugin+guidelines) and the community-plugin review checklist.

## Automated grep audit (evidence)

Commands run against `src/` and the production `main.js`:

| Check | Pattern | Result |
| --- | --- | --- |
| No eval / new Function | `eval(`, `new Function` | **0 hits** in src |
| No dynamic remote code | `require(http`, `import(`, `fetch(`, `XMLHttpRequest` | **0 hits** in src |
| No network calls | `http.`, `https.`, `requestUrl`, `net.request`, `fetch(`, `XMLHttpRequest` | **0 real hits**; grep shows 8 matches, all `document.createElementNS('http://www.w3.org/2000/svg', …)` — the SVG **namespace identifier**, not a network URL |
| No child process / node access | `child_process`, `require('fs')`, `require('os')` | **0 hits** in src |
| No innerHTML with variables | `innerHTML =` | only constant SVG strings (`EMBED_CARET_SVG`, caret icons) — static, no user data |
| Externalized modules | esbuild config | only `obsidian`, `electron`, node builtins marked external; `@codemirror/*`, `@lezer/*` bundled (mounted on plugin-owned DOM, never mixed with Obsidian's internal CM6) |

## Checklist

| Guideline | Status | Notes |
| --- | --- | --- |
| Plugin has a single `Plugin` subclass entry, clean `onload`/`onunload` | ✅ | `src/main.ts`; unload restores the patched `setViewState` and converts views back |
| No eval, no remote code loading | ✅ | grep audit above |
| No network requests | ✅ | none; nothing to declare in `manifest.json` |
| Minimal permissions / API surface | ✅ | Uses vault/workspace/plugin APIs only; all file IO via `vault.adapter` within the vault |
| `manifest.json` fields correct | ✅ | id `obsidian-logseq`, version `0.2.0`, minAppVersion `1.5.0`, `isDesktopOnly: true`; `versions.json` maps min versions |
| Data stored inside the vault | ✅ | `.logseq-editor/` (backups, JSONL log) — nothing outside the vault, no telemetry |
| Settings persist via `this.loadData/saveData` | ✅ | sanitize pass guards corrupt/legacy data |
| User-facing errors are Notices, not silent failures | ✅ | All guarded writes log + Notice on failure; conflicts raise a modal |
| Destructive actions are reversible | ✅ | every plugin write preceded by an automatic backup; restores re-backup first |
| No third-party network fonts/CDN assets | ✅ | styles.css is self-contained |
| Commands have unique, kebab-case ids | ✅ | `obsidian-logseq:show-operation-log` etc. |
| Views registered with unique types, detached on unload | ✅ | 4 view types; side panels detached in `onunload` |
| No `innerHTML` with untrusted content | ✅ | user text rendered through Obsidian `MarkdownRenderer`, not raw HTML injection |
| File format stays standard markdown | ✅ | Logseq-style conventions (`- `, `id::`) are plain text; no proprietary wrapping |

## Known deviations & justifications

- **`WorkspaceLeaf.prototype.setViewState` monkey-patch** (take-over mode): necessary to intercept file opens; original reference is restored on unload (E2E test 03 disables/enables the plugin to verify no double-patching).
- **Dot-folder data directory**: Obsidian's vault indexer ignores `.logseq-editor/`; this is intentional (keeps search/graph clean) and all IO uses the officially available `DataAdapter` API.
- **Bundled CodeMirror**: plugin owns a separate CM6 instance on its own DOM; double-loading is safe and does not touch Obsidian's internal editor instance.
