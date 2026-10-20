/**
 * 导航状态管理 Hook
 * 
 * 统一管理 Tab 切换和页面切换逻辑，简化 MusicPlayerRoot 组件
 */

import * as React from "react";

export type TabType = "currentDisc" | "library";
export type PageType = "disc" | "lyrics";

export interface UseNavigationReturn {
	/** 当前激活的 Tab */
	tab: TabType;
	/** 当前激活的页面（仅在 currentDisc tab 下有效） */
	currentPage: PageType;
	/** 切换到 library tab */
	openLibrary: () => void;
	/** 切换到 currentDisc tab 的 disc 页面 */
	openDisc: () => void;
	/** 切换到 currentDisc tab 的 lyrics 页面 */
	openLyrics: () => void;
	/** 在 currentDisc tab 内切换到 lyrics 页面 */
	switchToLyrics: () => void;
	/** 在 currentDisc tab 内切换到 disc 页面 */
	switchToDisc: () => void;
	/** 是否需要在切换到 lyrics 时标记首次挂载 */
	shouldMarkInitialLyricsMount: boolean;
	/** 清除首次挂载标记 */
	clearInitialLyricsMount: () => void;
}

/**
 * 导航状态管理 Hook
 * 
 * @returns 导航状态和操作方法
 */
export function useNavigation(): UseNavigationReturn {
	const [tab, setTab] = React.useState<TabType>("currentDisc");
	const [currentPage, setCurrentPage] = React.useState<PageType>("disc");
	const [pendingPage, setPendingPage] = React.useState<PageType | null>(null);
	const [shouldMarkInitialLyricsMount, setShouldMarkInitialLyricsMount] = React.useState(false);

	// 处理待处理的页面切换
	React.useEffect(() => {
		if (pendingPage && tab === "currentDisc") {
			setCurrentPage(pendingPage);
			if (pendingPage === "lyrics") {
				setShouldMarkInitialLyricsMount(true);
			}
			setPendingPage(null);
		}
	}, [pendingPage, tab]);

	const openLibrary = React.useCallback(() => {
		setTab("library");
	}, []);

	const openDisc = React.useCallback(() => {
		setTab("currentDisc");
		if (currentPage !== "disc") {
			setPendingPage("disc");
		}
	}, [currentPage]);

	const openLyrics = React.useCallback(() => {
		if (tab !== "currentDisc") {
			setPendingPage("lyrics");
			setTab("currentDisc");
		} else {
			setShouldMarkInitialLyricsMount(true);
			setCurrentPage("lyrics");
		}
	}, [tab]);

	const switchToLyrics = React.useCallback(() => {
		setShouldMarkInitialLyricsMount(true);
		setCurrentPage("lyrics");
	}, []);

	const switchToDisc = React.useCallback(() => {
		setCurrentPage("disc");
	}, []);

	const clearInitialLyricsMount = React.useCallback(() => {
		setShouldMarkInitialLyricsMount(false);
	}, []);

	return {
		tab,
		currentPage,
		openLibrary,
		openDisc,
		openLyrics,
		switchToLyrics,
		switchToDisc,
		shouldMarkInitialLyricsMount,
		clearInitialLyricsMount,
	};
}

