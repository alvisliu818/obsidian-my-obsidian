import { App, Notice, setIcon, TFile } from 'obsidian';
import { resolveAudioBindings, selectAudioBinding } from './audio-index';
import type { AudioBinding } from './audio-index';
import { getNavigationAction } from './navigation';
import type { AudioTimestampPlayerSettings } from './settings';

interface PlaybackContext {
	sourceNotePath: string;
	audioPath: string;
	audioId: string | null;
	ownerDocument: Document;
}

interface CachedAudioIndex {
	mtime: number;
	bindings: AudioBinding[];
}

export class AudioPlayerManager {
	private containerEl: HTMLDivElement | null = null;
	private audioEl: HTMLAudioElement | null = null;
	private labelEl: HTMLDivElement | null = null;
	private context: PlaybackContext | null = null;
	private readonly audioIndexCache = new Map<string, CachedAudioIndex>();

	constructor(
		private readonly app: App,
		private readonly getSettings: () => AudioTimestampPlayerSettings,
	) {}

	async play(
		note: TFile,
		seconds: number,
		audioId: string | null,
		view: HTMLElement,
	): Promise<void> {
		const selection = selectAudioBinding(await this.getAudioBindings(note), audioId);
		if (!selection.binding) {
			this.showSelectionError(selection.error, audioId);
			return;
		}

		const binding = selection.binding;
		const ownerDocument = view.ownerDocument;
		const player = this.ensurePlayer(ownerDocument);
		this.pauseNativePlayers(view, player);

		if (this.context?.audioPath !== binding.file.path) {
			player.pause();
			player.src = this.app.vault.getResourcePath(binding.file);
			player.load();
		}

		this.context = {
			sourceNotePath: note.path,
			audioPath: binding.file.path,
			audioId: binding.id,
			ownerDocument,
		};
		this.updateLabel(note, binding);

		await this.waitForMetadata(player);
		if (player.readyState < HTMLMediaElement.HAVE_METADATA) return;

		player.currentTime = Math.min(
			seconds,
			Number.isFinite(player.duration) ? player.duration : seconds,
		);
		try {
			await player.play();
		} catch {
			new Notice('Playback was blocked. Select the timestamp again.');
		}
	}

	handleNavigation(activeFile: TFile | null): void {
		if (!this.context) return;
		const action = getNavigationAction(
			this.getSettings().navigationBehavior,
			activeFile?.path === this.context.sourceNotePath,
		);
		if (action === 'pause') this.audioEl?.pause();
		if (action === 'close') this.close();
		else this.attachToActiveLeaf(this.context.ownerDocument);
	}

	invalidateAudioIndex(path?: string): void {
		if (path) this.audioIndexCache.delete(path);
		else this.audioIndexCache.clear();
	}

	close(): void {
		if (this.audioEl) {
			this.audioEl.pause();
			this.audioEl.removeAttribute('src');
			this.audioEl.load();
		}
		this.containerEl?.remove();
		this.containerEl = null;
		this.audioEl = null;
		this.labelEl = null;
		this.context = null;
	}

	destroy(): void {
		this.close();
		this.audioIndexCache.clear();
	}

	private ensurePlayer(ownerDocument: Document): HTMLAudioElement {
		if (
			this.audioEl?.isConnected &&
			this.containerEl?.ownerDocument === ownerDocument
		) {
			return this.audioEl;
		}

		this.close();
		const activeLeaf = ownerDocument.querySelector<HTMLElement>(
			'.workspace-leaf.mod-active',
		);
		const workspace = ownerDocument.querySelector<HTMLElement>('.workspace');
		const host = activeLeaf ?? workspace ?? ownerDocument.body;
		const container = host.createDiv({ cls: 'audio-timestamp-persistent-player' });
		container.setAttribute('role', 'region');
		container.setAttribute('aria-label', 'Audio timestamp player');

		this.labelEl = container.createDiv({ cls: 'audio-timestamp-persistent-label' });
		const audio = container.createEl('audio', {
			cls: 'audio-timestamp-persistent-audio',
		});
		audio.controls = true;
		audio.preload = 'metadata';

		const closeButton = container.createEl('button', {
			cls: 'audio-timestamp-close-button clickable-icon',
			attr: {
				'aria-label': 'Close audio player',
				type: 'button',
			},
		});
		setIcon(closeButton, 'x');
		closeButton.addEventListener('click', () => this.close());

		this.containerEl = container;
		this.audioEl = audio;
		return audio;
	}

	private attachToActiveLeaf(ownerDocument: Document): void {
		const activeLeaf = ownerDocument.querySelector<HTMLElement>(
			'.workspace-leaf.mod-active',
		);
		const container = this.containerEl;
		if (activeLeaf && container && container.parentElement !== activeLeaf) {
			activeLeaf.appendChild(container);
		}
	}

	private async getAudioBindings(note: TFile): Promise<AudioBinding[]> {
		const cached = this.audioIndexCache.get(note.path);
		if (cached?.mtime === note.stat.mtime) return cached.bindings;

		const content = await this.app.vault.cachedRead(note);
		const bindings = await resolveAudioBindings(this.app, note, content);
		this.audioIndexCache.set(note.path, { mtime: note.stat.mtime, bindings });
		return bindings;
	}

	private updateLabel(note: TFile, binding: AudioBinding): void {
		if (!this.labelEl) return;
		this.labelEl.empty();
		this.labelEl.createDiv({
			cls: 'audio-timestamp-persistent-alias',
			text: binding.id ?? 'Audio',
		});
		this.labelEl.createDiv({
			cls: 'audio-timestamp-persistent-source',
			text: `${binding.file.name} · ${note.basename}`,
		});
	}

	private showSelectionError(error: string, audioId: string | null): void {
		const messages: Record<string, string> = {
			none: 'No embedded audio file was found in the current note.',
			ambiguous: 'Multiple recordings were found. Add an audio alias to this timestamp.',
			duplicate: `The audio alias "${audioId ?? ''}" is declared more than once.`,
			unknown: `The audio alias "${audioId ?? ''}" was not found in this note.`,
		};
		new Notice(messages[error] ?? 'The recording could not be selected.');
	}

	private pauseNativePlayers(view: HTMLElement, persistentPlayer: HTMLAudioElement): void {
		for (const player of Array.from(view.querySelectorAll<HTMLAudioElement>('audio'))) {
			if (player !== persistentPlayer) player.pause();
		}
	}

	private async waitForMetadata(player: HTMLAudioElement): Promise<void> {
		if (player.readyState >= HTMLMediaElement.HAVE_METADATA) return;

		await new Promise<void>((resolve, reject) => {
			player.addEventListener('loadedmetadata', () => resolve(), { once: true });
			player.addEventListener(
				'error',
				() => reject(new Error('Audio metadata failed to load.')),
				{ once: true },
			);
		}).catch(() => {
			new Notice('The audio file could not be loaded.');
		});
	}
}
