/**
 * 曲目操作组件
 * 
 * 提供当前播放曲目的操作功能，包括：
 * - 添加到歌单
 * - 切换收藏状态
 * - 音量控制（0%、25%、50%、75%、100%）
 * - 播放速度控制（0.5x - 2.0x）
 * 
 * 支持下拉菜单选择音量和播放速度。
 */

import React from "react";
import "./TrackActions.css";
import { IconButton } from "@/components/shared/IconButton";
import { setIcon } from "obsidian";
import { t } from "@/utils/i18n/i18n";

/**
 * 曲目操作组件的属性接口
 */
export interface TrackActionsProps {
	/** 当前播放的曲目路径 */
	currentPath: string | null;
	/** 可选的 section ID，用于更新列表上下文 */
	sectionId?: string | null;
	/** 是否已收藏 */
	isFavorite: boolean;
	/** 当前音量（0-1） */
	volume: number;
	/** 当前播放速度（0.5-2.0） */
	playbackRate: number;
	/** 添加到歌单的回调函数 */
	onAddToPlaylist: (path: string, sectionId?: string) => void;
	/** 切换收藏状态的回调函数 */
	onToggleFavorite: (path: string, sectionId?: string) => void;
	/** 音量改变的回调函数 */
	onVolumeChange: (volume: number) => void;
	/** 播放速度改变的回调函数 */
	onPlaybackRateChange: (rate: number) => void;
}

/**
 * 曲目操作组件
 * 
 * 显示曲目操作按钮和下拉菜单，支持添加到歌单、收藏、音量控制、播放速度控制。
 * 
 * @param props 组件属性
 */
