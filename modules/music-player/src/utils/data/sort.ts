/**
 * 数据排序工具模块
 * 
 * 提供曲目列表排序相关的工具函数
 */

import type { TFile } from "obsidian";
import type { MusicPlayerSettings } from "@/types";
import { getOrCreateTrackId } from "@/utils/track/id";

/**
 * 按音轨号排序曲目列表
 * 先按专辑分组，同一专辑内按音轨号排序
 * 
 * @param tracks 曲目文件数组
 * @param settings 插件设置，包含曲目元数据
 * @returns 排序后的曲目文件数组
 */
export function sortTracksByTrack(
	tracks: TFile[],
	settings: MusicPlayerSettings
): TFile[] {
	// 过滤掉 undefined 和 null 值，防止访问 path 属性时出错
	const validTracks = tracks.filter((file): file is TFile => file != null);
	
	// 按专辑分组
	const albumMap = new Map<string, TFile[]>();
	validTracks.forEach((file) => {
		// 通过路径获取 ID，然后通过 ID 获取 track 信息
		const trackId = getOrCreateTrackId(file.path, settings);
		const track = settings.tracks[trackId];
		const album = (track?.album ?? "").trim();
		if (!albumMap.has(album)) {
			albumMap.set(album, []);
		}
		albumMap.get(album)!.push(file);
	});

	// 对每个专辑内的曲目按音轨号排序
	const sortedTracks: TFile[] = [];
	Array.from(albumMap.entries())
		.sort((a, b) => a[0].localeCompare(b[0], "zh-Hans-CN"))
		.forEach(([_album, albumTracks]) => {
			// 同一专辑内按音轨号排序
			const sortedAlbumTracks = albumTracks.sort((a, b) => {
				const trackIdA = getOrCreateTrackId(a.path, settings);
				const trackIdB = getOrCreateTrackId(b.path, settings);
				const trackA = settings.tracks[trackIdA];
				const trackB = settings.tracks[trackIdB];
				const trackNumberA = trackA?.track ?? Number.MAX_SAFE_INTEGER;
				const trackNumberB = trackB?.track ?? Number.MAX_SAFE_INTEGER;
				return trackNumberA - trackNumberB;
			});
			sortedTracks.push(...sortedAlbumTracks);
		});

	return sortedTracks;
}

/**
 * 按名称排序（用于艺术家、专辑等）
 * 未知项排在最后
 * 
 * @param items 要排序的项数组
 * @param getName 获取名称的函数
 * @param unknownName 未知项的名称（如"未知艺术家"、"未知专辑"）
 * @returns 排序后的数组
 */
export function sortByName<T>(
	items: T[],
	getName: (item: T) => string,
	unknownName: string = "未知"
): T[] {
	return items.sort((a, b) => {
		const nameA = getName(a);
		const nameB = getName(b);
		// 未知项排在最后
		if (nameA === unknownName) return 1;
		if (nameB === unknownName) return -1;
		return nameA.localeCompare(nameB, "zh-Hans-CN");
	});
}

