import { Plugin } from 'obsidian';
import { TimestampController } from './timestamp-controller';

export default class AudioTimestampPlayerPlugin extends Plugin {
	onload(): void {
		const controller = new TimestampController(this.app);

		this.registerDomEvent(
			activeDocument,
			'click',
			(event: MouseEvent) => {
				void controller.handleClick(event);
			},
			true,
		);
	}
}
