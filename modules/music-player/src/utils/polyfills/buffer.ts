/**
 * Buffer Polyfill 工具模块
 *
 * 为移动端提供 Buffer polyfill
 * music-metadata-browser 库内部使用了 Buffer，需要在全局作用域中提供
 *
 * 使用别名 buffer-polyfill（见 tsconfig paths + esbuild alias）指向 npm 包 buffer，
 * 避免 `from "buffer"` 被误判为 Node 内置模块。
 */

import { Buffer } from "buffer-polyfill";

type WindowWithBuffer = Window & { Buffer?: typeof Buffer; activeWindow?: Window };

function ensureBufferOn(win: Window | undefined | null): void {
	if (!win) return;
	const w = win as unknown as WindowWithBuffer;
	if (!w.Buffer) {
		w.Buffer = Buffer;
	}
}

/**
 * 初始化 Buffer polyfill
 * 在全局作用域中设置 Buffer，确保 music-metadata-browser 等库可以正常工作
 */
export function initBufferPolyfill(): void {
	if (typeof window === "undefined") return;
	const root = window as unknown as WindowWithBuffer;
	ensureBufferOn(root);
	// Obsidian：与主 `window` 可能不同（弹出窗口获得焦点时）
	ensureBufferOn(root.activeWindow);
}
