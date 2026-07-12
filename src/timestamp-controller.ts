import { App, MarkdownView, TFile } from 'obsidian';
import { AudioPlayerManager } from './audio-player';
import { findTimestampTarget } from './timestamp-target';
import { parseTimestamp } from './timestamp';

export class TimestampController {
	constructor(
		private readonly app: App,
		private readonly playerManager: AudioPlayerManager,
	) {}

	async handleClick(event: MouseEvent): Promise<void> {
		const target = event.target;
		if (!target || typeof (target as Element).closest !== 'function') return;
		const targetElement = target as Element;

		const timestampTarget = findTimestampTarget(event, targetElement);
		if (!timestampTarget) return;

		const timestamp = parseTimestamp(timestampTarget);
		if (!timestamp) return;

		const view = targetElement.closest<HTMLElement>(
			'.markdown-preview-view, .markdown-source-view',
		) ?? targetElement.closest<HTMLElement>('.workspace-leaf-content');
		if (!view) return;

		const note = this.findNote(view);
		if (!note) return;

		event.preventDefault();
		event.stopPropagation();
		await this.playerManager.play(note, timestamp.seconds, view);
	}

	private findNote(view: HTMLElement): TFile | null {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(view)) {
				return leaf.view.file;
			}
		}
		return this.app.workspace.getActiveFile();
	}
}
