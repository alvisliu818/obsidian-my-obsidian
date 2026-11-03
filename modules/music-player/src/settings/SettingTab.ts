/**
 * 设置页面
 * 使用 Obsidian 声明式设置 API（getSettingDefinitions / SettingDefinitionItem）。
 */
import { App, PluginSettingTab, SettingDefinitionItem, TFile } from 'obsidian';
import type MusicPlayerPlugin from '../main';
import { t } from '../utils/i18n/i18n';

/**
 * 受支持的音频文件扩展名，用于自动播放曲目的文件选择器过滤。
 */
const AUDIO_EXTENSIONS = ['mp3', 'flac', 'wav', 'm4a', 'ogg', 'aac', 'wma', 'opus'];

/**
 * 音乐播放器设置标签页
 * 通过 getSettingDefinitions 声明式定义设置项，
 * Obsidian 会自动根据 plugin.settings 渲染并持久化。
 */
export class MusicPlayerSettingTab extends PluginSettingTab {
	plugin: MusicPlayerPlugin;

	constructor(app: App, plugin: MusicPlayerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: t('settings.musicFolder.name'),
				desc: t('settings.musicFolder.desc'),
				control: {
					key: 'musicFolder',
					type: 'folder',
					placeholder: t('settings.musicFolder.placeholder'),
				},
			},
			{
				name: t('settings.autoPlay.name'),
				desc: t('settings.autoPlay.desc'),
				control: {
					key: 'autoPlayOnOpen',
					type: 'toggle',
				},
			},
			{
				name: t('settings.autoPlayTrack.name'),
				desc: t('settings.autoPlayTrack.desc'),
				// 仅在开启“打开时自动播放”时显示
				visible: () => this.plugin.settings.autoPlayOnOpen ?? false,
				control: {
					key: 'autoPlayOpenTrackPath',
					type: 'file',
					placeholder: t('settings.autoPlayTrack.placeholder'),
					filter: (file: TFile) =>
						AUDIO_EXTENSIONS.includes(file.extension.toLowerCase()),
				},
			},
		];
	}
}
