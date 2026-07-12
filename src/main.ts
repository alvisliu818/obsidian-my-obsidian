import { Plugin, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian';
import { createEditorTimestampExtension } from './editor-extension';
import type { MessageKey } from './i18n';
import { translate } from './i18n';
import { MediaPlayerManager } from './media-player';
import {
	AudioTimestampPlayerSettings,
	AudioTimestampPlayerSettingTab,
	DEFAULT_SETTINGS,
	normalizeSettings,
} from './settings';
import { TimestampController } from './timestamp-controller';

export default class AudioTimestampPlayerPlugin extends Plugin {
	settings: AudioTimestampPlayerSettings = DEFAULT_SETTINGS;
	private playerManager: MediaPlayerManager | null = null;

	async onload(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());

		this.playerManager = new MediaPlayerManager(
			this.app,
			() => this.settings,
			(key, parameters) => this.t(key, parameters),
			(width, height) => this.saveVideoPlayerSize(width, height),
		);
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
				if (!this.isMainWorkspaceLeaf(leaf)) return;
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
				this.playerManager?.invalidateMediaIndex(oldPath);
				this.invalidateNote(file);
			}),
		);
	}

	t(key: MessageKey, parameters?: Record<string, string>): string {
		return translate(this.settings.language, key, parameters);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.playerManager?.refreshPresentation();
	}

	private async saveVideoPlayerSize(width: number, height: number): Promise<void> {
		this.settings.videoPlayerWidth = width;
		this.settings.videoPlayerHeight = height;
		await this.saveData(this.settings);
	}

	onunload(): void {
		this.playerManager?.destroy();
		this.playerManager = null;
	}

	private invalidateNote(file: TAbstractFile): void {
		if (file instanceof TFile && file.extension === 'md') {
			this.playerManager?.invalidateMediaIndex(file.path);
		}
	}

	private getLeafFile(leaf: WorkspaceLeaf | null): TFile | null {
		const file = (leaf?.view as { file?: unknown } | undefined)?.file;
		return file instanceof TFile ? file : null;
	}

	private isMainWorkspaceLeaf(leaf: WorkspaceLeaf | null): boolean {
		return Boolean(leaf?.view.containerEl.closest('.workspace-split.mod-root'));
	}
}
