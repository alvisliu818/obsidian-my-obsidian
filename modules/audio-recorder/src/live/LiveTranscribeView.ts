/**
 * The live-transcribe panel: start/stop, an independent screenshot button
 * (captures the configured window into the vault as its own line), the
 * rolling transcript cut per speech pause, and per-line markers — hovering a
 * line floats a small marker bar centered on the mouse, so any sentence can
 * be tagged, not just the newest. Chinese by construction — a merged-fork
 * feature, not upstream surface.
 * @module live/LiveTranscribeView
 */

import { ItemView, Notice, MarkdownView } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import {
	LIVE_MARKER_KINDS,
	type LiveSessionState,
	type LiveTranscribeController,
	type LiveTranscribeSink,
} from './LiveTranscribeController';

/** Leaf type this view registers under. */
export const LIVE_TRANSCRIBE_VIEW_TYPE = 'aar-live-transcribe-view';

const STATE_LABELS: Record<LiveSessionState, string> = {
	idle: '未开始',
	starting: '启动中…',
	listening: '聆听中',
	stopping: '停止中…',
};

/** What the view needs from the plugin beyond the controller. */
export interface LiveTranscribeViewUi {
	/** Opens the screenshot-window picker, persisting the choice. */
	openWindowPicker(onPicked?: (name: string) => void): void;
}

/** One transcript row in the DOM: its text node, for marker updates. */
interface LineRow {
	textEl: HTMLElement;
}

/**
 * The panel. One view at a time is enforced by the leaf the commands use;
 * the controller refuses concurrent sessions regardless.
 */
