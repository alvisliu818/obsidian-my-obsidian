code-link v1.0.4
================

Upstream    https://github.com/observerw/obsidian-code-link
Author      observerw
License     MIT (see LICENSE) — the aggregate plugin is GPL-3.0; MIT is
            permissive and may be redistributed inside it provided this
            notice and the upstream license travel with the code.
Version     1.0.4, minAppVersion 0.15.0
History     grafted whole via `git subtree add` (43 upstream commits are
            reachable with `git log --follow modules/my-code-link`).

What it does
------------
Link to code files from notes like wiki links: hover and embedded previews,
symbol-level links (class / function / method) resolved by tree-sitter
queries (zed .scm files) with tag search in the editor. Supported languages:
C, C++, Go, JavaScript, TypeScript, Rust, Python.

Integration verdict: source-direct (no require bridge)
------------------------------------------------------
The module compiles under the host's strict tsconfig once its `src/...`
alias imports are rewritten (see below). That is the "source-direct" verdict
from the merge playbook, so `src/main.ts` imports it directly and the module
joins the host tsc program. `experimentalDecorators: true` was added to the
ROOT tsconfig for its legacy accessor decorator `@memorize` — no other module
in the aggregate uses decorators, so the flag is inert for them. esbuild
needs no flag: per-file tsconfig discovery picks up this module's own
tsconfig.json, which already enables it.

Changes relative to upstream
----------------------------
Kept whole: processors, modal suggest, importer, settings tab, the .scm
query files, the tests.

1. Alias imports rewritten (13 files, 25 lines). Upstream used the
   `baseUrl: .` convention and imported as `src/lang/tree` etc. The host
   tsconfig's `src/*` path alias is already taken by obsidian-git, so those
   imports would silently resolve to the WRONG files in the host program —
   the usual require-bridge trigger. Here the module is small (32 files) and
   every importing file sits exactly one level under `src/`, so a pure
   rewrite to relative paths (`src/X` → `../X`) removes the alias instead.
   No functional change.

2. `src/lang/loader.ts` — the core wasm is embedded at build time. Upstream
   pointed Emscripten's `locateFile` at jsdelivr (`web-tree-sitter@<declared
   range>`) to fetch `tree-sitter.wasm` at runtime: two failure modes (offline
   / CDN outage silently kills parsing; the bundled glue and the fetched wasm
   can drift versions). The aggregate embeds the wasm shipped inside the
   INSTALLED web-tree-sitter package as base64 (`__TREE_SITTER_WASM_B64__`
   define in the root esbuild.mjs, same pattern as wa-sqlite / oniguruma /
   jieba) and passes it to `Parser.init` as `wasmBinary`, which short-circuits
   Emscripten's fetch branch. (web-tree-sitter 0.25+ renamed the artifact to
   `web-tree-sitter.wasm`; the esbuild define accepts both names.)
   `WEB_TREE_SITTER_VERSION` (read from the
   module's package.json for the CDN URL) became dead code and was removed.
   Language-level parser wasms (`@cursorless/tree-sitter-wasms`) still
   download at runtime from the CDN exactly as upstream designed — there are
   30+ of them and they are cached per language.

3. Styles: upstream `styles.css` travels in the root `styles.css` under the
   `Code Link (modules/my-code-link)` section (the boilerplate header comment
   was dropped; selectors unchanged — all `.code-link-*` / `.codelink-*`
   prefixed).

Dependencies
------------
Merged into the ROOT package.json (PnP: only root declarations resolve):
`web-tree-sitter ^0.26.3`, `globby ^14.0.2`, `fastest-levenshtein ^1.0.16`.
web-tree-sitter is additionally `unplugged` (the build reads
`tree-sitter.wasm` from the real directory — unplug rule #1).

Upstream also declares `@popperjs/core`, `iconify-icon`, `ignore` and `glob`
— NONE of them are imported anywhere in src/ or tests/ (verified by grep
before the merge), so they are deliberately NOT carried over.

Manifest / id
-------------
Upstream id `code-link`; per the 2026-10-30 convention the module registers
as `my-code-link` (descriptor `manifest.id` override — the settings tab and
the `my-code-link:import-project` command namespace key off manifest.id).
`legacyId: "my-code-link"` keeps `app.plugins.plugins["my-code-link"]`
resolvable. `migrateFrom: "code-link"` piggybacks the host's
migrateStandaloneSettings: if a vault still has the standalone plugin's
data.json, its settings are imported once on first boot of this module.
