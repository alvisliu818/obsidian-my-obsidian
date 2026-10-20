/**
 * 播放进度条组件
 *
 * 进度条支持指针拖动（拖动时仅视觉跟随，松手后才 seek）与单击跳转（立即 seek）；
 * 左侧时间单击/双击快退，右侧单击/双击快进。
 */

import React from "react";
import "./ProgressBar.css";
import { t } from "@/utils/i18n/i18n";

/** 区分单击与双击的延迟（毫秒） */
const CLICK_VS_DOUBLE_MS = 280;

/**
 * 播放进度条组件的属性接口
 */
export interface ProgressBarProps {
	/** 当前播放时间（秒） */
	current: number;
	/** 总时长（秒） */
	duration: number;
	/** 跳转到指定比例（0–1），单击立即 seek；拖动过程仅在松手时调用一次 */
	onSeek: (ratio: number) => void;
	/** 快退若干秒（正数，由实现从当前时间减去） */
	onSeekBackward: (seconds: number) => void;
	/** 快进若干秒（正数） */
	onSeekForward: (seconds: number) => void;
}

/**
 * 格式化时间为 MM:SS 格式
 * 
 * @param sec 秒数
 * @returns 返回格式化的时间字符串（如 "3:45"）
 */
export function formatTime(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return "0:00";
	const s = Math.floor(sec);
	const m = Math.floor(s / 60);
	const r = s % 60;
	return `${m}:${r.toString().padStart(2, "0")}`;
}

/**
 * 播放进度条：指针按下仅视觉跟随，拖动过程中连续更新本地比例（不 seek），
 * 松手后才一次性 seek；释放指针结束拖动。
 */
