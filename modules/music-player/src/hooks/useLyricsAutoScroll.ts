/**
 * 歌词自动滚动 Hook
 * 
 * 负责管理歌词列表的自动滚动逻辑，包括：
 * - 基于 playingIndex 的自动滚动，让当前行保持在容器中间
 * - 初次进入歌词模式时的「立即滚动到当前行」
 * - 手动滚动与自动滚动之间的状态区分
 * - 用户手动滚动时暂停自动滚动，交互结束（指针/触摸抬起或滚动/滚轮停止）后
 *   立即跳回当前播放行并居中，无需等待
 */

import React from "react";
import type { LyricLine } from "@/utils/lyrics/parser";
import type { ExtendedLyricLine } from "@/utils/lyrics/extendedParser";

/**
 * Hook 的输入参数
 */
export interface UseLyricsAutoScrollParams {
	/** 显示模式 */
	viewMode: "disc" | "lyrics";
	/** 要使用的歌词数据（普通 or 逐字） */
	lyricsToUse: LyricLine[] | ExtendedLyricLine[] | null;
	/** 当前播放的歌词行索引 */
	playingIndex: number;
	/** 是否是首次切换到歌词模式 */
	isInitialMount?: boolean;
	/** 首次切换完成的回调 */
	onInitialMountComplete?: () => void;
}

/**
 * Hook 的返回值
 */
export interface UseLyricsAutoScrollReturn {
	/** 滚动容器的 ref */
	scrollRef: React.RefObject<HTMLDivElement>;
	/** 歌词行的 ref 数组 */
	lineRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
}

/**
 * 歌词自动滚动 Hook
 * 
 * 管理歌词列表的自动滚动逻辑，包括初始定位和播放时的自动滚动。
 * 
 * @param params Hook 参数
 * @returns Hook 返回值
 */
