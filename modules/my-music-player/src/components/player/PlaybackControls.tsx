/**
 * 播放控制组件
 * 
 * 提供音乐播放的基本控制功能，包括：
 * - 播放/暂停按钮
 * - 上一首/下一首按钮
 * - 播放模式切换按钮（顺序、循环、单曲循环、随机）
 * - 播放列表查看按钮
 */

import React from "react";
import type { PlayMode } from "@/main";
import { setIcon } from "obsidian";
import { t } from "@/utils/i18n/i18n";

/**
 * 播放控制组件的属性接口
 */
export interface PlaybackControlsProps {
	/** 是否正在播放 */
	isPlaying: boolean;
	/** 当前播放模式 */
	playMode: PlayMode;
	/** 切换播放/暂停的回调函数 */
	onTogglePlay: () => void;
	/** 播放上一首的回调函数 */
	onPrev: () => void;
	/** 播放下一首的回调函数 */
	onNext: () => void;
	/** 切换播放模式的回调函数 */
	onToggleMode: () => void;
	/** 打开播放列表的回调函数 */
	onOpenPlaylist: () => void;
}

/**
 * 获取播放模式的无障碍标签
 */
function playModeLabel(mode: PlayMode): string {
	if (mode === "repeat-one") return t("playback.mode.repeatOne");
	if (mode === "repeat-all") return t("playback.mode.repeatAll");
	if (mode === "shuffle") return t("playback.mode.shuffle");
	return t("playback.mode.normal");
}

/**
 * 获取播放模式对应的 Obsidian 图标名称
 * 
 * @param mode 播放模式
 * @returns 返回图标名称
 */
function playModeIcon(mode: PlayMode): string {
	if (mode === "repeat-one") return "repeat-1";
	if (mode === "repeat-all") return "repeat";
	if (mode === "shuffle") return "shuffle";
	return "list-ordered"; // 顺序播放
}

/**
 * 设置按钮的 Obsidian 图标
 * 
 * @param ref 按钮元素的 ref
 * @param icon 图标名称
 */
function setButtonIcon(ref: React.RefObject<HTMLElement>, icon: string) {
	if (ref.current) setIcon(ref.current, icon);
}

/**
 * 播放控制组件
 * 
 * 显示播放控制按钮，包括播放/暂停、上一首/下一首、播放模式切换、播放列表查看等。
 * 
 * @param props 组件属性
 */
export function PlaybackControls(props: PlaybackControlsProps) {
	const { isPlaying, playMode, onTogglePlay, onPrev, onNext, onToggleMode, onOpenPlaylist } = props;

	const modeRef = React.useRef<HTMLButtonElement | null>(null);
	const prevRef = React.useRef<HTMLButtonElement | null>(null);
	const playPauseRef = React.useRef<HTMLButtonElement | null>(null);
	const nextRef = React.useRef<HTMLButtonElement | null>(null);
	const playlistRef = React.useRef<HTMLButtonElement | null>(null);

	// 设置 Obsidian 内置图标
	React.useEffect(() => {
		setButtonIcon(modeRef, playModeIcon(playMode));
		setButtonIcon(prevRef, "skip-back");
		setButtonIcon(nextRef, "skip-forward");
		setButtonIcon(playPauseRef, isPlaying ? "pause" : "play");
		setButtonIcon(playlistRef, "list-music");
	}, [playMode, isPlaying]);

	return (
		<div className="controls-row" onClick={(e) => e.stopPropagation()}>
			<button
				ref={modeRef}
				className="play-control-btn clickable-icon"
				aria-label={playModeLabel(playMode)}
				onClick={onToggleMode}
			>
				<div className="mode-tooltip">{playModeLabel(playMode)}</div>
			</button>

			<button ref={prevRef} className="play-control-btn clickable-icon" aria-label={t("playback.prev")} onClick={onPrev}>
			</button>

			<button
				ref={playPauseRef}
				className="play-control-btn clickable-icon play-pause-btn"
				onClick={onTogglePlay}
				aria-label={isPlaying ? t("playback.pause") : t("playback.play")}
			>
			</button>

			<button ref={nextRef} className="play-control-btn clickable-icon" aria-label={t("playback.next")} onClick={onNext}>
			</button>

			<button
				ref={playlistRef}
				className="play-control-btn clickable-icon"
				aria-label={t("playback.queue")}
				onClick={onOpenPlaylist}
			>
			</button>
		</div>
	);
}

