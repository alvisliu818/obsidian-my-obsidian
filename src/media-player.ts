import { App, Notice, setIcon, TFile } from 'obsidian';
import type { MessageKey } from './i18n';
import {
	resolveMediaBindings,
	selectMediaBinding,
} from './media-index';
import type { MediaBinding, MediaType } from './media-index';
import { getNavigationAction } from './navigation';
import { getNavigationBehavior } from './settings';
import type { AudioTimestampPlayerSettings } from './settings';

interface PlaybackContext {
	sourceNotePath: string;
	sourceNoteName: string;
	mediaPath: string;
	mediaFileName: string;
	mediaId: string | null;
	mediaType: MediaType;
	ownerDocument: Document;
}

interface CachedMediaIndex {
	mtime: number;
	bindings: MediaBinding[];
}

type Translate = (
	key: MessageKey,
	parameters?: Record<string, string>,
) => string;

type SaveVideoSize = (width: number, height: number) => Promise<void>;

export class MediaPlayerManager {
	private containerEl: HTMLDivElement | null = null;
	private mediaEl: HTMLAudioElement | HTMLVideoElement | null = null;
	private labelEl: HTMLDivElement | null = null;
	private closeButtonEl: HTMLButtonElement | null = null;
	private resizeHandleEl: HTMLElement | null = null;
	private context: PlaybackContext | null = null;
	private readonly mediaIndexCache = new Map<string, CachedMediaIndex>();

	constructor(
		private readonly app: App,
		private readonly getSettings: () => AudioTimestampPlayerSettings,
		private readonly t: Translate,
		private readonly saveVideoSize: SaveVideoSize,
	) {}

	async play(
		note: TFile,
		seconds: number,
		mediaType: MediaType,
		mediaId: string | null,
		view: HTMLElement,
	): Promise<void> {
		const selection = selectMediaBinding(
			await this.getMediaBindings(note, mediaType),
			mediaId,
		);
		if (!selection.binding) {
			this.showSelectionError(selection.error, mediaType, mediaId);
			return;
		}

		const binding = selection.binding;
		const ownerDocument = view.ownerDocument;
		const player = this.ensurePlayer(ownerDocument, mediaType, view);
		this.pauseNativePlayers(view, player);

		if (this.context?.mediaPath !== binding.file.path) {
			player.pause();
			player.src = this.app.vault.getResourcePath(binding.file);
			player.load();
		}

		this.context = {
			sourceNotePath: note.path,
			sourceNoteName: note.basename,
			mediaPath: binding.file.path,
			mediaFileName: binding.file.name,
			mediaId: binding.id,
			mediaType,
			ownerDocument,
		};
		this.refreshPresentation();

		await this.waitForMetadata(player, mediaType);
		if (player.readyState < HTMLMediaElement.HAVE_METADATA) return;

		player.currentTime = Math.min(
			seconds,
			Number.isFinite(player.duration) ? player.duration : seconds,
		);
		try {
			await player.play();
		} catch {
			new Notice(this.t('playbackBlocked'));
		}
	}

	handleNavigation(activeFile: TFile | null): void {
		if (!this.context) return;
		const behavior = getNavigationBehavior(
			this.getSettings(),
			this.context.mediaType,
		);
		const action = getNavigationAction(
			behavior,
			activeFile?.path === this.context.sourceNotePath,
		);
		if (action === 'pause') this.mediaEl?.pause();
		if (action === 'close') this.close();
		else this.attachToMainActiveLeaf(this.context.ownerDocument);
	}

	refreshPresentation(): void {
		const context = this.context;
		const container = this.containerEl;
		if (!context || !container) return;

		const mediaName = this.t(context.mediaType);
		container.setAttribute(
			'aria-label',
			this.t('mediaTimestampPlayer', { media: mediaName }),
		);
		container.toggleClass('is-video', context.mediaType === 'video');
		container.toggleClass(
			'is-video-expanded',
			context.mediaType === 'video' &&
				this.getSettings().videoDisplayMode === 'expanded',
		);
		if (
			context.mediaType === 'video' &&
			this.getSettings().videoDisplayMode === 'expanded'
		) {
			container.style.width = `${this.getSettings().videoPlayerWidth}px`;
			container.style.height = `${this.getSettings().videoPlayerHeight}px`;
		} else {
			container.style.removeProperty('width');
			container.style.removeProperty('height');
		}
		this.closeButtonEl?.setAttribute(
			'aria-label',
			this.t('closeMediaPlayer', { media: mediaName }),
		);
		this.resizeHandleEl?.setAttribute('aria-label', this.t('resizeVideoPlayer'));
		this.resizeHandleEl?.toggleClass(
			'is-hidden',
			context.mediaType !== 'video' ||
				this.getSettings().videoDisplayMode !== 'expanded' ||
				!this.getSettings().videoResizeEnabled,
		);

		if (!this.labelEl) return;
		this.labelEl.empty();
		this.labelEl.createDiv({
			cls: 'audio-timestamp-persistent-alias',
			text: context.mediaId ?? mediaName,
		});
		this.labelEl.createDiv({
			cls: 'audio-timestamp-persistent-source',
			text: `${context.mediaFileName} · ${context.sourceNoteName}`,
		});
	}