export function useLyricsAutoScroll({
	viewMode,
	lyricsToUse,
	playingIndex,
	isInitialMount = false,
	onInitialMountComplete,
}: UseLyricsAutoScrollParams): UseLyricsAutoScrollReturn {
	const scrollRef = React.useRef<HTMLDivElement | null>(null);
	const lineRefs = React.useRef<(HTMLDivElement | null)[]>([]);
	const isAutoScrollingRef = React.useRef(false);
	// 用时间窗更可靠地屏蔽“程序触发”的 scroll 事件（smooth scroll 可能持续 > 400ms）
	const autoScrollSuppressUntilRef = React.useRef<number>(0);
	const isInitialScrollRef = React.useRef(false);
	// 始终保存最新的播放行索引，供用户手动滚动结束后立即跳回使用
	const latestPlayingIndexRef = React.useRef(playingIndex);
	// 标记是否暂停自动滚动（用户手动滚动后）
	const isAutoScrollPausedRef = React.useRef(false);
	// 记录最后一次用户交互时间（用于交互窗口判断）
	const lastUserInteractionAtRef = React.useRef<number>(0);
	// 标记用户是否正在进行滚动相关交互（拖动/触摸滑动/滚轮）
	const isUserInteractingRef = React.useRef(false);
	const wheelIdleTimerRef = React.useRef<number | null>(null);
	const scrollIdleTimerRef = React.useRef<number | null>(null);

	// 确保 lineRefs 数组长度与歌词匹配（仅歌词模式）
	// 当歌词数据变化（切换歌曲）时，重置滚动相关状态，避免残留的暂停标记或
	// 旧歌曲的最后滚动索引阻止新歌曲的自动滚动（否则切歌后拖动/点击进度条不会滚动到当前行）
	React.useEffect(() => {
		if (viewMode === "lyrics" && lyricsToUse && lyricsToUse.length > 0) {
			lineRefs.current = new Array(lyricsToUse.length).fill(null) as (HTMLDivElement | null)[];
		} else {
			lineRefs.current = [];
		}
		// 切换歌曲后，清除自动滚动的暂停/交互状态，让拖动进度条能重新触发滚动
		isAutoScrollPausedRef.current = false;
		isUserInteractingRef.current = false;
		isAutoScrollingRef.current = false;
		lastScrollIndexRef.current = -1;
		lastUserInteractionAtRef.current = 0;
		if (scrollIdleTimerRef.current !== null) {
			window.clearTimeout(scrollIdleTimerRef.current);
			scrollIdleTimerRef.current = null;
		}
		if (wheelIdleTimerRef.current !== null) {
			window.clearTimeout(wheelIdleTimerRef.current);
			wheelIdleTimerRef.current = null;
		}
	}, [viewMode, lyricsToUse]);

	// 辅助函数：将指定索引的歌词行定位到容器正中间（立即定位，无动画）
	const jumpLineToCenterAbove = React.useCallback((lineIndex: number) => {
		const container = scrollRef.current;
		const lineEl = lineRefs.current[lineIndex];
		if (!container || !lineEl) return false;

		const originalScrollBehavior = container.style.scrollBehavior;
		container.setCssProps({ scrollBehavior: 'auto' });

		const containerRect = container.getBoundingClientRect();
		const lineRect = lineEl.getBoundingClientRect();
		const containerHeight = containerRect.height;
		const centerY = containerHeight / 2;

		const lineTopRelative = lineRect.top - containerRect.top + container.scrollTop;
		const lineHeight = lineRect.height;
		const targetScrollTop = lineTopRelative - centerY + lineHeight / 2;

		container.scrollTop = Math.max(0, targetScrollTop);

		window.setTimeout(() => {
			container.setCssProps({ scrollBehavior: originalScrollBehavior });
		}, 0);

		return true;
	}, []);

	// 辅助函数：将指定索引的歌词行滚动到容器正中间（平滑滚动）
	const lastScrollIndexRef = React.useRef<number>(-1);
	const scrollLineToCenterAbove = React.useCallback((lineIndex: number) => {
		if (lastScrollIndexRef.current === lineIndex) return;
		lastScrollIndexRef.current = lineIndex;

		const container = scrollRef.current;
		const lineEl = lineRefs.current[lineIndex];
		if (!container || !lineEl) return;

		const containerRect = container.getBoundingClientRect();
		const lineRect = lineEl.getBoundingClientRect();
		const containerHeight = containerRect.height;
		const centerY = containerHeight / 2;

		const lineTopRelative = lineRect.top - containerRect.top + container.scrollTop;
		const lineHeight = lineRect.height;
		const targetScrollTop = lineTopRelative - centerY + lineHeight / 2;

		const currentScrollTop = container.scrollTop;
		if (Math.abs(targetScrollTop - currentScrollTop) < 10) return;

		container.scrollTo({
			top: targetScrollTop,
			behavior: 'smooth'
		});
	}, []);

	// 当首次切换到歌词模式时，立即定位到当前播放位置
	React.useLayoutEffect(() => {
		// 当切换到歌词模式且需要初始定位时，设置标记
		if (viewMode === "lyrics" && isInitialMount) {
			isInitialScrollRef.current = true;
		} else if (viewMode === "disc") {
			// 切换到 disc 模式时重置标记和清理状态
			isInitialScrollRef.current = false;
			isAutoScrollPausedRef.current = false;
			isUserInteractingRef.current = false;
			if (wheelIdleTimerRef.current !== null) {
				window.clearTimeout(wheelIdleTimerRef.current);
				wheelIdleTimerRef.current = null;
			}
			if (scrollIdleTimerRef.current !== null) {
				window.clearTimeout(scrollIdleTimerRef.current);
				scrollIdleTimerRef.current = null;
			}
			return;
		}

		// 只在歌词模式且需要初始定位时执行
		if (viewMode !== "lyrics" || !isInitialScrollRef.current) return;
		
		// 如果还没有歌词数据，等待
		if (playingIndex < 0 && (!lyricsToUse || lyricsToUse.length === 0)) {
			return;
		}

		// 如果 playingIndex < 0 但已有歌词数据，说明当前没有播放的歌词行
		if (playingIndex < 0) {
			isInitialScrollRef.current = false;
			if (onInitialMountComplete) {
				onInitialMountComplete();
			}
			return;
		}

		const attemptScroll = () => {
			const container = scrollRef.current;
			const lineEl = lineRefs.current[playingIndex];
			
			// 如果容器或元素还没准备好，重试
			if (!container || !lineEl) {
				window.setTimeout(attemptScroll, 10);
				return;
			}

			// 如果容器高度为0，重试
			if (container.clientHeight === 0) {
				window.setTimeout(attemptScroll, 10);
				return;
			}

			// 尝试滚动到当前播放位置
			const success = jumpLineToCenterAbove(playingIndex);
			if (success) {
				isInitialScrollRef.current = false;
				if (onInitialMountComplete) {
					onInitialMountComplete();
				}
			} else {
				// 如果第一次失败，再试一次
				window.setTimeout(() => {
					jumpLineToCenterAbove(playingIndex);
					isInitialScrollRef.current = false;
					if (onInitialMountComplete) {
						onInitialMountComplete();
					}
				}, 50);
			}
		};

		// 使用 requestAnimationFrame 确保 DOM 已渲染
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				attemptScroll();
			});
		});
	}, [viewMode, isInitialMount, playingIndex, lyricsToUse, jumpLineToCenterAbove, onInitialMountComplete]);

	// 监听滚动事件，检测用户手动滚动
	// 依赖 lyricsToUse：换曲时歌词容器会因 key 变化被重新挂载，必须在新容器上重新绑定监听器，
	// 否则用户滑动无法暂停自动滚动，且会被自动滚动打断（仅唱片切换时未换容器故无此问题）
	React.useEffect(() => {
		if (viewMode !== "lyrics") {
			// 切换到非歌词模式时，重置暂停状态并清理定时器
			isAutoScrollPausedRef.current = false;
			if (wheelIdleTimerRef.current !== null) {
				window.clearTimeout(wheelIdleTimerRef.current);
				wheelIdleTimerRef.current = null;
			}
			if (scrollIdleTimerRef.current !== null) {
				window.clearTimeout(scrollIdleTimerRef.current);
				scrollIdleTimerRef.current = null;
			}
			return;
		}

		const container = scrollRef.current;
		if (!container) return;

		const supportsPointerEvents =
			typeof window !== "undefined" && "PointerEvent" in window;

		const resumeAutoScrollImmediately = () => {
			// 用户手动滚动结束：立即解除暂停并跳回当前播放行（居中），不等待
			isAutoScrollPausedRef.current = false;
			isUserInteractingRef.current = false;
			const idx = latestPlayingIndexRef.current;
			if (idx >= 0) {
				isAutoScrollingRef.current = true;
				autoScrollSuppressUntilRef.current = Date.now() + 1500;
				scrollLineToCenterAbove(idx);
				window.setTimeout(() => {
					if (Date.now() >= autoScrollSuppressUntilRef.current) {
						isAutoScrollingRef.current = false;
					}
				}, 1600);
			}
		};

		const pauseAutoScrollForUserInteraction = () => {
			// 用户手动滚动/交互：暂停自动滚动，待交互停止后立即跳回当前行
			isAutoScrollPausedRef.current = true;
			lastUserInteractionAtRef.current = Date.now();
		};

		const handleScroll = () => {
			const now = Date.now();
			const isProbablyProgrammatic =
				isAutoScrollingRef.current &&
				!isUserInteractingRef.current &&
				now < autoScrollSuppressUntilRef.current;

			// 程序触发的滚动：忽略，避免误判为用户滚动从而打断自动滚动逻辑
			if (isProbablyProgrammatic) return;

			// 这里基本可以确定是用户导致的滚动（包含拖动滚动条/触控板惯性）
			isUserInteractingRef.current = true;
			if (scrollIdleTimerRef.current !== null) {
				window.clearTimeout(scrollIdleTimerRef.current);
			}
			scrollIdleTimerRef.current = window.setTimeout(() => {
				scrollIdleTimerRef.current = null;
				resumeAutoScrollImmediately();
			}, 500);

			pauseAutoScrollForUserInteraction();
		};

		const handlePointerDown = () => {
			isUserInteractingRef.current = true;
			pauseAutoScrollForUserInteraction();
		};

		const handlePointerUp = () => {
			// 指针抬起即视为一次手动滚动结束，立即跳回当前播放行
			resumeAutoScrollImmediately();
		};

		const handleTouchStart = () => {
			isUserInteractingRef.current = true;
			pauseAutoScrollForUserInteraction();
		};

		const handleTouchEnd = () => {
			resumeAutoScrollImmediately();
		};

		const handleWheel = () => {
			isUserInteractingRef.current = true;
			pauseAutoScrollForUserInteraction();

			if (wheelIdleTimerRef.current !== null) {
				window.clearTimeout(wheelIdleTimerRef.current);
			}
			wheelIdleTimerRef.current = window.setTimeout(() => {
				wheelIdleTimerRef.current = null;
				resumeAutoScrollImmediately();
			}, 500);
		};

		container.addEventListener('scroll', handleScroll, { passive: true });
		if (supportsPointerEvents) {
			container.addEventListener('pointerdown', handlePointerDown, { passive: true });
			container.addEventListener('pointerup', handlePointerUp, { passive: true });
			container.addEventListener('pointercancel', handlePointerUp, { passive: true });
		} else {
			container.addEventListener('touchstart', handleTouchStart, { passive: true });
			container.addEventListener('touchend', handleTouchEnd, { passive: true });
			container.addEventListener('touchcancel', handleTouchEnd, { passive: true });
		}
		container.addEventListener('wheel', handleWheel, { passive: true });

		return () => {
			container.removeEventListener('scroll', handleScroll);
			if (supportsPointerEvents) {
				container.removeEventListener('pointerdown', handlePointerDown);
				container.removeEventListener('pointerup', handlePointerUp);
				container.removeEventListener('pointercancel', handlePointerUp);
			} else {
				container.removeEventListener('touchstart', handleTouchStart);
				container.removeEventListener('touchend', handleTouchEnd);
				container.removeEventListener('touchcancel', handleTouchEnd);
			}
			container.removeEventListener('wheel', handleWheel);
			// 清理定时器
			if (wheelIdleTimerRef.current !== null) {
				window.clearTimeout(wheelIdleTimerRef.current);
			}
			if (scrollIdleTimerRef.current !== null) {
				window.clearTimeout(scrollIdleTimerRef.current);
			}
		};
	}, [viewMode, lyricsToUse]);

	// 当播放进度变化时，自动把当前行滚动到容器正中间（仅歌词模式）
	React.useEffect(() => {
		// 同步最新播放行索引，供用户手动滚动结束后立即跳回
		latestPlayingIndexRef.current = playingIndex;
		if (viewMode !== "lyrics" || isInitialScrollRef.current) return;
		if (playingIndex < 0) return;
		// 如果自动滚动被暂停（用户手动滚动后），则不执行自动滚动
		if (isAutoScrollPausedRef.current) return;
		// 用户仍在交互/滚动中时，不要触发自动滚动（避免“正在滑动被拉回”）
		if (isUserInteractingRef.current) return;

		isAutoScrollingRef.current = true;
		autoScrollSuppressUntilRef.current = Date.now() + 1500;
		scrollLineToCenterAbove(playingIndex);
		window.setTimeout(() => {
			// 只在超出 suppress 窗口后再解除，避免 smooth scroll 时长不稳定导致误判
			if (Date.now() >= autoScrollSuppressUntilRef.current) {
				isAutoScrollingRef.current = false;
			}
		}, 1600);
	}, [viewMode, playingIndex, scrollLineToCenterAbove]);

	// 组件卸载时清理残留定时器
	React.useEffect(() => {
		return () => {
			if (wheelIdleTimerRef.current !== null) {
				window.clearTimeout(wheelIdleTimerRef.current);
			}
			if (scrollIdleTimerRef.current !== null) {
				window.clearTimeout(scrollIdleTimerRef.current);
			}
		};
	}, []);

	return {
		scrollRef,
		lineRefs,
	};
}

