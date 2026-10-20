/**
 * 唱片旋转动画 Hook
 * 
 * 负责管理播放时唱片的旋转动画，使用 requestAnimationFrame 驱动。
 */

import React from "react";

/**
 * Hook 的输入参数
 */
export interface UseDiscRotationParams {
	/** 是否正在播放 */
	isPlaying: boolean;
}

/**
 * Hook 的返回值
 */
export interface UseDiscRotationReturn {
	/** 当前旋转角度（度） */
	rotationAngle: number;
	/** 用于应用旋转角度的 ref（用于 DOM 元素） */
	currentDiscRef: React.RefObject<HTMLDivElement>;
	/** 重置旋转角度（用于切歌后重置） */
	resetRotation: () => void;
}

/**
 * 唱片旋转动画 Hook
 * 
 * 管理播放时唱片的旋转动画，使用 requestAnimationFrame 驱动。
 * 旋转速度：20秒转一圈（360度）。
 * 
 * @param params Hook 参数
 * @returns Hook 返回值
 */
export function useDiscRotation({ isPlaying }: UseDiscRotationParams): UseDiscRotationReturn {
	const [rotationAngle, setRotationAngle] = React.useState(0);
	const rotationRef = React.useRef<number>(0);
	const animationStartTimeRef = React.useRef<number>(0);
	const animationStartAngleRef = React.useRef<number>(0);
	const animationFrameRef = React.useRef<number | null>(null);
	const currentDiscRef = React.useRef<HTMLDivElement>(null);

	// 动画循环函数，用于更新旋转角度
	const updateRotation = React.useCallback(() => {
		if (isPlaying && currentDiscRef.current) {
			const now = Date.now();
			const elapsed = now - animationStartTimeRef.current;
			// 20秒转一圈（20000毫秒）
			const rotationSpeed = 360 / 20000; // 度/毫秒
			const currentAngle = animationStartAngleRef.current + (elapsed * rotationSpeed);
			rotationRef.current = currentAngle;
			setRotationAngle(currentAngle);
			animationFrameRef.current = window.requestAnimationFrame(updateRotation);
		}
	}, [isPlaying]);

	// 监听播放状态变化，保存旋转角度
	React.useEffect(() => {
		if (isPlaying) {
			// 开始播放时，记录开始时间和起始角度
			animationStartTimeRef.current = Date.now();
			animationStartAngleRef.current = rotationRef.current;
			// 开始动画循环
			animationFrameRef.current = window.requestAnimationFrame(updateRotation);
		} else {
			// 停止播放时，取消动画循环
			if (animationFrameRef.current !== null) {
				cancelAnimationFrame(animationFrameRef.current);
				animationFrameRef.current = null;
			}
			// 角度已经在 rotationRef.current 中，直接使用
			setRotationAngle(rotationRef.current);
		}
		
		// cleanup 函数会在依赖变化或组件卸载时执行，确保清理动画帧
		return () => {
			if (animationFrameRef.current !== null) {
				cancelAnimationFrame(animationFrameRef.current);
				animationFrameRef.current = null;
			}
		};
	}, [isPlaying, updateRotation]);

	// 重置旋转角度（用于切歌后重置）
	const resetRotation = React.useCallback(() => {
		setRotationAngle(0);
		rotationRef.current = 0;
		animationStartAngleRef.current = 0;
		animationStartTimeRef.current = Date.now();
		if (animationFrameRef.current !== null) {
			cancelAnimationFrame(animationFrameRef.current);
			animationFrameRef.current = null;
		}
		if (isPlaying) {
			animationFrameRef.current = window.requestAnimationFrame(updateRotation);
		}
	}, [isPlaying, updateRotation]);

	return {
		rotationAngle,
		currentDiscRef,
		resetRotation,
	};
}

