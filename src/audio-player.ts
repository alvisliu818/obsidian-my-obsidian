import { App, TFile } from 'obsidian';

const AUDIO_EMBED_PATTERN = /!\[\[([^\]|#]+\.(?:mp3|wav|m4a|ogg|flac))(?:[^\]]*)\]\]/i;

export function findVisiblePlayer(container: ParentNode): HTMLAudioElement | null {
	const players = Array.from(container.querySelectorAll('audio'));
	return players.find((audio) => {
		const style = activeWindow.getComputedStyle(audio);
		return (
			audio.isConnected &&
			audio.getClientRects().length > 0 &&
			style.display !== 'none' &&
			style.visibility !== 'hidden'
		);
	}) ?? null;
}

export async function createPersistentPlayer(
	app: App,
	container: HTMLElement,
	note: TFile,
): Promise<HTMLAudioElement | null> {
	const existing = container.querySelector<HTMLAudioElement>(
		'audio.audio-timestamp-persistent-audio',
	);
	if (existing) return existing;

	const content = await app.vault.cachedRead(note);
	const match = AUDIO_EMBED_PATTERN.exec(content);
	if (!match) return null;
	const audioLink = match[1];
	if (!audioLink) return null;

	const audioFile = app.metadataCache.getFirstLinkpathDest(audioLink, note.path);
	if (!audioFile) return null;

	const bar = container.createDiv({ cls: 'audio-timestamp-persistent-player' });
	const label = bar.createDiv({
		cls: 'audio-timestamp-persistent-label',
		text: 'Audio',
	});
	const audio = bar.createEl('audio', {
		cls: 'audio-timestamp-persistent-audio',
	});
	audio.controls = true;
	audio.preload = 'metadata';
	audio.src = app.vault.getResourcePath(audioFile);

	bar.append(label, audio);
	container.prepend(bar);
	return audio;
}
