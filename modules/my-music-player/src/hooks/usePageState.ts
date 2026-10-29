/**
 * 页面状态管理 Hook
 * 
 * 管理页面特定的状态，如 lastAction（用于 DiscPage 的动画效果）
 */

import * as React from "react";

export interface UsePageStateReturn {
	/** 用于 DiscPage 的 lastAction 状态 */
	lastAction: "next" | "prev" | null;
	/** 处理上一首（带 lastAction 标记） */
	handlePrevWithFlag: (onPrev: () => void) => void;
	/** 处理下一首（带 lastAction 标记） */
	handleNextWithFlag: (onNext: () => void) => void;
	/** 清除 lastAction（用于直接选择歌曲时） */
	clearLastAction: () => void;
}

/**
 * 页面状态管理 Hook
 * 
 * @returns 页面状态和操作方法
 */
export function usePageState(): UsePageStateReturn {
	const [lastAction, setLastAction] = React.useState<"next" | "prev" | null>(null);

	const handlePrevWithFlag = React.useCallback(
		(onPrev: () => void) => {
			setLastAction("prev");
			onPrev();
		},
		[]
	);

	const handleNextWithFlag = React.useCallback(
		(onNext: () => void) => {
			setLastAction("next");
			onNext();
		},
		[]
	);

	const clearLastAction = React.useCallback(() => {
		setLastAction(null);
	}, []);

	return {
		lastAction,
		handlePrevWithFlag,
		handleNextWithFlag,
		clearLastAction,
	};
}

