/**
 * A modal that lists the windows a live-marker screenshot can be taken of,
 * one button per window. The list is read at open time: windows come and go,
 * so nothing is cached between opens.
 * @module live/windowPickerModal
 */

import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import { listWindows } from './windowCapture';

/**
 * The picker. Confirming a row hands the window's display name back; capture
 * matches the name again at click time, so a window that closed and reopened
 * under the same title keeps working.
 */
export class LiveWindowPickerModal extends Modal {
	/**
	 * @param app - Obsidian App instance
	 * @param onPick - Called with the picked window's display name
	 */
	constructor(
		app: App,
		private readonly onPick: (name: string) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText('选择截图窗口');
		this.contentEl.createDiv({ text: '标记时会截取所选窗口的画面。' }).style.color =
			'var(--text-muted)';
		void listWindows().then((windows) => {
			if (windows.length === 0) {
				this.contentEl.createDiv({ text: '没有可用窗口。' });
				return;
			}
			for (const window of windows) {
				this.contentEl
					.createDiv()
					.createEl('button', { text: window.name })
					.onclick = (): void => {
						this.onPick(window.name);
						this.close();
					};
			}
		});
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
