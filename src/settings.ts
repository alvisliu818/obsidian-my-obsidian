import { App, PluginSettingTab, Setting } from 'obsidian';
import type AudioTimestampPlayerPlugin from './main';

export type NavigationBehavior = 'continue' | 'pause' | 'close';

export interface AudioTimestampPlayerSettings {
	navigationBehavior: NavigationBehavior;
}

export const DEFAULT_SETTINGS: AudioTimestampPlayerSettings = {
	navigationBehavior: 'continue',
};

export class AudioTimestampPlayerSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: AudioTimestampPlayerPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		this.containerEl.empty();

		new Setting(this.containerEl)
			.setName('When switching pages')
			.setDesc('Choose what happens to the floating player after opening another note, file, or tab.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('continue', 'Continue playback')
					.addOption('pause', 'Pause playback')
					.addOption('close', 'Close player')
					.setValue(this.plugin.settings.navigationBehavior)
					.onChange(async (value) => {
						this.plugin.settings.navigationBehavior = value as NavigationBehavior;
						await this.plugin.saveSettings();
					});
			});
	}
}
