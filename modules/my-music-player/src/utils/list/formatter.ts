/**
 * 列表格式化工具函数
 *
 * 在「类型 + 名称」与稳定列表 ID 字符串之间转换，以及将列表 ID 格式化为界面展示文案。
 */

import { t, tWithParams } from "@/utils/i18n/i18n";

/**
 * 将播放列表信息转换为 currentList / listId 字符串格式
 *
 * @param type 列表类型（"all"、"favorites"、"playlist"、"artist"、"album"）
 * @param name 列表名称（对于 playlist、artist、album 类型必需）
 * @returns 格式化后的列表标识符；类型或名称无效时返回 "all"
 */
export function formatCurrentList(type: string, name?: string): string {
	if (type === "all") return "all";
	if (type === "favorites") return "favorites";
	if (type === "playlist" && name) return `playlist:${name}`;
	if (type === "artist" && name) return `artist:${name}`;
	if (type === "album" && name) return `album:${name}`;
	return "all";
}

/**
 * 将稳定列表 ID 格式化为当前语言下的一句展示文案（如队列占位符中的上下文）。
 */
export function formatListLabel(listId: string): string {
	if (!listId || listId === "all") return t("list.all");
	if (listId === "favorites") return t("list.favorites");
	if (listId.startsWith("playlist:")) {
		const name = listId.slice("playlist:".length);
		return tWithParams("list.playlistLabel", { name });
	}
	if (listId.startsWith("artist:")) {
		const raw = listId.slice("artist:".length).trim();
		const name = raw === "" ? t("meta.unknownArtist") : raw;
		return tWithParams("list.artistLabel", { name });
	}
	if (listId.startsWith("album:")) {
		const raw = listId.slice("album:".length).trim();
		const name = raw === "" ? t("meta.unknownAlbum") : raw;
		return tWithParams("list.albumLabel", { name });
	}
	return t("list.all");
}
