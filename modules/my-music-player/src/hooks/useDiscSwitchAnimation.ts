/**
 * 唱片切换动画 Hook
 * 
 * 负责管理切歌时的滑动动画，包括：
 * - 封面预加载
 * - 唱片滑动动画（上一首/下一首）
 * - 唱针进出动画与时间编排
 * - 多个 window.setTimeout 的管理与清理
 */

import React from "react";
import { ANIMATION_TIMINGS } from "@/constants/ui";

/**
 * Hook 的输入参数
 */
export interface UseDiscSwitchAnimationParams {
	/** 是否正在播放 */
	isPlaying: boolean;
	/** 当前封面 URL */
	coverUrl?: string;
	/** 上一首的封面 URL */
	prevCoverUrl?: string;
	/** 下一首的封面 URL */
	nextCoverUrl?: string;
	/** 当前曲目的唯一标识 */
	trackKey?: string;
	/** 最后一次操作（"next" 或 "prev"） */
	lastAction?: "next" | "prev" | null;
	/** 切换播放/暂停的回调函数 */
	onTogglePlay?: () => void;
	/** workspace leaf 的宽度（用于计算动画偏移） */
	workspaceLeafWidth: number;
	/** 重置旋转角度的回调（切歌后调用） */
	onResetRotation?: () => void;
}

/**
 * Hook 的返回值
 */
export interface UseDiscSwitchAnimationReturn {
	/** 当前显示的封面 URL */
	displayCoverUrl: string | undefined;
	/** 当前唱片的偏移量 */
	currentDiscOffset: number;
	/** 下一个唱片的偏移量 */
	nextDiscOffset: number;
	/** 下一个唱片是否可见 */
	nextDiscVisible: boolean;
	/** 下一个唱片的封面 URL */
	nextDiscCoverUrl: string | undefined;
	/** 是否正在动画中 */
	isAnimating: boolean;
	/** 是否应该应用动画 transition */
	shouldAnimate: boolean;
	/** 唱针是否正在动画中 */
	isNeedleAnimating: boolean;
	/** 唱针是否处于播放姿态 */
	isNeedlePlaying: boolean;
	/** 处理切换动画的函数 */
	handleSwitch: (isNext: boolean) => Promise<void>;
}

/**
 * 预加载封面图片
 */
function preloadCover(coverUrl: string | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (!coverUrl) {
			resolve();
			return;
		}

		const img = new Image();
		
		// 设置超时，避免长时间等待
		const timeout = window.setTimeout(() => {
			resolve(); // 超时后也继续，避免阻塞动画
		}, 1000); // 1秒超时

		img.onload = () => {
			window.clearTimeout(timeout);
			resolve();
		};
		img.onerror = () => {
			window.clearTimeout(timeout);
			resolve(); // 即使加载失败也继续，避免阻塞动画
		};
		
		// 设置 src，开始加载
		img.src = coverUrl;
		
		// 如果图片已经在缓存中，complete 会立即变为 true
		if (img.complete) {
			window.clearTimeout(timeout);
			resolve();
		}
	});
}

/**
 * 唱片切换动画 Hook
 * 
 * 管理切歌时的滑动动画，包括封面预加载、唱片滑动、唱针动画等。
 * 
 * @param params Hook 参数
 * @returns Hook 返回值
 */
