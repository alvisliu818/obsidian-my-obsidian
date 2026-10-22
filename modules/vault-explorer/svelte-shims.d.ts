/**
 * Ambient types for Svelte component imports（omnisearch 模块同款）。
 *
 * tsc 不认识 `.svelte`（那是 esbuild-svelte 在打包时才编译的东西），没有这个
 * 声明，本模块里 `import App from '../svelte/app/index.svelte'` 会直接报
 * Cannot find module。类型标为 Svelte 的 Component，真实 props 校验由上游
 * 自己的 svelte-check 负责，这里只求 tsc 能通过。
 *
 * 放在 src/ 之外：直连宿主 tsc 程序时宿主只收 src/**（omnisearch 的全局
 * shim 已覆盖 .svelte 导入），这份就不重复进宿主程序。
 */
declare module "*.svelte" {
	import type { Component } from "svelte";
	const component: Component<Record<string, unknown>>;
	export default component;
}