export class LiveTranscribeView extends ItemView implements LiveTranscribeSink {
	private readonly controller: LiveTranscribeController;
	private readonly ui: LiveTranscribeViewUi;
	private statusEl!: HTMLElement;
	private transcriptEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private startButton!: HTMLButtonElement;
	private stopButton!: HTMLButtonElement;
	private screenshotButton!: HTMLButtonElement;
	private lineRows: LineRow[] = [];
	private listening = false;
	// ---- 悬浮标记条（以鼠标为中心）----
	private markerPopup: HTMLDivElement | null = null;
	private popupLineIndex = -1;
	private popupHideTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		controller: LiveTranscribeController,
		ui: LiveTranscribeViewUi,
	) {
		super(leaf);
		this.controller = controller;
		this.ui = ui;
	}

	override getViewType(): string {
		return LIVE_TRANSCRIBE_VIEW_TYPE;
	}

	override getDisplayText(): string {
		return '实时转写';
	}

	override getIcon(): string {
		return 'audio-lines';
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.style.display = 'flex';
		root.style.flexDirection = 'column';
		root.style.gap = '8px';
		root.style.padding = '12px';

		const header = root.createDiv();
		header.style.display = 'flex';
		header.style.alignItems = 'center';
		header.style.gap = '8px';
		this.statusEl = header.createDiv();
		this.statusEl.style.flex = '1';
		this.statusEl.style.color = 'var(--text-muted)';
		this.statusEl.setText(STATE_LABELS.idle);
		this.startButton = header.createEl('button', { text: '开始聆听' });
		this.startButton.onclick = () => void this.controller.start();
		this.stopButton = header.createEl('button', { text: '停止' });
		this.stopButton.disabled = true;
		this.stopButton.onclick = () => void this.controller.stop();
		this.screenshotButton = header.createEl('button', { text: '截屏' });
		this.screenshotButton.disabled = true;
		this.screenshotButton.onclick = () => void this.controller.captureScreenshot();
		const pickWindow = header.createEl('button', { text: '选择窗口' });
		pickWindow.onclick = (): void => {
			this.ui.openWindowPicker();
		};

		this.transcriptEl = root.createDiv();
		this.transcriptEl.style.flex = '1';
		this.transcriptEl.style.overflowY = 'auto';
		this.transcriptEl.style.whiteSpace = 'pre-wrap';
		this.transcriptEl.style.fontFamily = 'var(--font-text)';
		this.transcriptEl.style.padding = '8px';
		this.transcriptEl.style.borderRadius = '8px';
		this.transcriptEl.style.background = 'var(--background-secondary)';
		this.transcriptEl.setText('（对着麦克风说话，按停顿一句一句出字；鼠标悬到某句上打标记）');

		this.previewEl = root.createDiv();
		this.previewEl.style.padding = '4px 8px';
		this.previewEl.style.fontFamily = 'var(--font-text)';
		this.previewEl.style.minHeight = '20px';
		this.previewEl.style.color = 'var(--text-muted)';
		this.previewEl.style.display = 'none';

		const footer = root.createDiv();
		footer.style.display = 'flex';
		footer.style.gap = '8px';
		const copy = footer.createEl('button', { text: '复制全文' });
		copy.onclick = () => {
			const text = this.plainText();
			if (text === '') {
				new Notice('还没有可复制的内容。');
				return;
			}
			void navigator.clipboard.writeText(text).then(() => new Notice('已复制实时转写全文。'));
		};
		const insert = footer.createEl('button', { text: '插入到笔记' });
		insert.onclick = () => {
			const text = this.plainText();
			if (text === '') {
				new Notice('还没有可插入的内容。');
				return;
			}
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) {
				new Notice('先打开一篇笔记再插入。');
				return;
			}
			view.editor.replaceSelection(text + '\n');
			new Notice('已插入实时转写文本。');
		};

		this.controller.setSink(this);
	}

	/** The transcript without the per-line session timestamps. */
	private plainText(): string {
		return this.controller
			.getTranscript()
			.map((line) => line.replace(/^\[\d{2}:\d{2}\] /, ''))
			.join('\n');
	}

	override async onClose(): Promise<void> {
		// The session has nowhere to show itself once the panel is gone, and
		// the chosen lifecycle kills the server on stop, so a closed panel
		// means a stopped session. stop() is a no-op when nothing runs.
		this.controller.setSink(null);
		this.hideMarkerPopup();
		this.markerPopup?.remove();
		this.markerPopup = null;
		void this.controller.stop();
	}

	// ------------------------------------------------------------------
	// 悬浮标记条：一行上出现，以鼠标为中心，移开即隐
	// ------------------------------------------------------------------

	/**
	 * Builds the shared floating marker bar once and positions it centered on
	 * the cursor (clamped to the viewport), over the hovered line.
	 * @param event - The mouseenter that asked for it
	 * @param lineIndex - The line the bar tags
	 */
	private showMarkerPopup(event: MouseEvent, lineIndex: number): void {
		if (!this.listening) {
			return;
		}
		if (this.popupHideTimer) {
			clearTimeout(this.popupHideTimer);
			this.popupHideTimer = null;
		}
		this.popupLineIndex = lineIndex;
		if (!this.markerPopup) {
			const popup = document.body.createDiv();
			popup.style.position = 'fixed';
			popup.style.zIndex = 'var(--layer-popover, 30)';
			popup.style.display = 'flex';
			popup.style.gap = '4px';
			popup.style.padding = '4px';
			popup.style.borderRadius = '8px';
			popup.style.background = 'var(--background-primary)';
			popup.style.border = '1px solid var(--background-modifier-border)';
			popup.style.boxShadow = 'var(--shadow-s)';
			for (const kind of LIVE_MARKER_KINDS) {
				const button = popup.createEl('button', { text: kind });
				button.style.padding = '2px 8px';
				button.onclick = (event): void => {
					event.stopPropagation();
					void this.controller.addMarker(kind, this.popupLineIndex);
					this.hideMarkerPopup();
				};
			}
			popup.onmouseenter = (): void => {
				if (this.popupHideTimer) {
					clearTimeout(this.popupHideTimer);
					this.popupHideTimer = null;
				}
			};
			popup.onmouseleave = (): void => this.hideMarkerPopup();
			this.markerPopup = popup;
		}
		const popup = this.markerPopup;
		popup.style.display = 'flex';
		// 先展示量宽，再贴着鼠标居中：过窄的侧栏也 clamp 在视口内。
		const width = popup.offsetWidth || 150;
		const left = Math.min(
			Math.max(event.clientX - width / 2, 8),
			window.innerWidth - width - 8,
		);
		const top = event.clientY > 70 ? event.clientY - 44 : event.clientY + 18;
		popup.style.left = `${left}px`;
		popup.style.top = `${top}px`;
	}

	/** Schedules the bar away; moving onto the bar itself cancels this. */
	private scheduleMarkerHide(): void {
		if (this.popupHideTimer) {
			clearTimeout(this.popupHideTimer);
		}
		this.popupHideTimer = setTimeout(() => this.hideMarkerPopup(), 150);
	}

	private hideMarkerPopup(): void {
		if (this.popupHideTimer) {
			clearTimeout(this.popupHideTimer);
			this.popupHideTimer = null;
		}
		if (this.markerPopup) {
			this.markerPopup.style.display = 'none';
		}
		this.popupLineIndex = -1;
	}

	// ------------------------------------------------------------------
	// Sink 回调
	// ------------------------------------------------------------------

	onLog(message: string): void {
		if (message !== '') {
			this.statusEl.setText(message);
		}
	}

	onLine(line: string, index: number): void {
		const existing = this.lineRows[index];
		if (existing) {
			existing.textEl.setText(line);
			return;
		}
		if (this.lineRows.length === 0) {
			this.transcriptEl.setText('');
		}
		const row = this.transcriptEl.createDiv();
		row.style.marginBottom = '4px';
		row.style.borderRadius = '4px';
		const textEl = row.createSpan({ text: line });
		row.onmouseenter = (event): void => {
			row.style.background = 'var(--background-modifier-hover)';
			this.showMarkerPopup(event, index);
		};
		row.onmouseleave = (): void => {
			row.style.background = '';
			this.scheduleMarkerHide();
		};
		this.lineRows.push({ textEl });
		this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
	}

	onPreview(stable: string, unstable: string): void {
		if (stable === '' && unstable === '') {
			this.previewEl.style.display = 'none';
			this.previewEl.setText('');
			return;
		}
		this.previewEl.style.display = 'block';
		this.previewEl.setText('');
		if (stable !== '') {
			this.previewEl.createSpan({ text: stable });
		}
		const moving = this.previewEl.createSpan({ text: unstable + '▍' });
		moving.style.color = 'var(--text-muted)';
		this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
	}

	onState(state: LiveSessionState): void {
		this.startButton.disabled = state !== 'idle';
		this.stopButton.disabled = state !== 'listening' && state !== 'starting';
		this.screenshotButton.disabled = state !== 'listening';
		this.listening = state === 'listening';
		if (!this.listening) {
			this.hideMarkerPopup();
		}
		this.statusEl.setText(STATE_LABELS[state]);
		if (state === 'idle' && this.lineRows.length === 0) {
			this.transcriptEl.setText('（对着麦克风说话，按停顿一句一句出字；鼠标悬到某句上打标记）');
		}
	}
}
