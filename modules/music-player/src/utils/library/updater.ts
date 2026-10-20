/**
 * 音乐库更新工具模块
 * 
 * 提供音乐库扫描和更新的功能，包括：
 * - 扫描音乐文件
 * - 提取音频元数据（标题、艺术家、专辑、歌词等）
 * - 生成艺术家和专辑信息
 * - 更新插件设置
 * 
 * 注意：
 * - 封面图片只从音频文件的元数据中提取内嵌封面，实时获取，不保存到 data.json 中。
 * - 歌词只从音频文件的元数据标签中提取，不从外部 .lrc 文件读取。
 */

import { App, Notice } from "obsidian";
import MusicPlayerPlugin from "@/main";
import { getEmbeddedAudioMetadataFromBuffer, readAudioFileBinary } from "../audio/metadata";
import { generateArtistsAndAlbums } from "../data/transform";
import { scanVaultAudioFiles } from "./scanVaultAudio";
import { t, tWithParams } from "@/utils/i18n/i18n";

/**
 * 重建所有数据
 * 
 * 完全重建音乐库的所有数据，包括：
 * - 重新扫描所有音乐文件
 * - 重新提取元数据（标题、艺术家、专辑、歌词等）
 * - 重新生成艺术家和专辑分类
 * - 清理收藏列表和歌单中的无效项
 * - 完全重写 JSON 文件
 * 
 * 封面图片只从音频文件的元数据中提取内嵌封面，实时获取，不存储在 data.json 中。
 * 这个过程可能比较耗时，会显示进度通知。
 * 
 * @param app Obsidian 应用实例
 * @param plugin 插件实例
 * @returns 返回处理成功的歌曲数量
 */
