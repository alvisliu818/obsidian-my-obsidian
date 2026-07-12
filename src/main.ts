import { Plugin, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian';
import { AudioPlayerManager } from './audio-player';
import { createEditorTimestampExtension } from './editor-extension';
import {
	AudioTimestampPlayerSettings,
	AudioTimestampPlayerSettingTab,
	DEFAULT_SETTINGS,
} from './settings';
import { TimestampController } from './timestamp-controller';

export default class AudioTimestampPlayerPlugin extends Plugin {
	settings: AudioTimestampPlayerSettings = DEFAULT_SETTINGS;
	private playerManager: AudioPlayerManager | null = null;

	async onload(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<AudioTimestampPlayerSettings>,
		);

		this.playerManager = new AudioPlayerManager(this.app, () => this.settings);
		const controller = new TimestampController(this.app, this.playerManager);
		this.registerEditorExtension(createEditorTimestampExtension(controller));
		this.addSettingTab(new AudioTimestampPlayerSettingTab(this.app, this));

		this.registerDomEvent(
			activeDocument,
			'click',
			(event: MouseEvent) => {
				void controller.handleClick(event);
			},
			true,
		);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				this.playerManager?.handleNavigation(this.getLeafFile(leaf));
			}),
		);
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				this.playerManager?.handleNavigation(file);
			}),
		);
		this.registerEvent(this.app.vault.on('modify', (file) => this.invalidateNote(file)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.invalidateNote(file)));
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				this.playerManager?.invalidateAudioIndex(oldPath);
				this.invalidateNote(file);
			}),
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	onunload(): void {
		this.playerManager?.destroy();
		this.playerManager = null;
	}

	private invalidateNote(file: TAbstractFile): void {
		if (file instanceof TFile && file.extension === 'md') {
			this.playerManager?.invalidateAudioIndex(file.path);
		}
	}

	private getLeafFile(leaf: WorkspaceLeaf | null): TFile | null {
		const file = (leaf?.view as { file?: unknown } | undefined)?.file;
		return file instanceof TFile ? file : null;
	}
}
