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

/** One transcript row in the DOM: its box and its text node. */
interface LineRow {
	rowEl: HTMLElement;
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
	private startButton!: HTMLButtonElement;
	private stopButton!: HTMLButtonElement;
	private screenshotButton!: HTMLButtonElement;
	/** One row per committed line, indexed exactly like the controller's. */
	private lineRows: LineRow[] = [];
	/**
	 * The row the speaker is still speaking into. It sits inside the transcript
	 * as its last row and is handed over to the committed line when the pause
	 * ends the sentence, so text grows downward from the top instead of living
	 * in a strip pinned under the box.
	 */
	private activeRow: LineRow | null = null;
	/** Whether the transcript still shows its "say something" placeholder. */
	private hintShowing = true;
	private static readonly HINT =
		'（对着麦克风说话，转写从上往下一句句往下写；鼠标悬到某句上打标记）';
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

		// 唯一的转写区：正文从上往下累积，正在说的那一行就是区内最后一行，
		// 不再挂一条钉在底部的独立预览条。
		this.transcriptEl = root.createDiv();
		this.transcriptEl.style.flex = '1';
		this.transcriptEl.style.minHeight = '0';
		this.transcriptEl.style.overflowY = 'auto';
		this.transcriptEl.style.whiteSpace = 'pre-wrap';
		this.transcriptEl.style.fontFamily = 'var(--font-text)';
		this.transcriptEl.style.padding = '8px';
		this.transcriptEl.style.borderRadius = '8px';
		this.transcriptEl.style.background = 'var(--background-secondary)';
		this.transcriptEl.setText(LiveTranscribeView.HINT);

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
		const lines = this.controller
			.getTranscript()
			.map((line) => line.replace(/^\[\d{2}:\d{2}\] /, ''));
		// The line still being spoken is on screen too, so it goes along.
		const held = (this.activeRow?.textEl.textContent ?? '')
			.replace(/▍$/, '')
			.trim();
		if (held !== '') {
			lines.push(held);
		}
		return lines.join('\n');
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
	// 行 DOM：一律追加到转写区末尾，天然自上而下
	// ------------------------------------------------------------------

	/** Drops the placeholder so the first row starts at the top of the box. */
	private ensureNoHint(): void {
		if (!this.hintShowing) {
			return;
		}
		this.hintShowing = false;
		this.transcriptEl.setText('');
	}

	/**
	 * Appends one row at the end of the transcript box. Rows are never
	 * inserted anywhere else, which is what keeps the text top-down.
	 */
	private appendRow(): LineRow {
		this.ensureNoHint();
		const rowEl = this.transcriptEl.createDiv();
		rowEl.style.marginBottom = '4px';
		rowEl.style.borderRadius = '4px';
		return { rowEl, textEl: rowEl.createSpan() };
	}

	/** Puts one line's text into a row, as solid text. */
	private writeRow(row: LineRow, text: string): void {
		row.textEl.setText(text);
	}

	/** Wires the hovered marker bar onto a committed row. */
	private bindRowHover(row: LineRow, index: number): void {
		row.rowEl.onmouseenter = (event): void => {
			row.rowEl.style.background = 'var(--background-modifier-hover)';
			this.showMarkerPopup(event, index);
		};
		row.rowEl.onmouseleave = (): void => {
			row.rowEl.style.background = '';
			this.scheduleMarkerHide();
		};
	}

	/**
	 * Keeps the last line in view, unless the reader has scrolled up to reread
	 * something — then the text stays where they left it.
	 */
	private stickToBottom(): void {
		const el = this.transcriptEl;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distanceFromBottom < 48) {
			el.scrollTop = el.scrollHeight;
		}
	}

	/**
	 * Takes back a row nothing is being spoken into any more. A row still
	 * carrying text is kept: the pause may have cut the sentence off, and the
	 * words are worth more than the empty line where they were being written.
	 */
	private dropActiveRow(): void {
		const row = this.activeRow;
		if (!row) {
			return;
		}
		if ((row.textEl.textContent ?? '').trim() !== '') {
			return;
		}
		this.activeRow = null;
		row.rowEl.remove();
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
			// A marker tagged an already committed line.
			this.writeRow(existing, line);
			return;
		}
		// The sentence being spoken keeps the row it was already rendering in:
		// the committed text replaces the moving preview in place instead of
		// the line jumping to another place in the box.
		const row = this.activeRow ?? this.appendRow();
		this.activeRow = null;
		this.writeRow(row, line);
		this.bindRowHover(row, index);
		this.lineRows[index] = row;
		this.stickToBottom();
	}

	onPreview(stable: string, unstable: string): void {
		if (stable === '' && unstable === '') {
			// Silence, or the tail is on its way to become a committed line:
			// the row keeps what was recognized and only loses its caret, so a
			// sentence never blinks out while the recognizer answers.
			const row = this.activeRow;
			if (row) {
				const held = (row.textEl.textContent ?? '').replace(/▍$/, '');
				this.writeRow(row, held);
			}
			return;
		}
		const row = this.activeRow ?? this.appendRow();
		this.activeRow = row;
		row.textEl.setText('');
		if (stable !== '') {
			row.textEl.createSpan({ text: stable });
		}
		const moving = row.textEl.createSpan({ text: unstable + '▍' });
		moving.style.color = 'var(--text-muted)';
		this.stickToBottom();
	}

	onState(state: LiveSessionState): void {
		this.startButton.disabled = state !== 'idle';
		this.stopButton.disabled = state !== 'listening' && state !== 'starting';
		// 截屏是「正在听」的动作；标记不受限——会话停了，转写仍是文档。
		this.screenshotButton.disabled = state !== 'listening';
		this.statusEl.setText(STATE_LABELS[state]);
		if (state === 'idle') {
			// Nothing is being spoken into a row any more.
			this.dropActiveRow();
			if (this.lineRows.length === 0 && !this.hintShowing) {
				this.hintShowing = true;
				this.transcriptEl.setText(LiveTranscribeView.HINT);
			}
		}
	}
}
