export interface ParsedTimestamp {
	seconds: number;
	label: string;
	audioId: string | null;
}

const TIMESTAMP_PATTERN = /#audio-time=(\d{1,2}):(\d{2})(?::(\d{2}))?(?=$|&)/i;
const AUDIO_ID_PATTERN = /(?:^|&)audio=([^&#\s]*)/i;
const VALID_AUDIO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

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

	const first = Number(match[1]);
	const second = Number(match[2]);
	const third = match[3] === undefined ? null : Number(match[3]);
	const fragment = normalizedTarget.slice(match.index);
	const rawAudioId = AUDIO_ID_PATTERN.exec(fragment)?.[1];
	if (rawAudioId !== undefined && !VALID_AUDIO_ID_PATTERN.test(rawAudioId)) return null;
	const audioId = rawAudioId?.toLowerCase() ?? null;
	if (second > 59 || (third !== null && third > 59)) return null;

	return third === null
		? { seconds: first * 60 + second, label: `${match[1]}:${match[2]}`, audioId }
		: {
				seconds: first * 3600 + second * 60 + third,
				label: `${match[1]}:${match[2]}:${match[3]}`,
				audioId,
			};
}
