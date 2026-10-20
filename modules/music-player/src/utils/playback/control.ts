/**
 * 播放控制工具函数
 * 
 * 包含播放控制相关的纯函数，不依赖任何服务或状态。
 * 提供播放列表导航、播放模式切换等功能。
 */

import type { PlayMode } from "@/main";
import { TFile } from "obsidian";

/**
 * 计算上一首歌曲的索引
 * 
 * 根据当前播放模式和索引，计算应该播放的上一首歌曲的索引。
 * - 随机模式：返回随机索引
 * - 其他模式：返回当前索引减1，如果已经是第一首则返回最后一首（循环播放）
 * 
 * @param currentIndex 当前播放的歌曲索引
 * @param list 播放列表（歌曲文件数组）
 * @param playMode 播放模式（normal、repeat-all、repeat-one、shuffle）
 * @returns 返回上一首歌曲的索引
 */
export function getPreviousIndex(
	currentIndex: number,
	list: TFile[],
	playMode: PlayMode
): number {
	if (playMode === "shuffle") {
		return Math.floor(Math.random() * list.length);
	}
	return currentIndex > 0 ? currentIndex - 1 : list.length - 1;
}

/**
 * 计算下一首歌曲的索引
 * 
 * 根据当前播放模式和索引，计算应该播放的下一首歌曲的索引。
 * - 随机模式：返回随机索引
 * - 其他模式：返回当前索引加1，如果已经是最后一首则返回第一首（循环播放）
 * 
 * @param currentIndex 当前播放的歌曲索引
 * @param list 播放列表（歌曲文件数组）
 * @param playMode 播放模式（normal、repeat-all、repeat-one、shuffle）
 * @returns 返回下一首歌曲的索引
 */
export function getNextIndex(
	currentIndex: number,
	list: TFile[],
	playMode: PlayMode
): number {
	if (playMode === "shuffle") {
		return Math.floor(Math.random() * list.length);
	}
	return currentIndex < list.length - 1 ? currentIndex + 1 : 0;
}

/**
 * 根据播放模式处理歌曲结束后的行为
 * 
 * 根据不同的播放模式，决定歌曲播放结束后应该执行的操作：
 * - repeat-one：单曲循环，重复播放当前歌曲
 * - repeat-all：列表循环，播放下一首
 * - normal：正常模式，如果是最后一首则停止，否则播放下一首
 * - shuffle：随机模式，播放下一首（随机选择）
 * 
 * @param playMode 播放模式
 * @param currentIndex 当前播放的歌曲索引
 * @param list 播放列表（歌曲文件数组）
 * @returns 返回包含三个布尔值的对象：
 *   - shouldPlayNext: 是否应该播放下一首
 *   - shouldRepeat: 是否应该重复播放当前歌曲
 *   - shouldStop: 是否应该停止播放
 */
export function handleTrackEnd(
	playMode: PlayMode,
	currentIndex: number,
	list: TFile[]
): {
	shouldPlayNext: boolean;
	shouldRepeat: boolean;
	shouldStop: boolean;
} {
	if (playMode === "repeat-one") {
		return { shouldPlayNext: false, shouldRepeat: true, shouldStop: false };
	} else if (playMode === "repeat-all") {
		return { shouldPlayNext: true, shouldRepeat: false, shouldStop: false };
	} else if (playMode === "normal") {
		const isLast = currentIndex >= list.length - 1;
		return { shouldPlayNext: !isLast, shouldRepeat: false, shouldStop: isLast };
	} else if (playMode === "shuffle") {
		return { shouldPlayNext: true, shouldRepeat: false, shouldStop: false };
	}
	return { shouldPlayNext: false, shouldRepeat: false, shouldStop: true };
}

/**
 * 切换播放模式
 * 
 * 在四种播放模式之间循环切换：
 * normal -> repeat-all -> repeat-one -> shuffle -> normal
 * 
 * @param currentMode 当前播放模式
 * @returns 返回下一个播放模式
 */
export function togglePlayMode(currentMode: PlayMode): PlayMode {
	const modes: Array<"normal" | "repeat-all" | "repeat-one" | "shuffle"> = [
		"normal",
		"repeat-all",
		"repeat-one",
		"shuffle",
	];
	const currentIndex = modes.indexOf(currentMode);
	const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % modes.length;
	const nextMode = modes[nextIndex];
	if (!nextMode) {
		// 理论上不会发生，但为了类型安全
		return "normal";
	}
	return nextMode;
}

/**
 * 在全局播放列表中查找指定歌曲的索引
 * 
 * 通过比较文件路径来查找歌曲在列表中的位置。
 * 
 * @param track 要查找的歌曲文件
 * @param globalList 全局播放列表（歌曲文件数组）
 * @returns 返回歌曲在列表中的索引，如果未找到则返回 -1
 */
export function findTrackIndexInGlobalList(track: TFile, globalList: TFile[]): number {
	return globalList.findIndex((f) => f.path === track.path);
}

