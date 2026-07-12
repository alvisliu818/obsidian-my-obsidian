import type { App, TFile } from 'obsidian';
import {
	extractMediaReferences,
	resolveMediaBindings,
	selectMediaBinding,
} from './media-index';
import type {
	MediaBinding,
	MediaReference,
	MediaSelectionResult,
} from './media-index';

export type AudioReference = MediaReference;
export type AudioBinding = MediaBinding;
export type AudioSelectionResult = MediaSelectionResult;

export function extractAudioReferences(content: string): AudioReference[] {
	return extractMediaReferences(content, 'audio');
}

export async function resolveAudioBindings(
	app: App,
	note: TFile,
	content: string,
): Promise<AudioBinding[]> {
	return resolveMediaBindings(app, note, content, 'audio');
}

export function selectAudioBinding(
	bindings: AudioBinding[],
	audioId: string | null,
): AudioSelectionResult {
	return selectMediaBinding(bindings, audioId);
}