export function useDiscSwitchAnimation({
	isPlaying,
	coverUrl,
	prevCoverUrl,
	nextCoverUrl,
	trackKey,
	lastAction,
	onTogglePlay,
	workspaceLeafWidth,
	onResetRotation,
}: UseDiscSwitchAnimationParams): UseDiscSwitchAnimationReturn {
	const prevCoverUrlRef = React.useRef<string | undefined>(coverUrl);
	const prevTrackKeyRef = React.useRef<string | undefined>(trackKey);
	// 用 ref 记录“动画已开始”，避免 setState 异步导致的竞态：
	// 在切歌后、滑动动画真正开始前，其他 effect 可能会错误地把 displayCoverUrl 同步成新封面，造成闪烁。
	const isAnimatingRef = React.useRef(false);
	// 保存最新的 coverUrl，用于动画完成时的同步
	const latestCoverUrlRef = React.useRef<string | undefined>(coverUrl);
	// displayCoverUrl 始终显示当前应该显示的封面
	const [displayCoverUrl, setDisplayCoverUrl] = React.useState<string | undefined>(coverUrl);
	const [currentDiscOffset, setCurrentDiscOffset] = React.useState(0);
	const [nextDiscOffset, setNextDiscOffset] = React.useState(0);
	const [nextDiscVisible, setNextDiscVisible] = React.useState(false);
	const [nextDiscCoverUrl, setNextDiscCoverUrl] = React.useState<string | undefined>(undefined);
	const [shouldAnimate, setShouldAnimate] = React.useState(false);
	const [isAnimating, setIsAnimating] = React.useState(false);
	// 唱针动画状态：独立于唱片滑动动画，让唱针更快返回
	const [isNeedleAnimating, setIsNeedleAnimating] = React.useState(false);
	// 唱针返回逻辑：播放时且唱针动画未进行时，唱针处于播放姿态
	const isNeedlePlaying = isPlaying && !isNeedleAnimating;
	// window.setTimeout 在浏览器返回 number；与 Node 的 Timeout 类型合并时会冲突，故用 number[]
	const timeoutRefs = React.useRef<number[]>([]);

	// 始终更新 latestCoverUrlRef，确保动画完成时能获取到最新值
	React.useEffect(() => {
		latestCoverUrlRef.current = coverUrl;
	}, [coverUrl]);

	// 处理切换动画
	const handleSwitch = React.useCallback(async (isNext: boolean) => {
		if (isAnimatingRef.current || isAnimating || workspaceLeafWidth === 0) {
			return; // 如果正在动画或workspaceLeafWidth未设置，忽略
		}
		
		isAnimatingRef.current = true;
		setIsAnimating(true);
		setIsNeedleAnimating(true); // 开始唱针动画，让唱针先抬起
		
		// 滑入的封面应该是最新选择的歌曲封面：下一首使用 nextCoverUrl，上一首使用 prevCoverUrl
		const incomingCover = isNext ? nextCoverUrl : prevCoverUrl;
		const initialOffset = isNext ? workspaceLeafWidth : -workspaceLeafWidth;
		
		// 先预加载要滑入的封面，等待加载完成后再执行动画
		await preloadCover(incomingCover);
		
		// 先设置初始状态（无transition）
		setNextDiscCoverUrl(incomingCover);
		setNextDiscOffset(initialOffset);
		setCurrentDiscOffset(0);
		setShouldAnimate(false); // 先禁用动画
		setNextDiscVisible(true); // 显示下一个唱片
		
		// 清理之前的 timeout
		timeoutRefs.current.forEach((id) => window.clearTimeout(id));
		timeoutRefs.current = [];
		
		// 等待 DOM 更新完成后再触发动画
		const domUpdateTimeout = window.setTimeout(() => {
			// 启用动画并设置目标位置
			setShouldAnimate(true);
			const currentOffset = isNext ? -workspaceLeafWidth : workspaceLeafWidth;
			setCurrentDiscOffset(currentOffset);
			setNextDiscOffset(0);
		}, ANIMATION_TIMINGS.DOM_UPDATE_DELAY);
		timeoutRefs.current.push(domUpdateTimeout);
		
		// 唱针延迟返回：唱片动画500ms，唱针transition 300ms
		// 在300ms时让唱针开始返回，这样在600ms时唱针完成，比唱片(550ms)慢50ms
		const discAnimationComplete = ANIMATION_TIMINGS.DISC_ANIMATION_DURATION + ANIMATION_TIMINGS.DISC_ANIMATION_BUFFER;
		const needleStartTime = discAnimationComplete + ANIMATION_TIMINGS.NEEDLE_DELAY - ANIMATION_TIMINGS.NEEDLE_TRANSITION_DURATION;
		const needleTimeout = window.setTimeout(() => {
			setIsNeedleAnimating(false);
		}, needleStartTime);
		timeoutRefs.current.push(needleTimeout);
		
		// 动画完成后，更新封面并重置位置，然后恢复播放
		const animationCompleteTimeout = window.setTimeout(() => {
			// 动画完成后，使用最新的 coverUrl（通过 ref 获取，确保是最新值）
			setDisplayCoverUrl(latestCoverUrlRef.current);
			
			// 重置位置（无transition）
			setShouldAnimate(false);
			setCurrentDiscOffset(0);
			setNextDiscOffset(isNext ? workspaceLeafWidth : -workspaceLeafWidth);
			setNextDiscVisible(false);
			
			// 重置旋转角度
			if (onResetRotation) {
				onResetRotation();
			}
			
			setIsAnimating(false);
			isAnimatingRef.current = false;
			setIsNeedleAnimating(false); // 确保唱针动画状态也被重置
		}, ANIMATION_TIMINGS.DISC_ANIMATION_DURATION + ANIMATION_TIMINGS.DISC_ANIMATION_BUFFER);
		timeoutRefs.current.push(animationCompleteTimeout);
	}, [isAnimating, workspaceLeafWidth, isPlaying, onTogglePlay, coverUrl, nextCoverUrl, prevCoverUrl, onResetRotation]);

	// 监听封面或曲目变化，触发动画
	React.useEffect(() => {
		const trackChanged = trackKey !== prevTrackKeyRef.current;

		const coverChanged = coverUrl !== prevCoverUrlRef.current;

		// 若封面变化，或曲目变化（即使封面相同），且当前不在动画中，则根据 lastAction 决定是否触发切换动画
		// 只有当 lastAction 是 "next" 或 "prev" 时才触发滑动动画
		// 如果是直接选择歌曲（lastAction 为 null），则直接更新封面，不触发动画
		if ((coverChanged || trackChanged) && !isAnimating && !isAnimatingRef.current && workspaceLeafWidth > 0) {
			// 确定切换方向：根据 lastAction 判断
			const isNext = lastAction === "next";
			const isPrev = lastAction === "prev";
			
			// 只有当 lastAction 是 "next" 或 "prev" 时才触发滑动动画
			if (isNext || isPrev) {
				// 触发切换动画（此时 coverUrl 已经更新为新值）
				void handleSwitch(isNext);
				
				// 记录当前值（注意：displayCoverUrl 会在动画完成后更新）
				prevCoverUrlRef.current = coverUrl;
				prevTrackKeyRef.current = trackKey;
				return;
			}
		}

		// 如果不在动画中，且封面或曲目发生了变化，立即同步显示
		// 这种情况可能发生在：初始化、非切换导致的封面变化等
		if (!isAnimating && !isAnimatingRef.current) {
			if (coverChanged || trackChanged) {
				const wantsSlide = lastAction === "next" || lastAction === "prev";
				// 侧栏刚重新打开时宽度可能尚未就绪，延迟同步以保留滑动动画机会
				if (wantsSlide && workspaceLeafWidth === 0) {
					return;
				}
				setDisplayCoverUrl(coverUrl);
				prevCoverUrlRef.current = coverUrl;
				prevTrackKeyRef.current = trackKey;
				if (trackChanged && onResetRotation) {
					onResetRotation();
				}
			}
		} else {
			// 动画中时，只更新 ref，不更新显示（显示会在动画完成后更新）
			if (coverChanged) {
				prevCoverUrlRef.current = coverUrl;
			}
			if (trackChanged) {
				prevTrackKeyRef.current = trackKey;
			}
		}
	}, [coverUrl, trackKey, isAnimating, workspaceLeafWidth, handleSwitch, lastAction]);

	// 确保动画完成后，displayCoverUrl 与 coverUrl 同步
	// 这个 effect 用于处理动画过程中 coverUrl 可能再次变化的情况
	React.useEffect(() => {
		if (!isAnimating && !isAnimatingRef.current && coverUrl !== displayCoverUrl) {
			setDisplayCoverUrl(coverUrl);
		}
	}, [coverUrl, isAnimating, displayCoverUrl]);

	// 组件卸载时清理所有 timeout
	React.useEffect(() => {
		return () => {
			timeoutRefs.current.forEach((id) => window.clearTimeout(id));
			timeoutRefs.current = [];
		};
	}, []);

	return {
		displayCoverUrl,
		currentDiscOffset,
		nextDiscOffset,
		nextDiscVisible,
		nextDiscCoverUrl,
		isAnimating,
		shouldAnimate,
		isNeedleAnimating,
		isNeedlePlaying,
		handleSwitch,
	};
}

