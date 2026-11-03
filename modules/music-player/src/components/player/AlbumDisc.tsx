/**
 * 专辑唱片组件
 * 
 * 显示专辑封面和唱片动画效果，包括：
 * - 唱片旋转动画（播放时）
 * - 切换动画（上一首/下一首时的滑动效果）
 * - 唱针动画（播放/暂停时的唱针移动）
 * - 支持拖动封面调整播放进度
 * 
 * 封面切换逻辑：
 * - 组件同时接收三个封面：prevCoverUrl（前一个）、coverUrl（当前）、nextCoverUrl（后一个）
 * - 点击上一首时，prevCoverUrl 从左侧滑入
 * - 点击下一首时，nextCoverUrl 从右侧滑入
 * - 切换完成后，coverUrl 更新为新的当前封面
 * 
 * 动画说明：
 * - 播放时唱片会持续旋转
 * - 切换歌曲时会有滑动切换动画
 * - 唱针在播放时会移动到唱片上，暂停时返回原位
 */

import React from "react";
import "./AlbumDisc.css";
import { useDiscRotation } from "@/hooks/useDiscRotation";
import { t } from "@/utils/i18n/i18n";
import { useDiscSwitchAnimation } from "@/hooks/useDiscSwitchAnimation";

/**
 * 专辑唱片组件的属性接口
 */
export interface AlbumDiscProps {
	/** 当前曲目的封面图片 URL */
	coverUrl?: string;
	/** 当前曲目的唯一标识（例如路径），用于在封面相同但歌曲不同的情况下也能触发动画 */
	trackKey?: string;
	/** 是否正在播放 */
	isPlaying: boolean;
	/** 播放上一首的回调函数（可选） */
	onPrev?: () => void;
	/** 播放下一首的回调函数（可选） */
	onNext?: () => void;
	/** 切换播放/暂停的回调函数（可选） */
	onTogglePlay?: () => void;
	/** 上一首的封面图片 URL（用于切换动画） */
	prevCoverUrl?: string;
	/** 下一首的封面图片 URL（用于切换动画） */
	nextCoverUrl?: string;
	/** 最后一次操作（"next" 或 "prev"），用于触发切换动画 */
	lastAction?: "next" | "prev" | null;
}

/**
 * 专辑唱片组件
 * 
 * 显示专辑封面和唱片动画效果，支持播放时的旋转动画和切换时的滑动动画。
 * 
 * @param props 组件属性
 */
