# NOTICE — merged upstreams

This project is a **merge of two independent Obsidian plugins**:

| Upstream | Repo | License | Version | Tip commit |
|---|---|---|---|---|
| Momentum Life (base) | https://github.com/jnagase/obsidian-momentum | MIT | 0.8.11 | `71f71bf` |
| WorkLife Calendar | https://github.com/atinss/WorkLife-Calendar-for-Obsidian | MIT | 2.33.1 | `d3e092b6` |

Both upstreams' full git histories are grafted into this repository (the
WorkLife tip is the second parent of the merge commit), so `git log` reaches
both lineages. `git log --follow` breaks at the merge point — upstream paths
differ from this repo's layout — so trace upstream history with:

```
git log d3e092b6 -- src/components     # WorkLife's tree lives at src/worklife/ now
git log 71f71bf -- src/view.ts          # Momentum's own files kept their paths
```

## Merge design (why it looks like this)

- WorkLife's entire `src/` tree was copied verbatim into `src/worklife/`
  (145 upstream commits). `__tests__/`, `testUtils/`, `__mocks__/`,
  `jest.setup.js`, `tools/` and `theme/` were **not** copied (repo machinery;
  nothing outside the tests referenced them).
- `src/main.ts` (Momentum) loads WorkLife as an **in-process sub-plugin**:
  one manifest, one `data.json`, two feature sets. `loadWorkLife()` shims the
  sub-plugin's `loadData`/`saveData` to a `"worklife"` namespace inside
  Momentum's own blob, and `installSaveBridge()` serializes every write
  (read-modify-write) so a calendar save can neither clobber nor race a
  Momentum save.
- The sub-plugin gets a **synthetic manifest** (`id: "worklife-calendar"`,
  name "WorkLife Calendar") so its settings tab and command labels keep the
  calendar's own identity, and its `findPluginDir()` adapter fallback can only
  ever match a *stale standalone install* — a one-time migration read, never a
  write.
- `unload()` (not `onunload()`) is called on the sub-plugin at teardown so its
  registered events/intervals/dom handlers are cleaned up too.

## Adaptations made to the WorkLife tree

1. **24 bare `src/...` imports in 15 files → relative paths.** WorkLife used
   `baseUrl: "."` with `paths: { "src": ["src/*"] }`; inside `src/worklife/`
   those would resolve to *Momentum's* files (or, in the aggregate host, to
   `modules/obsidian-git/src/*` via the root tsconfig alias). Rewriting kept
   every relative path byte-identical to what a path-relative version would be.
2. `styles.css`: WorkLife's stylesheet appended under a
   `/* ===== WorkLife Calendar (src/worklife) ===== */` section (CRLF).
3. `svelte-shims.d.ts` (repo root): ambient `*.svelte` declaration for this
   repo's standalone tsc. **Do not move it under `src/`** — the aggregate host
   (obsidian-my-obsidian) already declares `*.svelte` globally via
   `modules/omnisearch/src/svelte-shims.d.ts`; a second copy would be a
   duplicate ambient declaration under the host's root tsconfig.
4. `package.json` / `esbuild.config.mjs`: WorkLife's runtime dependencies
   (fullcalendar, d3, luxon, moment, obsidian-calendar-ui,
   obsidian-daily-notes-interface, svelte) and esbuild-svelte build support.
   Rollup (WorkLife's original build) was replaced by Momentum's esbuild.

## Known quirks (upstream behavior, left as-is)

- `services/updateCheck.ts` still checks **WorkLife's** GitHub releases; a
  merged install may be told to update "WorkLife Calendar", which no longer
  exists as a standalone plugin.
- WorkLife sets the **global** `moment.locale()` from its language setting
  (Obsidian ships `moment` as a global).
- These Svelte **3** components are compiled and run under Svelte **4** —
  both in the aggregate host and in this repo's standalone build. Svelte 4
  keeps Svelte 3's class-component API (`new Component({ target, props })`,
  `$destroy`, `$set`) and its `new Child({...})` child convention, which
  the WorkLife views rely on; `ui/Calendar.svelte` also mounts
  obsidian-calendar-ui's precompiled Svelte 3 class as a child component.
  Svelte 5 cannot do either (default output is function components; its
  `componentApi: 4` compat mode only wraps the root, children are still
  invoked as functions), hence ^4.2.7. esbuild-svelte 0.9.5's peer range
  (`>=4.2.1 <6`) covers Svelte 4.
- In the aggregate host the root node_modules keeps Svelte 5 for
  omnisearch/obsidian-git; the momentum tree is compiled by a **second**
  esbuild-svelte instance resolved from `modules/momentum/node_modules`
  (`createRequire` on the module's package.json, `include` limited to
  momentum paths, registered before the root plugin). The module therefore
  carries its own nested dependency tree (same layout as the standalone
  project).
- `esbuild-svelte` preprocessing needs `verbatimModuleSyntax: true` (passed
  via sveltePreprocess options, NOT via tsconfig, to keep momentum's
  `tsc -noEmit` clean): without it `ts.transpileModule` deletes imports
  that are only referenced through `$store` auto-subscription, and the
  Svelte compiler then fails with `global_reference_invalid`.
