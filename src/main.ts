import { Plugin } from 'obsidian';
import { AudioPlayerManager } from './audio-player';
import { TimestampController } from './timestamp-controller';

export default class AudioTimestampPlayerPlugin extends Plugin {
	private playerManager: AudioPlayerManager | null = null;

	onload(): void {
		this.playerManager = new AudioPlayerManager(this.app);
		const controller = new TimestampController(this.app, this.playerManager);

		this.registerDomEvent(
			activeDocument,
			'click',
			(event: MouseEvent) => {
				void controller.handleClick(event);
			},
			true,
		);
	}

	onunload(): void {
		this.playerManager?.destroy();
		this.playerManager = null;
	}
}