	invalidateMediaIndex(path?: string): void {
		if (!path) {
			this.mediaIndexCache.clear();
			return;
		}
		for (const mediaType of ['audio', 'video'] as const) {
			this.mediaIndexCache.delete(this.cacheKey(path, mediaType));
		}
	}

	close(): void {
		if (this.mediaEl) {
			this.mediaEl.pause();
			this.mediaEl.removeAttribute('src');
			this.mediaEl.load();
		}
		this.containerEl?.remove();
		this.containerEl = null;
		this.mediaEl = null;
		this.labelEl = null;
		this.closeButtonEl = null;
		this.resizeHandleEl = null;
		this.context = null;
	}

	destroy(): void {
		this.close();
		this.mediaIndexCache.clear();
	}

	private ensurePlayer(
		ownerDocument: Document,
		mediaType: MediaType,
		view: HTMLElement,
	): HTMLAudioElement | HTMLVideoElement {
		if (
			this.mediaEl?.isConnected &&
			this.context?.mediaType === mediaType &&
			this.containerEl?.ownerDocument === ownerDocument
		) {
			this.attachToSourceLeaf(view);
			return this.mediaEl;
		}

		this.close();
		const host = this.findSourceLeaf(view) ?? this.findMainActiveLeaf(ownerDocument)
			?? ownerDocument.querySelector<HTMLElement>('.workspace')
			?? ownerDocument.body;
		const container = host.createDiv({ cls: 'audio-timestamp-persistent-player' });
		container.setAttribute('role', 'region');

		this.labelEl = container.createDiv({ cls: 'audio-timestamp-persistent-label' });
		const media = container.createEl(mediaType, {
			cls: `audio-timestamp-persistent-media audio-timestamp-persistent-${mediaType}`,
		});
		media.controls = true;
		media.preload = 'metadata';
		if (mediaType === 'video') (media as HTMLVideoElement).playsInline = true;

		const closeButton = container.createEl('button', {
			cls: 'audio-timestamp-close-button clickable-icon',
			attr: { type: 'button' },
		});
		setIcon(closeButton, 'x');
		closeButton.addEventListener('click', () => this.close());

		const resizeHandle = container.createDiv({
			cls: 'audio-timestamp-video-resize-handle is-hidden',
			attr: {
				role: 'separator',
				tabindex: '0',
				'aria-orientation': 'horizontal',
			},
		});
		this.registerResizeHandle(resizeHandle, container, host);

		this.containerEl = container;
		this.mediaEl = media;
		this.closeButtonEl = closeButton;
		this.resizeHandleEl = resizeHandle;
		return media;
	}

