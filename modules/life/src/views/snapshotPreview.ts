/** 保存历史快照预览(2026-11-22 用户):HOME「保存历史」区块点击版本的只读弹窗。 */
import { Modal, type App } from 'obsidian';

export class SnapshotPreviewModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private body: string,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.heading);
		const pre = this.contentEl.createEl('pre', { cls: 'life-snapshot-preview' });
		pre.setText(this.body || '(空文件)');
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
