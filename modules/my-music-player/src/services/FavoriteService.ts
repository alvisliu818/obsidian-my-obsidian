/**
 * 收藏管理服务
 * 
 * 负责管理收藏相关的业务逻辑，包括：
 * - 切换收藏状态
 * - 检查是否已收藏
 * 
 * 收藏数据存储在插件的设置中，通过 favorites 数组保存收藏的曲目 ID。
 */

import MusicPlayerPlugin from "@/main";

/**
 * 收藏管理服务类
 * 
 * 提供收藏功能的增删查操作，所有操作都会持久化到插件设置中。
 * 使用 ID 系统，所有操作都基于曲目 ID。
 */
export class FavoriteService {
	/**
	 * 创建收藏管理服务实例
	 * 
	 * @param plugin - 插件实例，用于访问和保存设置
	 */
	constructor(private plugin: MusicPlayerPlugin) {}

	/**
	 * 检查歌曲是否已收藏
	 * 
	 * @param trackId - 曲目 ID
	 * @returns 如果已收藏返回 true，否则返回 false
	 */
	isFavorite(trackId: string): boolean {
		const favoriteIds = new Set(this.plugin.settings.favorites || []);
		return favoriteIds.has(trackId);
	}

	/**
	 * 切换收藏状态
	 * 
	 * 如果歌曲已收藏，则取消收藏；如果未收藏，则添加到收藏。
	 * 操作后会保存设置到持久化存储。
	 * 
	 * @param trackId - 曲目 ID
	 * @returns 返回新的收藏状态（true 表示已收藏，false 表示未收藏）
	 */
	async toggleFavorite(trackId: string): Promise<boolean> {
		const ids = new Set(this.plugin.settings.favorites || []);
		const wasFavorite = ids.has(trackId);

		// 切换收藏状态
		if (wasFavorite) {
			ids.delete(trackId);
		} else {
			ids.add(trackId);
		}

		this.plugin.settings.favorites = Array.from(ids);
		await this.plugin.saveSettings();
		return !wasFavorite; // 返回新的收藏状态
	}

	/**
	 * 获取所有收藏的曲目 ID
	 * 
	 * @returns 收藏的曲目 ID 数组
	 */
	getFavoriteIds(): string[] {
		return this.plugin.settings.favorites || [];
	}
}