	private registerResizeHandle(
		handle: HTMLElement,
		container: HTMLElement,
		host: HTMLElement,
	): void {
		handle.addEventListener('pointerdown', (event) => {
			if (!this.getSettings().videoResizeEnabled) return;
			event.preventDefault();
			event.stopPropagation();
			const initialBounds = container.getBoundingClientRect();
			const video = this.mediaEl?.tagName === 'VIDEO'
				? this.mediaEl as HTMLVideoElement
				: null;
			const videoBounds = video?.getBoundingClientRect();
			const aspectRatio = video?.videoWidth && video.videoHeight
				? video.videoWidth / video.videoHeight
				: 16 / 9;
			const horizontalChrome = Math.max(
				0,
				initialBounds.width - (videoBounds?.width ?? initialBounds.width),
			);
			const verticalChrome = Math.max(
				0,
				initialBounds.height - (videoBounds?.height ?? initialBounds.height),
			);
			const hostBounds = host.getBoundingClientRect();
			const startX = event.clientX;
			const startY = event.clientY;
			handle.setPointerCapture(event.pointerId);

			const move = (moveEvent: PointerEvent): void => {
				const maximumWidthFromHost = Math.max(320, hostBounds.width - 48);
				const maximumHeight = Math.max(
					192,
					hostBounds.bottom - initialBounds.top - 24,
				);
				const maximumWidthFromHeight = horizontalChrome + Math.max(
					0,
					maximumHeight - verticalChrome,
				) * aspectRatio;
				const maximumWidth = Math.min(maximumWidthFromHost, maximumWidthFromHeight);
				const horizontalDelta = moveEvent.clientX - startX;
				const verticalDeltaAsWidth = (moveEvent.clientY - startY) * aspectRatio;
				const sizeDelta = Math.abs(horizontalDelta) >= Math.abs(verticalDeltaAsWidth)
					? horizontalDelta
					: verticalDeltaAsWidth;
				const width = Math.min(
					maximumWidth,
					Math.max(320, initialBounds.width + sizeDelta),
				);
				const videoWidth = Math.max(0, width - horizontalChrome);
				const height = verticalChrome + videoWidth / aspectRatio;
				container.style.width = `${Math.round(width)}px`;
				container.style.height = `${Math.round(height)}px`;
			};

			const finish = (upEvent: PointerEvent): void => {
				handle.removeEventListener('pointermove', move);
				handle.removeEventListener('pointerup', finish);
				handle.removeEventListener('pointercancel', finish);
				if (handle.hasPointerCapture(upEvent.pointerId)) {
					handle.releasePointerCapture(upEvent.pointerId);
				}
				const bounds = container.getBoundingClientRect();
				void this.saveVideoSize(Math.round(bounds.width), Math.round(bounds.height));
			};

			handle.addEventListener('pointermove', move);
			handle.addEventListener('pointerup', finish);
			handle.addEventListener('pointercancel', finish);
		});
	}

	private attachToSourceLeaf(view: HTMLElement): void {
		const leaf = this.findSourceLeaf(view);
		const container = this.containerEl;
		if (leaf && container && container.parentElement !== leaf) {
			leaf.appendChild(container);
		}
	}

	private attachToMainActiveLeaf(ownerDocument: Document): void {
		const leaf = this.findMainActiveLeaf(ownerDocument);
		const container = this.containerEl;
		if (leaf && container && container.parentElement !== leaf) {
			leaf.appendChild(container);
		}
	}

	private findSourceLeaf(view: HTMLElement): HTMLElement | null {
		const leaf = view.closest<HTMLElement>('.workspace-leaf');
		return leaf?.closest('.workspace-split.mod-root') ? leaf : null;
	}

	private findMainActiveLeaf(ownerDocument: Document): HTMLElement | null {
		return ownerDocument.querySelector<HTMLElement>(
			'.workspace-split.mod-root .workspace-leaf.mod-active',
		);
	}

	private async getMediaBindings(
		note: TFile,
		mediaType: MediaType,
	): Promise<MediaBinding[]> {
		const key = this.cacheKey(note.path, mediaType);
		const cached = this.mediaIndexCache.get(key);
		if (cached?.mtime === note.stat.mtime) return cached.bindings;

		const content = await this.app.vault.cachedRead(note);
		const bindings = await resolveMediaBindings(this.app, note, content, mediaType);
		this.mediaIndexCache.set(key, { mtime: note.stat.mtime, bindings });
		return bindings;
	}

	private cacheKey(notePath: string, mediaType: MediaType): string {
		return `${mediaType}:${notePath}`;
	}

	private showSelectionError(
		error: string,
		mediaType: MediaType,
		mediaId: string | null,
	): void {
		const mediaName = this.t(mediaType);
		const parameters = { media: mediaName, id: mediaId ?? '' };
		const keys: Record<string, MessageKey> = {
			none: 'noEmbeddedMedia',
			ambiguous: 'ambiguousMedia',
			duplicate: 'duplicateAlias',
			unknown: 'unknownAlias',
		};
		new Notice(this.t(keys[error] ?? 'selectionFailed', parameters));
	}

	private pauseNativePlayers(
		view: HTMLElement,
		persistentPlayer: HTMLMediaElement,
	): void {
		for (const player of Array.from(
			view.querySelectorAll<HTMLMediaElement>('audio, video'),
		)) {
			if (player !== persistentPlayer) player.pause();
		}
	}

	private async waitForMetadata(
		player: HTMLMediaElement,
		mediaType: MediaType,
	): Promise<void> {
		if (player.readyState >= HTMLMediaElement.HAVE_METADATA) return;

		await new Promise<void>((resolve, reject) => {
			player.addEventListener('loadedmetadata', () => resolve(), { once: true });
			player.addEventListener(
				'error',
				() => reject(new Error('Media metadata failed to load.')),
				{ once: true },
			);
		}).catch(() => {
			new Notice(this.t('mediaLoadFailed', { media: this.t(mediaType) }));
		});
	}
}
