import { App, Notice, TFile } from 'obsidian';

const AUDIO_EMBED_PATTERN = /!\[\[([^\]|#]+\.(?:mp3|wav|m4a|ogg|flac))(?:[^\]]*)\]\]/i;

export class AudioPlayerManager {
	private containerEl: HTMLDivElement | null = null;
	private audioEl: HTMLAudioElement | null = null;
	private currentAudioPath: string | null = null;

	constructor(private readonly app: App) {}

	async play(note: TFile, seconds: number, view: HTMLElement): Promise<void> {
		const audioFile = await this.findAudioFile(note);
		if (!audioFile) {
			new Notice('No embedded audio file was found in the current note.');
			return;
		}

		const player = this.ensurePlayer();
		this.pauseNativePlayers(view, player);

		if (this.currentAudioPath !== audioFile.path) {
			this.currentAudioPath = audioFile.path;
			player.src = this.app.vault.getResourcePath(audioFile);
			player.load();
		}

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

	destroy(): void {
		this.audioEl?.pause();
		this.containerEl?.remove();
		this.audioEl = null;
		this.containerEl = null;
		this.currentAudioPath = null;
	}

	private ensurePlayer(): HTMLAudioElement {
		if (this.audioEl?.isConnected) return this.audioEl;

		const workspace = activeDocument.querySelector<HTMLElement>('.workspace');
		const container = activeDocument.createDiv({ cls: 'audio-timestamp-persistent-player' });
		container.setAttribute('role', 'region');
		container.setAttribute('aria-label', 'Audio timestamp player');

		const label = activeDocument.createDiv({
			cls: 'audio-timestamp-persistent-label',
			text: 'Audio',
		});

		const audio = activeDocument.createEl('audio', {
			cls: 'audio-timestamp-persistent-audio',
		});
		audio.controls = true;
		audio.preload = 'metadata';

		container.append(label, audio);
		(workspace ?? activeDocument.body).append(container);
		this.containerEl = container;
		this.audioEl = audio;
		return audio;
	}

	private async findAudioFile(note: TFile): Promise<TFile | null> {
		const content = await this.app.vault.cachedRead(note);
		const match = AUDIO_EMBED_PATTERN.exec(content);
		const audioLink = match?.[1];
		if (!audioLink) return null;
		return this.app.metadataCache.getFirstLinkpathDest(audioLink, note.path);
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
