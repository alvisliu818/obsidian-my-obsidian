import { MusicPlayerView } from "@/views/MusicPlayerView";

/**
 * 键盘快捷键处理器接口
 * 
 * 提供清理函数，用于移除事件监听器
 */
export interface KeyboardShortcutHandler {
	/** 清理函数，移除所有键盘事件监听器 */
	cleanup: () => void;
}

/**
 * 设置键盘快捷键
 * 
 * 为音乐播放器视图注册全局键盘快捷键，支持以下操作：
 * - 空格键：播放/暂停
 * - ↑：上一首
 * - ↓：下一首
 * - ←：快退 5 秒
 * - →：快进 5 秒
 * - Ctrl + ←：快退 15 秒
 * - Ctrl + →：快进 15 秒
 * 
 * 快捷键只在以下条件下生效：
 * 1. 视图已激活且已连接到 DOM
 * 2. 视图是当前活动的视图
 * 3. 用户不在输入框或文本编辑区域中
 * 
 * @param view 音乐播放器视图实例
 * @returns 返回处理器对象，包含 cleanup 方法用于移除事件监听器
 * 
 * @example
 * ```typescript
 * const handler = setupKeyboardShortcuts(view);
 * // 使用完毕后清理
 * handler.cleanup();
 * ```
 */
export function setupKeyboardShortcuts(view: MusicPlayerView): KeyboardShortcutHandler {
	const handleKeyDown = (e: KeyboardEvent) => {
		// 检查视图是否激活且已连接
		if (!view.containerEl || !view.containerEl.isConnected) {
			return;
		}

		// 检查视图的 leaf 是否是当前活动的 leaf
		const app = view.plugin.app;
		const activeLeaf = app.workspace.getActiveViewOfType(MusicPlayerView);
		if (!activeLeaf || activeLeaf !== view) {
			return;
		}

		// 如果用户正在输入框中输入，不处理快捷键
		const target = e.target as HTMLElement;
		if (
			target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.isContentEditable ||
			target.closest("input") ||
			target.closest("textarea")
		) {
			return;
		}

		// 空格键：播放/暂停
		if (e.code === "Space" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			void view.togglePlay();
			return;
		}

		// ↑：上一首
		if (e.code === "ArrowUp" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			void view.playPrevious();
			return;
		}

		// ↓：下一首
		if (e.code === "ArrowDown" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			void view.playNext();
			return;
		}

		// ←：快退 5 秒
		if (e.code === "ArrowLeft" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			view.seekBackward(5);
			return;
		}

		// →：快进 5 秒
		if (e.code === "ArrowRight" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			view.seekForward(5);
			return;
		}

		// Ctrl + ←：快退 15 秒
		if (e.code === "ArrowLeft" && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			view.seekBackward(15);
			return;
		}

		// Ctrl + →：快进 15 秒
		if (e.code === "ArrowRight" && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			view.seekForward(15);
			return;
		}
	};

	// 监听键盘事件
	window.addEventListener("keydown", handleKeyDown, true);

	return {
		cleanup: () => {
			window.removeEventListener("keydown", handleKeyDown, true);
		},
	};
}

