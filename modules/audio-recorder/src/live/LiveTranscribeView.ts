/**
 * The live-transcribe panel: start/stop, a row of marker buttons (重点 /
 * 问题 / 待办 — a click tags the last line with its name and the wall-clock
 * time, optionally screenshotting the chosen window), the rolling transcript
 * cut per speech pause, and copy/insert actions for what accumulated.
 * Chinese by construction — a merged-fork feature, not upstream surface.
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

/**
 * The panel. One view at a time is enforced by the leaf the commands use;
 * the controller refuses concurrent sessions regardless.
 */
export class LiveTranscribeView extends ItemView implements LiveTranscribeSink {
	private readonly controller: LiveTranscribeController;
	private readonly ui: LiveTranscribeViewUi;
	private statusEl!: HTMLElement;
	private transcriptEl!: HTMLElement;
	private markerRowEl!: HTMLElement;
	private startButton!: HTMLButtonElement;
	private stopButton!: HTMLButtonElement;
	private lineEls: HTMLElement[] = [];

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

		this.markerRowEl = root.createDiv();
		this.markerRowEl.style.display = 'flex';
		this.markerRowEl.style.gap = '6px';
		for (const kind of LIVE_MARKER_KINDS) {
			const button = this.markerRowEl.createEl('button', { text: kind });
			button.onclick = (): void => {
				void this.controller.addMarker(kind);
			};
		}
		const pickWindow = this.markerRowEl.createEl('button', {
			text: '选择截图窗口…',
		});
		pickWindow.onclick = (): void => {
			this.ui.openWindowPicker((name) => {
				pickWindow.setText(name === '' ? '选择截图窗口…' : `截屏：${name}`);
			});
		};

		this.transcriptEl = root.createDiv();
		this.transcriptEl.style.flex = '1';
		this.transcriptEl.style.overflowY = 'auto';
		this.transcriptEl.style.whiteSpace = 'pre-wrap';
		this.transcriptEl.style.fontFamily = 'var(--font-text)';
		this.transcriptEl.style.padding = '8px';
		this.transcriptEl.style.borderRadius = '8px';
		this.transcriptEl.style.background = 'var(--background-secondary)';
		this.transcriptEl.setText('（对着麦克风说话，按停顿一句一句出字；点上方按钮打标记）');

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
		void this.controller.stop();
	}

	onLog(message: string): void {
		if (message !== '') {
			this.statusEl.setText(message);
		}
	}

	onLine(line: string, index: number): void {
		const existing = this.lineEls[index];
		if (existing) {
			existing.setText(line);
			return;
		}
		if (this.lineEls.length === 0) {
			this.transcriptEl.setText('');
		}
		const row = this.transcriptEl.createDiv({ text: line });
		row.style.marginBottom = '4px';
		this.lineEls.push(row);
		this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
	}

	onState(state: LiveSessionState): void {
		this.startButton.disabled = state !== 'idle';
		this.stopButton.disabled = state !== 'listening' && state !== 'starting';
		for (const child of Array.from(this.markerRowEl.children)) {
			(child as HTMLButtonElement).disabled = state !== 'listening';
		}
		this.statusEl.setText(STATE_LABELS[state]);
		if (state === 'idle' && this.lineEls.length === 0) {
			this.transcriptEl.setText('（对着麦克风说话，按停顿一句一句出字；点上方按钮打标记）');
		}
	}
}
