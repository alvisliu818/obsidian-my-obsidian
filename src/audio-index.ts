import type { App, TFile } from 'obsidian';

const AUDIO_EMBED_PATTERN = /!\[\[([^\]|#]+\.(?:mp3|wav|m4a|ogg|flac))(?:[^\]]*)\]\]/gi;
const AUDIO_ID_PATTERN = /%%\s*audio-id\s*:\s*([A-Za-z0-9][A-Za-z0-9_-]{0,31})\s*%%/i;

export interface AudioReference {
	id: string | null;
	sourceLink: string;
}

export interface AudioBinding extends AudioReference {
	file: TFile;
}

export type AudioSelectionResult =
	| { binding: AudioBinding; error: null }
	| { binding: null; error: 'none' | 'ambiguous' | 'duplicate' | 'unknown' };

export function extractAudioReferences(content: string): AudioReference[] {
	const references: AudioReference[] = [];
	for (const line of content.split(/\r?\n/)) {
		const matches = Array.from(line.matchAll(AUDIO_EMBED_PATTERN));
		if (matches.length === 0) continue;

		const audioId = AUDIO_ID_PATTERN.exec(line)?.[1]?.toLowerCase() ?? null;
		for (const [index, match] of matches.entries()) {
			const sourceLink = match[1];
			if (!sourceLink) continue;
			references.push({
				id: index === 0 ? audioId : null,
				sourceLink,
			});
		}
	}
	return references;
}

export async function resolveAudioBindings(
	app: App,
	note: TFile,
	content: string,
): Promise<AudioBinding[]> {
	const bindings: AudioBinding[] = [];
	for (const reference of extractAudioReferences(content)) {
		const file = app.metadataCache.getFirstLinkpathDest(reference.sourceLink, note.path);
		if (file) bindings.push({ ...reference, file });
	}
	return bindings;
}

export function selectAudioBinding(
	bindings: AudioBinding[],
	audioId: string | null,
): AudioSelectionResult {
	if (bindings.length === 0) return { binding: null, error: 'none' };

	const duplicateIds = new Set<string>();
	const seenIds = new Set<string>();
	for (const binding of bindings) {
		if (!binding.id) continue;
		if (seenIds.has(binding.id)) duplicateIds.add(binding.id);
		seenIds.add(binding.id);
	}

	if (audioId) {
		const normalizedId = audioId.toLowerCase();
		if (duplicateIds.has(normalizedId)) return { binding: null, error: 'duplicate' };
		const binding = bindings.find((candidate) => candidate.id === normalizedId) ?? null;
		return binding ? { binding, error: null } : { binding: null, error: 'unknown' };
	}

	const onlyBinding = bindings[0];
	return bindings.length === 1 && onlyBinding
		? { binding: onlyBinding, error: null }
		: { binding: null, error: 'ambiguous' };
}
