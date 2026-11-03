/**
 * Ambient types for Svelte component imports.
 *
 * 主仓的 tsc 不认识 `.svelte`（那是 esbuild-svelte 在打包时才编译的东西），
 * 没有这个声明，omnisearch 里 `import ModalVault from './ModalVault.svelte'`
 * 会直接报 Cannot find module。类型标为 Svelte 的 Component，真实 props
 * 校验由上游自己的 svelte-check 负责，这里只求主仓 tsc 能通过。
 */
declare module "*.svelte" {
	import type { Component } from "svelte";
	const component: Component<Record<string, unknown>>;
	export default component;
}
