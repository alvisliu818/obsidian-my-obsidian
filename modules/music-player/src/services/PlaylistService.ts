/**
 * 歌单管理服务
 * 
 * 负责管理歌单相关的业务逻辑，包括：
 * - 创建歌单
 * - 编辑歌单名称
 * - 删除歌单
 * - 添加歌曲到歌单
 * - 从歌单移除歌曲
 * 
 * 歌单数据存储在插件的设置中，通过 playlists 对象保存（歌单名称 -> 曲目 ID 数组）。
 */

import { App } from "obsidian";
import MusicPlayerPlugin from "@/main";
import { ConfirmModal, PlaylistPickerModal, TextInputModal } from "@/components";
import { t, tWithParams } from "@/utils/i18n/i18n";

/**
 * 歌单管理服务类
 * 
 * 提供歌单的增删改查操作，所有操作都会持久化到插件设置中。
 * 部分操作会显示模态框与用户交互。
 */
export class PlaylistService {
	/**
	 * 创建歌单管理服务实例
	 * 
	 * @param app - Obsidian App 实例，用于显示模态框
	 * @param plugin - 插件实例，用于访问和保存设置
	 */
	constructor(
		private app: App,
		private plugin: MusicPlayerPlugin
	) {}

	/**
	 * 获取歌单映射表
	 * 
	 * @returns 歌单映射对象（歌单名称 -> 曲目 ID 数组）
	 */
	getPlaylistMap(): Record<string, string[]> {
		return this.plugin.settings.playlists || {};
	}

	/**
	 * 创建新歌单
	 * 
	 * 显示输入对话框，让用户输入新歌单名称，然后创建空歌单。
	 * 如果歌单名称已存在，则不会创建。
	 * 
	 * @returns 新创建的歌单名称，如果用户取消或名称已存在则返回 null
	 */
	async createPlaylist(): Promise<string | null> {
		const modal = new TextInputModal(this.app, t("playlist.promptNewName"));
		const name = await modal.prompt();
		if (!name) return null;
		const trimmed = name.trim();
		if (!trimmed) return null;

		const playlistMap = this.getPlaylistMap();
		// 如果歌单不存在，创建新歌单
		if (!playlistMap[trimmed]) {
			playlistMap[trimmed] = [];
			this.plugin.settings.playlists = playlistMap;
			await this.plugin.saveSettings();
			return trimmed;
		}

		return null;
	}

	/**
	 * 编辑歌单名称
	 * 
	 * 显示输入对话框，让用户输入新名称，然后重命名歌单
	 */
	async editPlaylistName(oldName: string): Promise<boolean> {
		const playlistMap = this.getPlaylistMap();
		if (!playlistMap[oldName]) return false;

		const modal = new TextInputModal(this.app, t("playlist.renamePrompt"), oldName);
		const newName = await modal.prompt();
		if (!newName) return false;
		const trimmed = newName.trim();
		if (!trimmed || trimmed === oldName) return false;

		// 检查新名称是否已存在（如果存在，不执行重命名）
		if (playlistMap[trimmed]) {
			return false;
		}

		// 重命名歌单：保存歌曲列表，删除旧名称，创建新名称
		const tracks = playlistMap[oldName];
		if (tracks === undefined) {
			return false; // 歌单不存在
		}
		delete playlistMap[oldName];
		playlistMap[trimmed] = tracks;
		this.plugin.settings.playlists = playlistMap;
		await this.plugin.saveSettings();
		return true;
	}

	/**
	 * 删除歌单
	 * 
	 * 显示确认对话框，确认后从歌单映射表中删除指定名称的歌单
	 */
	async deletePlaylist(playlistName: string): Promise<boolean> {
		const playlistMap = this.getPlaylistMap();
		if (!playlistMap[playlistName]) return false;

		// 显示确认对话框
		const modal = new ConfirmModal(
			this.app,
			t("playlist.deleteTitle"),
			tWithParams("playlist.deleteMessage", { name: playlistName }),
			t("common.ok"),
			t("common.cancel")
		);
		const confirmed = await modal.prompt();
		
		// 如果用户取消，返回 false
		if (!confirmed) return false;

		// 用户确认，执行删除操作
		delete playlistMap[playlistName];
		this.plugin.settings.playlists = playlistMap;
		await this.plugin.saveSettings();
		return true;
	}

	/**
	 * 将歌曲添加到歌单
	 * 
	 * 显示歌单选择对话框，让用户选择目标歌单，然后将歌曲添加到该歌单
	 * 
	 * @param trackId - 曲目 ID
	 */
	async addToPlaylist(trackId: string): Promise<boolean> {
		const playlistMap = this.getPlaylistMap();
		const allNames = Object.keys(playlistMap);
		const modal = new PlaylistPickerModal(this.app, allNames);
		const name = await modal.prompt();
		if (!name) return false;
		const trimmed = name.trim();
		if (!trimmed) return false;

		// 如果歌单不存在，创建新歌单
		if (!playlistMap[trimmed]) {
			playlistMap[trimmed] = [];
		}

		// 如果歌曲不在歌单中，添加到歌单
		const playlist = playlistMap[trimmed];
		if (playlist && !playlist.includes(trackId)) {
			playlist.push(trackId);
			this.plugin.settings.playlists = playlistMap;
			await this.plugin.saveSettings();
			return true;
		}

		return false;
	}

	/**
	 * 从歌单中移除歌曲
	 * 
	 * 从指定歌单中移除指定 ID 的歌曲
	 * 如果歌单变为空，保留空歌单（不删除）
	 * 
	 * @param trackId - 曲目 ID
	 * @param playlistName - 歌单名称
	 */
	async removeFromPlaylist(trackId: string, playlistName: string): Promise<boolean> {
		const playlistMap = this.getPlaylistMap();
		const playlist = playlistMap[playlistName];
		if (!playlist) return false;

		const index = playlist.indexOf(trackId);
		if (index > -1) {
			playlist.splice(index, 1);
			// 如果歌单为空，可以选择删除歌单或保留空歌单
			// 这里选择保留空歌单
			this.plugin.settings.playlists = playlistMap;
			await this.plugin.saveSettings();
			return true;
		}

		return false;
	}
}

