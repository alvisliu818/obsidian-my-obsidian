/**
 * 音乐播放器插件主入口文件
 * 
 * 本文件定义了插件的核心类、设置接口和配置项，负责：
 * - 插件生命周期管理（加载、卸载）
 * - 设置数据的加载和保存
 * - 视图的注册和激活
 * - 命令和快捷键的注册
 */

// 为移动端提供 Buffer polyfill（必须在其他导入之前）
// music-metadata-browser 库内部使用了 Buffer，需要在全局作用域中提供
import { initBufferPolyfill } from "./utils/polyfills/buffer";
initBufferPolyfill();

import { Platform, Plugin } from 'obsidian';
import { MusicPlayerView, VIEW_TYPE_MUSIC_PLAYER } from './views/MusicPlayerView';
import { generateArtistsAndAlbums } from './utils/data/transform';
import { getTrackPath } from './utils/track/id';
import { MusicPlayerSettingTab } from './settings/SettingTab';
import type { MusicPlayerSettings } from './types';
import { DEFAULT_SETTINGS } from './types';
import { t } from './utils/i18n/i18n';

/**
 * 播放模式类型
 * - normal: 顺序播放，播放完列表后停止
 * - repeat-all: 列表循环，播放完列表后从头开始
 * - repeat-one: 单曲循环，重复播放当前歌曲
 * - shuffle: 随机播放
 */
export type PlayMode = 'normal' | 'repeat-all' | 'repeat-one' | 'shuffle';

/**
 * 音乐播放器插件主类
 * 继承自 Obsidian 的 Plugin 类，负责插件的生命周期管理
 */
export default class MusicPlayerPlugin extends Plugin {
	/** 插件设置对象，存储所有配置和用户数据 */
	declare settings: MusicPlayerSettings;

	/**
	 * 插件加载时的初始化方法
	 * 在 Obsidian 加载插件时自动调用
	 */
	async onload() {
		// 加载保存的设置数据
		await this.loadSettings();

		// 注册音乐播放器视图（侧边栏视图）
		this.registerView(
			VIEW_TYPE_MUSIC_PLAYER,
			(leaf) => new MusicPlayerView(leaf, this)
		);

		// 添加侧边栏图标（仅在桌面端可用，移动端不支持）
		if (!Platform.isMobile) {
			this.addRibbonIcon('lucide-music', t('ribbon.musicPlayer'), () => {
				// 点击图标后：在右侧栏打开播放器
				void this.activateView();
			});
		}

		// 添加快捷命令：打开音乐播放器
		this.addCommand({
			id: 'open-player',
			name: t('commands.openPlayer'),
			callback: () => {
				void this.activateView();
			}
		});

		// 添加快捷命令：打开设置页面
		this.addCommand({
			id: 'open-settings',
			name: t('commands.openSettings'),
			callback: () => {
				void this.openSettings();
			}
		});

		// 添加设置标签页（在 Obsidian 设置中显示）
		this.addSettingTab(new MusicPlayerSettingTab(this.app, this));
	}

	/**
	 * 插件卸载时的清理方法
	 * 在 Obsidian 卸载插件时自动调用
	 */
	onunload() {
		// 卸载时关闭所有已打开的视图，释放资源
		// Note: Don't detach leaves in onunload per Obsidian guidelines
	}

	/**
	 * 加载设置数据
	 * 从 Obsidian 的数据文件中读取保存的设置，如果不存在则使用默认值
	 * 同时处理旧版本设置的迁移和数据一致性检查
	 */
	async loadSettings() {
		// 从数据文件加载设置
		const loadedData = await this.loadData() as Partial<MusicPlayerSettings> | null;
		// 合并默认设置和已保存的设置
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);

		// 迁移：旧版 autoPlayOpenTrackId → autoPlayOpenTrackPath，并去掉已废弃字段
		const loadedWithLegacy = loadedData as { autoPlayOpenTrackId?: string } | null;
		let shouldPersistMigration = false;
		if (
			loadedWithLegacy?.autoPlayOpenTrackId?.trim() &&
			!(this.settings.autoPlayOpenTrackPath ?? "").trim()
		) {
			const p = getTrackPath(loadedWithLegacy.autoPlayOpenTrackId.trim(), this.settings);
			if (p) {
				this.settings.autoPlayOpenTrackPath = p;
				shouldPersistMigration = true;
			}
		}
		if (loadedWithLegacy && "autoPlayOpenTrackId" in loadedWithLegacy) {
			delete (this.settings as { autoPlayOpenTrackId?: string }).autoPlayOpenTrackId;
			shouldPersistMigration = true;
		}
		if (shouldPersistMigration) {
			await this.saveSettings();
		}
		
		// 确保 trackIndex 存在（新安装的用户）
		if (!this.settings.trackIndex) {
			this.settings.trackIndex = {};
		}
		
		// 确保艺术家和专辑数据与曲目数据保持一致
		// 如果 tracks 数据存在但 artists/albums 数据不一致，重新生成
		if (Object.keys(this.settings.tracks || {}).length > 0) {
			const { artists, albums } = generateArtistsAndAlbums(this.settings);
			this.settings.artists = artists;
			this.settings.albums = albums;

			// 只有在数据发生变化时才保存，避免不必要的写入操作
			const shouldSave = JSON.stringify(artists) !== JSON.stringify(loadedData?.artists) || 
						  JSON.stringify(albums) !== JSON.stringify(loadedData?.albums);

			if (shouldSave) {
				await this.saveSettings();
			}
		}
	}

	/**
	 * 保存设置数据
	 * 将当前设置写入 Obsidian 的数据文件
	 */
	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * 激活音乐播放器视图
	 * 在右侧边栏打开或显示音乐播放器视图
	 */
	async activateView() {
		const { workspace } = this.app;

		// 查找是否已有打开的播放器视图
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_MUSIC_PLAYER)[0];

		if (!leaf) {
			// 如果没有打开的视图，在右侧边栏创建新的视图
			// false 表示不分割窗口，直接使用右侧边栏
			const newLeaf = workspace.getRightLeaf(false);
			if (!newLeaf) {
				// 如果无法创建 leaf，直接返回
				return;
			}
			leaf = newLeaf;
			await leaf.setViewState({
				type: VIEW_TYPE_MUSIC_PLAYER,
				active: true,
			});
		}

		// 显示并聚焦到该视图
		if (leaf) {
			void workspace.revealLeaf(leaf);
		}
	}

	/**
	 * 打开设置页面
	 * 打开 Obsidian 内置设置页面并激活音乐播放器插件的设置标签页
	 */
	async openSettings() {
		const appWithSetting = this.app as unknown as {
			setting?: {
				open: () => void | Promise<void>;
				/** Obsidian 1.4+；类型未在官方 d.ts 中完整暴露 */
				openTabById?: (id: string) => void | Promise<void>;
			};
		};

		const setting = appWithSetting.setting;
		if (!setting) {
			return;
		}

		await setting.open();

		if (typeof setting.openTabById === "function") {
			await setting.openTabById(this.manifest.id);
		}
	}
}