export function TrackActions({
	currentPath,
	sectionId,
	isFavorite,
	volume,
	playbackRate,
	onAddToPlaylist,
	onToggleFavorite,
	onVolumeChange,
	onPlaybackRateChange,
}: TrackActionsProps) {
	const [isVolumeMenuVisible, setIsVolumeMenuVisible] = React.useState(false);
	const [isPlaybackRateMenuVisible, setIsPlaybackRateMenuVisible] = React.useState(false);
	const [isVolumeDragging, setIsVolumeDragging] = React.useState(false);
	const volumeButtonRef = React.useRef<HTMLButtonElement>(null);
	const volumeMenuRef = React.useRef<HTMLDivElement>(null);
	const volumeTrackRef = React.useRef<HTMLDivElement>(null);
	const playbackRateButtonRef = React.useRef<HTMLButtonElement>(null);
	const playbackRateMenuRef = React.useRef<HTMLDivElement>(null);

	// 设置音量图标：音量为0时使用 volume-x，否则使用 volume-2
	React.useEffect(() => {
		if (volumeButtonRef.current && currentPath) {
			if (volume === 0) {
				setIcon(volumeButtonRef.current, "volume-x");
			} else {
				setIcon(volumeButtonRef.current, "volume-2");
			}
		}
	}, [volume, currentPath]);

	// 设置播放速度图标
	React.useEffect(() => {
		if (playbackRateButtonRef.current && currentPath) {
			setIcon(playbackRateButtonRef.current, "gauge-circle");
		}
	}, [currentPath]);

	const handleAddToPlaylist = React.useCallback(() => {
		if (currentPath) {
			onAddToPlaylist(currentPath, sectionId || undefined);
		}
	}, [currentPath, sectionId, onAddToPlaylist]);

	const handleToggleFavorite = React.useCallback(() => {
		if (currentPath) {
			onToggleFavorite(currentPath, sectionId || undefined);
		}
	}, [currentPath, sectionId, onToggleFavorite]);

	// 根据指针 Y 坐标计算音量（0-1），垂直滑块：顶部为 100%
	const updateVolumeFromY = React.useCallback((clientY: number) => {
		const track = volumeTrackRef.current;
		if (!track) return;
		const rect = track.getBoundingClientRect();
		const ratio = 1 - (clientY - rect.top) / rect.height;
		const clamped = Math.max(0, Math.min(1, ratio));
		onVolumeChange(Math.round(clamped * 100) / 100);
	}, [onVolumeChange]);

	// 拖拽期间拦截 touchmove（非 passive + preventDefault），避免 WebView 把垂直滑动识别为页面滚动/边缘手势
	React.useEffect(() => {
		if (!isVolumeDragging) return;
		const blockTouchMove = (e: TouchEvent) => {
			e.preventDefault();
		};
		window.activeDocument.addEventListener("touchmove", blockTouchMove, { passive: false });
		return () => {
			window.activeDocument.removeEventListener("touchmove", blockTouchMove);
		};
	}, [isVolumeDragging]);

	// 指针按下轨道或滑块 — 开始拖拽（兼容鼠标与触摸，参考进度条实现）
	const handleVolumePointerDown = React.useCallback((e: React.PointerEvent) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		setIsVolumeDragging(true);
		try {
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		} catch {
			// 捕获失败也继续，至少支持单击定位
		}
		updateVolumeFromY(e.clientY);
	}, [updateVolumeFromY]);

	// 拖拽中：指针移动（通过指针捕获，移动端也能持续收到事件）
	const handleVolumePointerMove = React.useCallback((e: React.PointerEvent) => {
		if (!isVolumeDragging) return;
		e.preventDefault();
		e.stopPropagation();
		updateVolumeFromY(e.clientY);
	}, [isVolumeDragging, updateVolumeFromY]);

	// 拖拽结束：释放指针捕获
	const handleVolumePointerUp = React.useCallback((e: React.PointerEvent) => {
		if (!isVolumeDragging) return;
		e.stopPropagation();
		try {
			if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
				(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
			}
		} catch {
			// 已释放时忽略
		}
		setIsVolumeDragging(false);
	}, [isVolumeDragging]);

	const handleVolumeButtonClick = React.useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		setIsVolumeMenuVisible(prev => !prev);
		setIsPlaybackRateMenuVisible(false);
	}, []);

	const handlePlaybackRateButtonClick = React.useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		setIsPlaybackRateMenuVisible(prev => !prev);
		setIsVolumeMenuVisible(false);
	}, []);

	const handlePlaybackRateSelect = React.useCallback((rate: number) => {
		onPlaybackRateChange(rate);
		setIsPlaybackRateMenuVisible(false);
	}, [onPlaybackRateChange]);

	// 点击外部区域关闭音量菜单和播放速度菜单
	React.useEffect(() => {
		if (!isVolumeMenuVisible && !isPlaybackRateMenuVisible) return;

		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Node;
			
			// 检查是否点击在音量相关区域（按钮或菜单）
			const isClickInsideVolume = 
				(volumeButtonRef.current?.contains(target)) ||
				(volumeMenuRef.current?.contains(target));
			
			// 检查是否点击在播放速度相关区域（按钮或菜单）
			const isClickInsidePlaybackRate =
				(playbackRateButtonRef.current?.contains(target)) ||
				(playbackRateMenuRef.current?.contains(target));
			
			// 如果点击在音量区域外且音量菜单可见，关闭音量菜单
			if (isVolumeMenuVisible && !isClickInsideVolume) {
				setIsVolumeMenuVisible(false);
			}
			
			// 如果点击在播放速度区域外且播放速度菜单可见，关闭播放速度菜单
			if (isPlaybackRateMenuVisible && !isClickInsidePlaybackRate) {
				setIsPlaybackRateMenuVisible(false);
			}
		};

		window.activeDocument.addEventListener("mousedown", handleClickOutside);
		return () => window.activeDocument.removeEventListener("mousedown", handleClickOutside);
	}, [isVolumeMenuVisible, isPlaybackRateMenuVisible]);

	if (!currentPath) {
		return null;
	}

	const playbackRateOptions = [2.0, 1.5, 1.0, 0.75, 0.5];
	const displayVolumePercent = Math.round(volume * 100);

	return (
		<div className="track-actions-container" onClick={(e) => e.stopPropagation()}>
			<div className="track-actions-left">
				<IconButton
					icon="list-plus"
					label={t("track.addToPlaylist")}
					className="track-action-btn clickable-icon"
					onClick={handleAddToPlaylist}
				/>

				<div className="playback-rate-control-wrapper">
					<button
						ref={playbackRateButtonRef}
						className="track-action-btn clickable-icon playback-rate-btn"
						aria-label={t("playback.rate")}
						onClick={handlePlaybackRateButtonClick}
					/>
					{isPlaybackRateMenuVisible && (
						<div ref={playbackRateMenuRef} className="playback-rate-menu-popup">
							{playbackRateOptions.map((rate) => (
								<button
									key={rate}
									className={`playback-rate-option ${Math.abs(playbackRate - rate) < 0.01 ? "active" : ""}`}
									onClick={() => handlePlaybackRateSelect(rate)}
								>
									{rate.toFixed(1)}x
								</button>
							))}
						</div>
					)}
				</div>
			</div>

			<div className="track-actions-right">
				<div className="volume-control-wrapper">
					<button
						ref={volumeButtonRef}
						className="track-action-btn clickable-icon volume-btn"
						aria-label={t("playback.volume")}
						onClick={handleVolumeButtonClick}
					/>
					{isVolumeMenuVisible && (
						<div ref={volumeMenuRef} className="volume-menu-popup volume-slider-popup">
							<span className="volume-slider-value">{displayVolumePercent}%</span>
							<div
								ref={volumeTrackRef}
								className="volume-slider-track"
								onPointerDown={handleVolumePointerDown}
								onPointerMove={handleVolumePointerMove}
								onPointerUp={handleVolumePointerUp}
								onPointerCancel={handleVolumePointerUp}
							>
								<div
									className="volume-slider-fill"
									style={{ height: `${displayVolumePercent}%` }}
								/>
								<div
									className="volume-slider-thumb"
									style={{ bottom: `${displayVolumePercent}%` }}
									onPointerDown={handleVolumePointerDown}
								/>
							</div>
						</div>
					)}
				</div>

				<IconButton
					icon="heart"
					label={isFavorite ? t("track.removeFavorite") : t("track.addFavorite")}
					className={`track-action-btn clickable-icon ${isFavorite ? "active" : ""}`}
					onClick={handleToggleFavorite}
				/>
			</div>
		</div>
	);
}

