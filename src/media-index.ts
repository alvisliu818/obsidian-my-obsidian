import type { App, TFile } from 'obsidian';

export type MediaType = 'audio' | 'video';

const EXTENSIONS: Record<MediaType, string> = {
	audio: 'mp3|wav|m4a|ogg|flac',
	video: 'mp4|webm|ogv|mov|m4v',
};

export interface MediaReference {
	id: string | null;
	sourceLink: string;
	type: MediaType;
}

export interface MediaBinding extends MediaReference {
	file: TFile;
}

export type MediaSelectionResult =
	| { binding: MediaBinding; error: null }
	| { binding: null; error: 'none' | 'ambiguous' | 'duplicate' | 'unknown' };

export function extractMediaReferences(content: string, type: MediaType): MediaReference[] {
	const references: MediaReference[] = [];
	const embedPattern = new RegExp(
		`!\\[\\[([^\\]|#]+\\.(?:${EXTENSIONS[type]}))(?:[^\\]]*)\\]\\]`,
		'gi',
	);
	const idPattern = new RegExp(
		`%%\\s*${type}-id\\s*:\\s*([A-Za-z0-9][A-Za-z0-9_-]{0,31})\\s*%%`,
		'i',
	);

	for (const line of content.split(/\r?\n/)) {
		const matches = Array.from(line.matchAll(embedPattern));
		if (matches.length === 0) continue;

		const mediaId = idPattern.exec(line)?.[1]?.toLowerCase() ?? null;
		for (const [index, match] of matches.entries()) {
			const sourceLink = match[1];
			if (!sourceLink) continue;
			references.push({
				id: index === 0 ? mediaId : null,
				sourceLink,
				type,
			});
		}
	}
	return references;
}

export async function resolveMediaBindings(
	app: App,
	note: TFile,
	content: string,
	type: MediaType,
): Promise<MediaBinding[]> {
	const bindings: MediaBinding[] = [];
	for (const reference of extractMediaReferences(content, type)) {
		const file = app.metadataCache.getFirstLinkpathDest(reference.sourceLink, note.path);
		if (file) bindings.push({ ...reference, file });
	}
	return bindings;
}

export function selectMediaBinding(
	bindings: MediaBinding[],
	mediaId: string | null,
): MediaSelectionResult {
	if (bindings.length === 0) return { binding: null, error: 'none' };

	const duplicateIds = new Set<string>();
	const seenIds = new Set<string>();
	for (const binding of bindings) {
		if (!binding.id) continue;
		if (seenIds.has(binding.id)) duplicateIds.add(binding.id);
		seenIds.add(binding.id);
	}

	if (mediaId) {
		const normalizedId = mediaId.toLowerCase();
		if (duplicateIds.has(normalizedId)) return { binding: null, error: 'duplicate' };
		const binding = bindings.find((candidate) => candidate.id === normalizedId) ?? null;
		return binding ? { binding, error: null } : { binding: null, error: 'unknown' };
	}

	const onlyBinding = bindings[0];
	return bindings.length === 1 && onlyBinding
		? { binding: onlyBinding, error: null }
		: { binding: null, error: 'ambiguous' };
}