export async function rebuildAllData(
	app: App,
	plugin: MusicPlayerPlugin
): Promise<number> {
	const notice = new Notice(t("notice.scanning"), 0);
	
	try {
		// 1. 按音乐文件夹设置扫描音频文件（文件夹树遍历，非 vault.getFiles）
		const filteredFiles = scanVaultAudioFiles(app, plugin.settings.musicFolder ?? "");

		// 2. 如果没有找到音乐文件，清空所有数据并保存
		if (filteredFiles.length === 0) {
			console.warn("未找到任何音乐文件，请检查音乐文件夹设置");
			// 清空所有数据，确保 JSON 文件与实际情况一致
			plugin.settings.musicFolder = plugin.settings.musicFolder || '';
			plugin.settings.trackIndex = {};
			plugin.settings.tracks = {};
			plugin.settings.favorites = [];
			plugin.settings.playlists = {};
			plugin.settings.artists = {};
			plugin.settings.albums = {};
			// 保存清空后的数据
			await plugin.saveSettings();
			new Notice(t("notice.noMusicCleared"), 5000);
			return 0;
		}

		// 5. 初始化数据结构
		
		plugin.settings.musicFolder = plugin.settings.musicFolder || '';
		plugin.settings.trackIndex = {}; // 清空 ID 映射表，重新构建
		plugin.settings.tracks = {};
		plugin.settings.favorites = plugin.settings.favorites || [];
		plugin.settings.playlists = plugin.settings.playlists || {};
		plugin.settings.artists = {};
		plugin.settings.albums = {};
		

		let processed = 0;
		const total = filteredFiles.length;
		
		// 6. 处理每个音乐文件
		for (const file of filteredFiles) {
			try {
				notice.setMessage(
					tWithParams("notice.processingFile", {
						basename: file.basename,
						current: processed + 1,
						total,
					})
				);
				
				// 读取音频文件的二进制数据（兼容移动端）
				const binary = await readAudioFileBinary(app, file);
				if (!binary) {
					console.warn(`无法读取文件 ${file.path}`);
					continue;
				}
				
				const audioMetadata = await getEmbeddedAudioMetadataFromBuffer(binary);
				if (!audioMetadata) {
					console.warn(`无法提取文件 ${file.path} 的元数据`);
					continue;
				}

				// 如果仍然没有标题，记录警告以便调试
				if (!audioMetadata.title) {
					console.warn(`文件 ${file.path} 未找到标题元数据，将使用文件名: ${file.basename}`);
				}

				// 更新曲目元数据
				// 注意：
				// - 封面图片只从音频文件的元数据中提取内嵌封面，实时获取，不保存到 data.json 中
				// - 歌词只从音频文件的 LYRICS 标签提取（写入 lyrics）
				// - 使用 ID 系统：获取或创建曲目 ID，然后使用 ID 作为键
				const { getOrCreateTrackId } = await import("@/utils/track/id");
				const trackId = getOrCreateTrackId(file.path, plugin.settings);
				
				plugin.settings.tracks[trackId] = {
					title: audioMetadata.title || file.basename,
				artist: audioMetadata.artist?.trim() || '',
				album: audioMetadata.album?.trim() || '',
					// 封面只从音频文件的元数据中提取内嵌封面，实时获取，不保存
					// 歌词从音频文件的元数据标签中提取
					lyrics: audioMetadata.lyricsText || '',
					year: audioMetadata.year,
					genre: Array.isArray(audioMetadata.genre) ? 
						audioMetadata.genre[0] : audioMetadata.genre,
					track: audioMetadata.track,
					duration: audioMetadata.duration
				};

				processed++;
				console.debug(`成功处理文件: ${file.path}, 已处理 ${processed}/${total}`);
				
				// 每处理5个文件更新一次进度
				if (processed % 5 === 0 || processed === total) {
					notice.setMessage(tWithParams("notice.progressTracks", { current: processed, total }));
				}
			} catch (error) {
				console.error(`处理文件 ${file.path} 时出错:`, error);
				// 继续处理下一个文件
			}
		}

		// 7. 生成艺术家和专辑信息
		notice.setMessage(t("notice.generatingCategories"));
		const { artists, albums } = generateArtistsAndAlbums(plugin.settings);
		plugin.settings.artists = artists;
		plugin.settings.albums = albums;

		// 8. 清理无效的数据
		notice.setMessage(t("notice.cleaningInvalid"));
		const validTrackIds = new Set(Object.keys(plugin.settings.tracks));
		
		// 清理 trackIndex：只保留存在的曲目 ID
		if (plugin.settings.trackIndex) {
			const originalTrackIndexCount = Object.keys(plugin.settings.trackIndex).length;
			const cleanedTrackIndex: Record<string, string> = {};
			for (const [trackId, path] of Object.entries(plugin.settings.trackIndex)) {
				if (validTrackIds.has(trackId)) {
					cleanedTrackIndex[trackId] = path;
				}
			}
			plugin.settings.trackIndex = cleanedTrackIndex;
			const removedTrackIndexCount = originalTrackIndexCount - Object.keys(plugin.settings.trackIndex).length;
			if (removedTrackIndexCount > 0) {
				console.debug(`已从 trackIndex 中移除 ${removedTrackIndexCount} 个无效的 ID 映射`);
			}
		}
		
		// 清理收藏列表：只保留存在的曲目 ID
		if (plugin.settings.favorites) {
			const originalFavoritesCount = plugin.settings.favorites.length;
			plugin.settings.favorites = plugin.settings.favorites.filter(id => validTrackIds.has(id));
			const removedFavoritesCount = originalFavoritesCount - plugin.settings.favorites.length;
			if (removedFavoritesCount > 0) {
				console.debug(`已从收藏列表中移除 ${removedFavoritesCount} 首不存在的曲目`);
			}
		}
		
		// 清理歌单：只保留存在的曲目 ID
		if (plugin.settings.playlists) {
			let totalRemovedFromPlaylists = 0;
			for (const [playlistName, trackIds] of Object.entries(plugin.settings.playlists)) {
				if (Array.isArray(trackIds)) {
					const originalCount = trackIds.length;
					plugin.settings.playlists[playlistName] = trackIds.filter(id => validTrackIds.has(id));
					const updatedPlaylist = plugin.settings.playlists[playlistName];
					const removedCount = originalCount - (updatedPlaylist?.length ?? 0);
					if (removedCount > 0) {
						totalRemovedFromPlaylists += removedCount;
						console.debug(`已从歌单 "${playlistName}" 中移除 ${removedCount} 首不存在的曲目`);
					}
				}
			}
			if (totalRemovedFromPlaylists > 0) {
				console.debug(`共从所有歌单中移除了 ${totalRemovedFromPlaylists} 首不存在的歌曲`);
			}
		}

		// 9. 保存设置到 data.json
		notice.setMessage(t("notice.saving"));
		await plugin.saveSettings();

		new Notice(tWithParams("notice.rebuildDone", { count: processed }), 3000);
		
		return processed;
		
	} catch (error) {
		console.error("重建数据时出错:", error);
		new Notice(t("notice.rebuildError"), 5000);
		throw error;
	} finally {
		// 关闭进度通知
		notice.hide();
	}
}

