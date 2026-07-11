import { App, Notice } from 'obsidian';
import { createPersistentPlayer, findVisiblePlayer } from './audio-player';
import { parseTimestamp } from './timestamp';

export class TimestampController {
	constructor(private readonly app: App) {}

	async handleClick(event: MouseEvent): Promise<void> {
		const target = event.target;
		if (!(target instanceof Element)) return;

		const link = target.closest<HTMLAnchorElement>('a');
		if (!link) return;

		const href = link.getAttribute('data-href') ?? link.getAttribute('href') ?? '';
		const timestamp = parseTimestamp(href);
		if (!timestamp) return;

		event.preventDefault();
		event.stopPropagation();

		const view = link.closest<HTMLElement>(
			'.markdown-preview-view, .markdown-source-view',
		) ?? link.closest<HTMLElement>('.workspace-leaf-content');
		if (!view) return;

		let player = findVisiblePlayer(view);
		if (!player) {
			const note = this.app.workspace.getActiveFile();
			if (note?.extension === 'md') {
				player = await createPersistentPlayer(this.app, view, note);
			}
		}

		if (!player) {
			new Notice('No embedded audio file was found in the current note.');
			return;
		}

		const players = Array.from(view.querySelectorAll('audio'));
		for (const otherPlayer of players) {
			if (otherPlayer.instanceOf(HTMLAudioElement) && otherPlayer !== player) {
				otherPlayer.pause();
			}
		}

		await this.playFrom(player, timestamp.seconds);
	}

	private async playFrom(player: HTMLAudioElement, seconds: number): Promise<void> {
		if (player.readyState < HTMLMediaElement.HAVE_METADATA) {
			await new Promise<void>((resolve, reject) => {
				player.addEventListener('loadedmetadata', () => resolve(), { once: true });
				player.addEventListener('error', () => reject(new Error('Audio metadata failed to load.')), {
					once: true,
				});
				player.load();
			}).catch(() => {
				new Notice('The audio file could not be loaded.');
			});
		}

		if (player.readyState < HTMLMediaElement.HAVE_METADATA) return;
		player.currentTime = Math.min(seconds, Number.isFinite(player.duration) ? player.duration : seconds);
		try {
			await player.play();
		} catch {
			new Notice('Playback was blocked. Select the timestamp again.');
		}
	}
}
