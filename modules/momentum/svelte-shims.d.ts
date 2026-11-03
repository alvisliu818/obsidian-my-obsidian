/**
 * Ambient types for imports this repo's tsc cannot resolve on its own.
 *
 * `.svelte` — esbuild-svelte compiles those at bundle time, not tsc; without
 * this declaration every `import X from "./X.svelte"` in the merged WorkLife
 * Calendar tree fails with "Cannot find module". Types are deliberately loose:
 * real props checking is upstream's svelte-check's job.
 *
 * NOTE: when this module is built as part of the aggregate host
 * (obsidian-my-obsidian), the host's own omnisearch/src/svelte-shims.d.ts
 * already declares `*.svelte` globally — that is why this file lives at the
 * repo root and NOT under src/ (the host's root tsconfig would then see two
 * identical wildcard declarations).
 */
declare module "*.svelte" {
	import type { Component } from "svelte";
	const component: Component<Record<string, unknown>>;
	export default component;
}