export function ProgressBar({ current, duration, onSeek, onSeekBackward, onSeekForward }: ProgressBarProps) {
	const barRef = React.useRef<HTMLDivElement | null>(null);
	const dragActiveRef = React.useRef(false);
	const [isDragging, setIsDragging] = React.useState(false);
	/** 拖动期间的本地比例（0–1），松手前仅用于视觉呈现，不触发 seek */
	const [dragRatio, setDragRatio] = React.useState<number | null>(null);
	/** 松手后临时锁定显示比例，直到真实 current 追上目标，避免点击后回闪 */
	const pendingRatioRef = React.useRef(false);

	/** DOM 定时器 id（用 number 避免与 NodeJS.Timeout 在 tsc 下的冲突） */
	const leftClickTimerRef = React.useRef<number | null>(null);
	const rightClickTimerRef = React.useRef<number | null>(null);

	React.useEffect(() => {
		return () => {
			if (leftClickTimerRef.current) window.clearTimeout(leftClickTimerRef.current);
			if (rightClickTimerRef.current) window.clearTimeout(rightClickTimerRef.current);
		};
	}, []);

	/**
	 * 拖动期间在 activeDocument 上拦截 touchmove（非 passive + preventDefault），
	 * 避免 Obsidian / WebView 把水平滑动识别为侧栏收缩或边缘系统手势（弹窗窗口用 activeDocument）。
	 */
	React.useEffect(() => {
		if (!isDragging) return;
		const blockTouchMove = (e: TouchEvent) => {
			e.preventDefault();
		};
		window.activeDocument.addEventListener("touchmove", blockTouchMove, { passive: false });
		return () => {
			window.activeDocument.removeEventListener("touchmove", blockTouchMove);
		};
	}, [isDragging]);

	const ratioFromClientX = React.useCallback((clientX: number): number | null => {
		const el = barRef.current;
		if (!el) return null;
		const rect = el.getBoundingClientRect();
		const w = rect.width;
		if (w <= 0) return null;
		return Math.min(Math.max((clientX - rect.left) / w, 0), 1);
	}, []);

	/**
	 * 松手 seek 后，真实 currentTime 需要一段时间才更新。在此期间保留 dragRatio 作为显示，
	 * 直到 current 真正追平目标比例（或超时兜底），才释放回真实进度，避免点击后回闪。
	 */
	React.useEffect(() => {
		if (!pendingRatioRef.current || dragRatio === null) return;
		const target = dragRatio;
		const settle = () => {
			pendingRatioRef.current = false;
			setDragRatio(null);
		};
		// 当前进度已接近目标即视为追上
		if (duration > 0 && Math.abs(current / duration - target) < 0.01) {
			settle();
			return;
		}
		// 超时兜底：即使 seek 回调迟迟未更新 current，也不让进度条卡在目标位置
		const timer = window.setTimeout(settle, 700);
		return () => window.clearTimeout(timer);
	}, [current, duration, dragRatio]);

	const endBarDrag = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		if (!dragActiveRef.current) return;
		e.stopPropagation();
		const target = e.currentTarget;
		const ratio = ratioFromClientX(e.clientX);
		try {
			if (target.hasPointerCapture(e.pointerId)) {
				target.releasePointerCapture(e.pointerId);
			}
		} catch {
			// 已释放时忽略
		}
		dragActiveRef.current = false;
		setIsDragging(false);
		// 松开指针后保留 dragRatio 用于视觉呈现，直到真实 current 追上目标，避免回闪
		if (ratio !== null) {
			pendingRatioRef.current = true;
			onSeek(ratio);
		} else {
			setDragRatio(null);
		}
	}, [onSeek, ratioFromClientX]);

	const onBarLostPointerCapture = React.useCallback(() => {
		dragActiveRef.current = false;
		setIsDragging(false);
		// 若已触发 seek 且正在等待 current 追上，则保留 dragRatio 不清除，避免回闪
		if (!pendingRatioRef.current) {
			setDragRatio(null);
		}
	}, []);

	const onBarPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		e.stopPropagation();
		if (e.pointerType === "touch") {
			e.preventDefault();
		}
		dragActiveRef.current = true;
		setIsDragging(true);
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {
			dragActiveRef.current = false;
			setIsDragging(false);
			return;
		}
		// 仅记录拖拽起点用于视觉跟随，松手后才 seek
		const ratio = ratioFromClientX(e.clientX);
		if (ratio !== null) setDragRatio(ratio);
	};

	const onBarPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!dragActiveRef.current) return;
		e.stopPropagation();
		e.preventDefault();
		// 拖动期间仅更新本地比例，避免实时 seek 造成的"搓碟"与性能浪费
		const ratio = ratioFromClientX(e.clientX);
		if (ratio !== null) setDragRatio(ratio);
	};

	const scheduleLeftSingle = () => {
		if (leftClickTimerRef.current) window.clearTimeout(leftClickTimerRef.current);
		leftClickTimerRef.current = window.setTimeout(() => {
			leftClickTimerRef.current = null;
			onSeekBackward(5);
		}, CLICK_VS_DOUBLE_MS);
	};

	const onLeftTimeClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		scheduleLeftSingle();
	};

	const onLeftTimeDoubleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		e.preventDefault();
		if (leftClickTimerRef.current) {
			window.clearTimeout(leftClickTimerRef.current);
			leftClickTimerRef.current = null;
		}
		onSeekBackward(15);
	};

	const scheduleRightSingle = () => {
		if (rightClickTimerRef.current) window.clearTimeout(rightClickTimerRef.current);
		rightClickTimerRef.current = window.setTimeout(() => {
			rightClickTimerRef.current = null;
			onSeekForward(5);
		}, CLICK_VS_DOUBLE_MS);
	};

	const onRightTimeClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		scheduleRightSingle();
	};

	const onRightTimeDoubleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		e.preventDefault();
		if (rightClickTimerRef.current) {
			window.clearTimeout(rightClickTimerRef.current);
			rightClickTimerRef.current = null;
		}
		onSeekForward(15);
	};

	// 拖动期间使用本地比例驱动视觉，松手后回落到真实播放进度
	const displayRatio = dragRatio !== null ? dragRatio : duration > 0 ? current / duration : 0;
	const displayPercent = Math.min(Math.max(displayRatio * 100, 0), 100);
	const displayCurrent = dragRatio !== null ? dragRatio * duration : current;

	return (
		<div className="play-progress-container">
			<span
				className="play-time current-time"
				aria-label={t("playback.progress.currentHint")}
				onClick={onLeftTimeClick}
				onDoubleClick={onLeftTimeDoubleClick}
			>
				{formatTime(displayCurrent)}
			</span>
			<div
				ref={barRef}
				className={`play-progress-bar${isDragging ? " is-dragging" : ""}`}
				onPointerDown={onBarPointerDown}
				onPointerMove={onBarPointerMove}
				onPointerUp={endBarDrag}
				onPointerCancel={endBarDrag}
				onLostPointerCapture={onBarLostPointerCapture}
			>
				<div className="play-progress-fill" style={{ width: `${displayPercent}%` }} />
			</div>
			<span
				className="play-time duration"
				aria-label={t("playback.progress.durationHint")}
				onClick={onRightTimeClick}
				onDoubleClick={onRightTimeDoubleClick}
			>
				{formatTime(duration)}
			</span>
		</div>
	);
}

