import { App, PluginSettingTab, Setting } from 'obsidian';
import { translate } from './i18n';
import type { PluginLanguage } from './i18n';
import type AudioTimestampPlayerPlugin from './main';
import type { MediaType } from './media-index';

export type NavigationBehavior = 'continue' | 'pause' | 'close';
export type VideoDisplayMode = 'compact' | 'expanded';

export interface AudioTimestampPlayerSettings {
	language: PluginLanguage;
	audioNavigationBehavior: NavigationBehavior;
	videoNavigationBehavior: NavigationBehavior;
	videoDisplayMode: VideoDisplayMode;
	videoPlayerWidth: number;
	videoPlayerHeight: number;
	videoResizeEnabled: boolean;
}

interface LegacySettings extends Partial<AudioTimestampPlayerSettings> {
	navigationBehavior?: NavigationBehavior;
}

export const DEFAULT_SETTINGS: AudioTimestampPlayerSettings = {
	language: 'auto',
	audioNavigationBehavior: 'continue',
	videoNavigationBehavior: 'continue',
	videoDisplayMode: 'expanded',
	videoPlayerWidth: 480,
	videoPlayerHeight: 320,
	videoResizeEnabled: true,
};

export function normalizeSettings(data: unknown): AudioTimestampPlayerSettings {
	const saved = (data ?? {}) as LegacySettings;
	const legacyNavigation = normalizeNavigationBehavior(saved.navigationBehavior, 'continue');
	return {
		language: normalizeLanguage(saved.language),
		audioNavigationBehavior:
			normalizeNavigationBehavior(saved.audioNavigationBehavior, legacyNavigation),
		videoNavigationBehavior:
			normalizeNavigationBehavior(saved.videoNavigationBehavior, 'continue'),
		videoDisplayMode:
			saved.videoDisplayMode === 'compact' ? 'compact' : 'expanded',
		videoPlayerWidth: normalizeDimension(saved.videoPlayerWidth, 320, 1200, 480),
		videoPlayerHeight: normalizeDimension(saved.videoPlayerHeight, 192, 800, 320),
		videoResizeEnabled: saved.videoResizeEnabled !== false,
	};
}

function normalizeLanguage(value: PluginLanguage | undefined): PluginLanguage {
	return value === 'zh-CN' || value === 'en' ? value : 'auto';
}

function normalizeNavigationBehavior(
	value: NavigationBehavior | undefined,
	fallback: NavigationBehavior,
): NavigationBehavior {
	return value === 'pause' || value === 'close' || value === 'continue'
		? value
		: fallback;
}

function normalizeDimension(
	value: number | undefined,
	minimum: number,
	maximum: number,
	fallback: number,
): number {
	return Number.isFinite(value)
		? Math.min(maximum, Math.max(minimum, Math.round(value ?? fallback)))
		: fallback;
}

export function getNavigationBehavior(
	settings: AudioTimestampPlayerSettings,
	mediaType: MediaType,
): NavigationBehavior {
	return mediaType === 'audio'
		? settings.audioNavigationBehavior
		: settings.videoNavigationBehavior;
}

export class AudioTimestampPlayerSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: AudioTimestampPlayerPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		this.containerEl.empty();
		const t = this.plugin.t.bind(this.plugin);

		new Setting(this.containerEl).setName(t('language')).setHeading();
		new Setting(this.containerEl)
			.setName(t('language'))
			.setDesc(t('languageDescription'))
			.addDropdown((dropdown) => {
				dropdown
					.addOption('auto', t('followObsidian'))
					.addOption('zh-CN', t('simplifiedChinese'))
					.addOption('en', t('english'))
					.setValue(this.plugin.settings.language)
					.onChange(async (value) => {
						this.plugin.settings.language = value as PluginLanguage;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		this.addMediaSettings('audio');
		this.addMediaSettings('video');

		new Setting(this.containerEl)
			.setName(t('videoDisplay'))
			.setDesc(t('videoDisplayDescription'))
			.addDropdown((dropdown) => {
				dropdown
					.addOption('compact', t('compactControls'))
					.addOption('expanded', t('showVideo'))
					.setValue(this.plugin.settings.videoDisplayMode)
					.onChange(async (value) => {
						this.plugin.settings.videoDisplayMode = value as VideoDisplayMode;
						await this.plugin.saveSettings();
					});
			});

		new Setting(this.containerEl)
			.setName(t('videoSize'))
			.setDesc(t('videoSizeDescription'))
			.addButton((button) => {
				button.setButtonText(t('resetVideoSize')).onClick(async () => {
					this.plugin.settings.videoPlayerWidth = DEFAULT_SETTINGS.videoPlayerWidth;
					this.plugin.settings.videoPlayerHeight = DEFAULT_SETTINGS.videoPlayerHeight;
					await this.plugin.saveSettings();
				});
			});

		new Setting(this.containerEl)
			.setName(t('enableVideoResize'))
			.setDesc(t('enableVideoResizeDescription'))
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.videoResizeEnabled)
					.onChange(async (value) => {
						this.plugin.settings.videoResizeEnabled = value;
						await this.plugin.saveSettings();
					});
			});
	}

	private addMediaSettings(mediaType: MediaType): void {
		const t = this.plugin.t.bind(this.plugin);
		const mediaName = t(mediaType);
		const settingKey = mediaType === 'audio'
			? 'audioNavigationBehavior'
			: 'videoNavigationBehavior';

		new Setting(this.containerEl).setName(mediaName).setHeading();
		new Setting(this.containerEl)
			.setName(t('whenSwitchingPages'))
			.setDesc(translate(this.plugin.settings.language, 'navigationDescription', {
				media: mediaName,
			}))
			.addDropdown((dropdown) => {
				dropdown
					.addOption('continue', t('continuePlayback'))
					.addOption('pause', t('pausePlayback'))
					.addOption('close', t('closePlayer'))
					.setValue(this.plugin.settings[settingKey])
					.onChange(async (value) => {
						this.plugin.settings[settingKey] = value as NavigationBehavior;
						await this.plugin.saveSettings();
					});
			});
	}
}
