/**
 * monaco-editor 懒加载器（聚合主仓内存优化，2026-11-05）。
 *
 * monaco-editor 包 3.7MB，主 bundle 静态携带 = 源码 ×2 常驻。拆为独立懒包
 * （lazy/monaco.js），首次触碰才 require。运行时本就惰性（首次 createEditor
 * 才初始化），这里把**字节**也挪出去。
 *
 * 用法：消费方把 `import * as monaco from 'monaco-editor'` 换成
 * `import { monaco } from '../editor/lazyMonaco'`——monaco 是 Proxy 命名空间，
 * 属性访问触发加载，调用点零改动；类型位（WeakMap<monaco.editor.ICodeEditor>)
 * 走静态类型不受影响。
 *
 * 懒包的 obsidian 桥见 src/obsidian-shim.ts（monaco-editor 自身不依赖
 * obsidian，桥暂不需要——保留机制一致性）。
 */

type MonacoNS = typeof import('monaco-editor');

let mod: MonacoNS | null = null;
let pluginDir: string | null = null;

/** 模块 onload 调用：记录插件目录（绝对路径，FileSystemAdapter.getFullPath）。 */
export function initLazyMonaco(dir: string): void {
	pluginDir = dir;
}

export function getMonaco(): MonacoNS {
	if (mod) return mod;
	if (!pluginDir) throw new Error('[code-editor] lazy monaco used before initLazyMonaco()');
	// 动态 require：CJS 输出下保持运行时 require（Electron renderer
	// nodeIntegration 按绝对路径解析插件目录下的懒包文件）。
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	mod = require(`${pluginDir}/lazy/monaco.js`) as MonacoNS;
	return mod;
}

/**
 * 命名空间代理——替换 `import * as monaco from 'monaco-editor'`。
 * 创建 Proxy 不触发加载；首次属性访问才 require 懒包。
 *
 * 值 + 类型同名导出（const/type 合并模式）：消费方 `import { monaco }` 同时
 * 绑定值代理与类型命名空间——值位（monaco.editor.create）走 Proxy 首触加载，
 * 类型位（WeakMap<monaco.editor.ICodeEditor>）走静态类型，零调用点改动。
 */
export const monaco: MonacoNS = new Proxy(
	{} as MonacoNS,
	{
		get(_t, prop) {
			return (getMonaco() as unknown as Record<string | symbol, unknown>)[prop];
		},
		has(_t, prop) {
			return prop in getMonaco();
		},
	},
);
export type monaco = MonacoNS;
