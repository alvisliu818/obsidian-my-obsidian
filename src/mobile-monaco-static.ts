/**
 * MOBILE_BUILD=core 专用：把 Monaco 静态打进主 bundle。
 *
 * 桌面端 monaco 走 `lazy/monaco.js` 懒包，运行时用 `require(pluginDir/lazy/...)`
 * 加载；移动端 Obsidian 没有 Node 的 require，这条路径会直接抛错。这里提供
 * 与 modules/code-editor/src/editor/lazyMonaco.ts 相同的导出面，但静态 import
 * monaco-editor（构建期由 mobile-vt-build-plugin 按 core 模式别名过来）。
 */
import * as monacoNs from 'monaco-editor';

export type MonacoNS = typeof import('monaco-editor');

/** 与桌面懒加载器签名一致；静态模式下无需预初始化。 */
export function initLazyMonaco(_dir: string): void {
  // no-op
}

export function getMonaco(): MonacoNS {
  return monacoNs;
}

export const monaco = monacoNs;
export type monaco = MonacoNS;
