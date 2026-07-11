export interface ParsedTimestamp {
	seconds: number;
	label: string;
}

const TIMESTAMP_PATTERN = /#audio-timestamp=(\d{1,2}):(\d{2})(?::(\d{2}))?/i;

export function parseTimestamp(target: string): ParsedTimestamp | null {
	let decodedTarget: string;
	try {
		decodedTarget = decodeURIComponent(target);
	} catch {
		decodedTarget = target;
	}

	const match = TIMESTAMP_PATTERN.exec(decodedTarget);
	if (!match) return null;

	const first = Number(match[1]);
	const second = Number(match[2]);
	const third = match[3] === undefined ? null : Number(match[3]);
	if (second > 59 || (third !== null && third > 59)) return null;

	return third === null
		? { seconds: first * 60 + second, label: `${match[1]}:${match[2]}` }
		: {
				seconds: first * 3600 + second * 60 + third,
				label: `${match[1]}:${match[2]}:${match[3]}`,
			};
}
