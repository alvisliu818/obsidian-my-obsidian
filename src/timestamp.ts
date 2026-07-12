import type { MediaType } from './media-index';

export interface ParsedTimestamp {
	seconds: number;
	label: string;
	mediaType: MediaType;
	mediaId: string | null;
}

const TIMESTAMP_PATTERN = /#(audio|video)-time=(\d{1,2}):(\d{2})(?::(\d{2}))?(?=$|&)/i;
const VALID_MEDIA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export function parseTimestamp(target: string): ParsedTimestamp | null {
	let decodedTarget: string;
	try {
		decodedTarget = decodeURIComponent(target);
	} catch {
		decodedTarget = target;
	}

	const normalizedTarget = decodedTarget.replaceAll('&amp;', '&');
	const match = TIMESTAMP_PATTERN.exec(normalizedTarget);
	if (!match) return null;

	const mediaType = match[1]?.toLowerCase() as MediaType;
	const first = Number(match[2]);
	const second = Number(match[3]);
	const third = match[4] === undefined ? null : Number(match[4]);
	const fragment = normalizedTarget.slice(match.index);
	const idPattern = new RegExp(`(?:^|&)${mediaType}=([^&#\\s]*)`, 'i');
	const rawMediaId = idPattern.exec(fragment)?.[1];
	if (rawMediaId !== undefined && !VALID_MEDIA_ID_PATTERN.test(rawMediaId)) return null;
	const mediaId = rawMediaId?.toLowerCase() ?? null;
	if (second > 59 || (third !== null && third > 59)) return null;

	return third === null
		? {
				seconds: first * 60 + second,
				label: `${match[2]}:${match[3]}`,
				mediaType,
				mediaId,
			}
		: {
				seconds: first * 3600 + second * 60 + third,
				label: `${match[2]}:${match[3]}:${match[4]}`,
				mediaType,
				mediaId,
			};
}