export function AlbumDisc({ coverUrl, trackKey, isPlaying, onTogglePlay, prevCoverUrl, nextCoverUrl, lastAction }: AlbumDiscProps) {
	const containerRef = React.useRef<HTMLDivElement>(null);
	const shadowLeftRef = React.useRef<HTMLDivElement>(null);
	const shadowRightRef = React.useRef<HTMLDivElement>(null);
	const panContainerRef = React.useRef<HTMLDivElement>(null);
	const [workspaceLeafWidth, setWorkspaceLeafWidth] = React.useState(0);

	// 使用唱片旋转 Hook
	const { rotationAngle, currentDiscRef, resetRotation } = useDiscRotation({ isPlaying });

	// 使用唱片切换动画 Hook
	const {
		displayCoverUrl,
		currentDiscOffset,
		nextDiscOffset,
		nextDiscVisible,
		nextDiscCoverUrl,
		isAnimating,
		shouldAnimate,
		isNeedlePlaying,
	} = useDiscSwitchAnimation({
		isPlaying,
		coverUrl,
		prevCoverUrl,
		nextCoverUrl,
		trackKey,
		lastAction,
		onTogglePlay,
		workspaceLeafWidth,
		onResetRotation: resetRotation,
	});

	// 获取 workspace-leaf 宽度（侧栏重新打开时初始宽度可能为 0，需持续监听尺寸变化）
	React.useEffect(() => {
		const panContainer = panContainerRef.current;
		if (!panContainer) return;

		let workspaceLeaf: HTMLElement | null = null;
		let element: HTMLElement | null = panContainer;
		while (element && !workspaceLeaf) {
			element = element.parentElement;
			if (element?.classList.contains("workspace-leaf")) {
				workspaceLeaf = element;
			}
		}

		const updateWidth = () => {
			if (workspaceLeaf) {
				setWorkspaceLeafWidth(workspaceLeaf.offsetWidth || 0);
			} else {
				const windowWidth = typeof window !== "undefined" ? window.innerWidth : 1920;
				setWorkspaceLeafWidth(windowWidth);
			}
		};

		updateWidth();

		if (workspaceLeaf) {
			const observer = new ResizeObserver(updateWidth);
			observer.observe(workspaceLeaf);
			return () => observer.disconnect();
		}

		window.addEventListener("resize", updateWidth);
		return () => window.removeEventListener("resize", updateWidth);
	}, []);

	const discClasses = [
		"album-image",
		// 不再使用 "playing" 类，改用JavaScript控制旋转
	].filter(Boolean).join(" ");

	// 使用JavaScript控制旋转，无论是播放还是暂停都应用角度
	const discStyle: React.CSSProperties = {
		transition: "none", // 不要过渡动画，直接应用角度
		transform: `rotate(${rotationAngle}deg)`,
	};

	const coverStyle: React.CSSProperties = displayCoverUrl
		? { backgroundImage: `url("${displayCoverUrl}")` }
		: {};

	return (
		<div className="album-container-wrapper">
			{/* 固定的半透明背景 */}
			<div className="disc-shadow"></div>

			{/* 滑动容器 - 包含needle和disc */}
			<div className="pan-container" ref={panContainerRef}>
				{/* 唱针 - 相对于disc定位 */}
				<div className={`needle ${isNeedlePlaying ? "playing" : ""}`}>
					<div
						role="img"
						aria-label={t("a11y.tonearm")}
						className="needle-image needle-image-embedded"
					/>
				</div>
				
				{/* 左侧影子控件（上一首） */}
				<div 
					ref={shadowLeftRef}
					className="album-container shadow-disc"
					style={{ 
						position: 'absolute',
						left: '0',
						bottom: '10px',
						transform: `translateX(${-workspaceLeafWidth}px)`,
						opacity: 0,
						pointerEvents: 'none',
						zIndex: -1,
					}}
				>
					<div
						role="img"
						aria-label={t("a11y.vinyl")}
						className="disc-background disc-background-embedded"
					/>
					<div 
						className="album-image"
						style={{ 
							backgroundImage: prevCoverUrl ? `url("${prevCoverUrl}")` : undefined 
						}}
					>
						{!prevCoverUrl && (
							<div className="album-placeholder">♪</div>
						)}
					</div>
				</div>

				{/* 当前播放的唱片（点击不再控制播放，仅用于展示和动画） */}
				<div 
					className="album-container"
					ref={containerRef}
					style={{
						position: 'absolute',
						left: '0',
						bottom: '10px',
						transform: `translateX(${currentDiscOffset}px)`,
						transition: isAnimating ? 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)' : 'none',
						zIndex: nextDiscVisible ? 1 : 2,
						willChange: isAnimating ? 'transform' : 'auto',
					}}
				>
					{/* 黑胶唱片背景图片 */}
					<div
						role="img"
						aria-label={t("a11y.vinyl")}
						className="disc-background disc-background-embedded"
					/>

					{/* 专辑封面 */}
					<div 
						ref={currentDiscRef}
						className={discClasses} 
						style={{ ...discStyle, ...coverStyle }}
					>
						{!displayCoverUrl && (
							<div className="album-placeholder">
								♪
							</div>
						)}
					</div>
				</div>

				{/* 下一个唱片（用于切换动画） */}
				{nextDiscVisible && (
					<div 
						className="album-container"
						style={{
							position: 'absolute',
							left: '0',
							bottom: '10px',
							transform: `translateX(${nextDiscOffset}px)`,
							transition: shouldAnimate ? 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)' : 'none',
							zIndex: 2,
							willChange: shouldAnimate ? 'transform' : 'auto',
						}}
					>
						{/* 黑胶唱片背景图片 */}
						<div
							role="img"
							aria-label={t("a11y.vinyl")}
							className="disc-background disc-background-embedded"
						/>

						{/* 专辑封面 */}
						<div 
							className={discClasses}
							style={{
								transition: "none",
								transform: 'rotate(0deg)',
								backgroundImage: nextDiscCoverUrl ? `url("${nextDiscCoverUrl}")` : undefined,
							}}
						>
							{!nextDiscCoverUrl && (
								<div className="album-placeholder">
									♪
								</div>
							)}
						</div>
					</div>
				)}

				{/* 右侧影子控件（下一首） */}
				<div 
					ref={shadowRightRef}
					className="album-container shadow-disc"
					style={{ 
						position: 'absolute',
						left: '0',
						bottom: '10px',
						transform: `translateX(${workspaceLeafWidth}px)`,
						opacity: 0,
						pointerEvents: 'none',
						zIndex: -1,
					}}
				>
					<div
						role="img"
						aria-label={t("a11y.vinyl")}
						className="disc-background disc-background-embedded"
					/>
					<div 
						className="album-image"
						style={{ 
							backgroundImage: nextCoverUrl ? `url("${nextCoverUrl}")` : undefined 
						}}
					>
						{!nextCoverUrl && (
							<div className="album-placeholder">♪</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
