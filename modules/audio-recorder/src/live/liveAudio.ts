/**
 * Client-side segmentation for live transcription. Blocks from the capture
 * graph are fed to a pause-aware segmenter: speech runs are cut into one
 * segment per pause, so every transcript line the panel gains corresponds to
 * one spoken sentence or burst rather than to an arbitrary timer boundary.
 * Kept free of DOM and Node so the arithmetic is unit-testable.
 * @module live/liveAudio
 */

/** Tunables of the pause segmenter, all in frames or milliseconds. */
export interface PauseSegmenterConfig {
	/** Capture rate in Hz (the capture graph resamples to this). */
	sampleRate: number;
	/** RMS above which a block counts as speech. */
	speechRms: number;
	/** RMS below which a block counts as silence (hysteresis between the two). */
	silenceRms: number;
	/** Silence that ends a segment, in milliseconds. */
	silenceMs: number;
	/** Shortest segment worth recognizing, in milliseconds. */
	minSpeechMs: number;
	/** Longest a continuous-speech segment may grow, in milliseconds. */
	maxSegmentMs: number;
	/** Audio kept before the first speech block, so word onsets survive. */
	preRollMs: number;
}

/** Default tuning for speech at a desk microphone. */
export const DEFAULT_PAUSE_SEGMENTER_CONFIG: PauseSegmenterConfig = {
	sampleRate: 16_000,
	speechRms: 0.006,
	silenceRms: 0.0035,
	silenceMs: 700,
	minSpeechMs: 800,
	maxSegmentMs: 15_000,
	preRollMs: 300,
};

/**
 * Root-mean-square level of mono samples, 0..1 for full-scale sine. The
 * speech/silence gates read this one number per block.
 * @param samples - Mono samples, range -1..1
 * @returns The block's RMS level
 */
export function rmsOf(samples: Float32Array): number {
	if (samples.length === 0) {
		return 0;
	}
	let sum = 0;
	for (const sample of samples) {
		sum += sample * sample;
	}
	return Math.sqrt(sum / samples.length);
}

/**
 * The share of ~30 ms windows whose level reaches the speech gate. A segment
 * mostly under the gate is silence, breath or background music — exactly the
 * audio whisper answers with a confident hallucination — so the commit path
 * refuses to spend the model on it.
 * @param samples - Mono samples, range -1..1
 * @param sampleRate - The samples' rate in Hz
 * @param speechRms - The level a window must reach to count as voiced
 * @param windowMs - Window length in milliseconds
 * @returns Voiced windows over all windows (0 for an empty span)
 */
export function voicedRatioOf(
	samples: Float32Array,
	sampleRate: number,
	speechRms: number,
	windowMs = 30,
): number {
	const window = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
	let total = 0;
	let voiced = 0;
	for (let offset = 0; offset + window <= samples.length; offset += window) {
		total++;
		if (rmsOf(samples.subarray(offset, offset + window)) >= speechRms) {
			voiced++;
		}
	}
	return total === 0 ? 0 : voiced / total;
}

/**
 * Whisper's best-known ghost sentences, as substrings of the
 * punctuation-stripped, lower-cased probe. A recognized line carrying one of
 * these did not come from the microphone: the model dreamed it over silence,
 * breath or background music. Each entry is chosen to be specific enough that
 * a speaker is realistically never heard saying it into a live microphone —
 * the dictation surface, not video transcription, is what this guards.
 */
const GHOST_SUBSTRINGS = [
	'明镜与点点栏目',
	'字幕志愿者',
	'字幕由',
	'谢谢观看',
	'谢谢收看',
	'订阅转发',
	'打赏支持',
	'欢迎收看',
	'amaraorg',
	'subtitlesby',
	'pleasesubscribe',
] as const;

/**
 * A whole line that is one syllable hammered again and again ("爹爹爹爹爹")
 * is the other shape a hallucination takes — unless the syllable is a
 * laughter or filler particle a speaker really does repeat.
 */
const GHOST_REPEAT_ALLOWED = new Set([
	'哈', '呵', '嘿', '嘻', '嗯', '呃', '啊', '哦', '喔', '噢', '唉', '哎',
	'呜', '呼', '啦', '呀', '咦', '哒', '嘛', '么',
]);

/**
 * Whether a recognized line reads like a whisper hallucination rather than
 * speech. The ghost phrases are specific enough that their substring match is
 * trusted; the hammered-syllable rule judges the whole line.
 * @param text - The recognized text, whitespace and newlines already flat
 * @returns True when the line should not be shown
 */
export function isLikelyHallucination(text: string): boolean {
	const probe = text
		.toLowerCase()
		.replace(/\s+/g, '')
		.replace(/[\p{P}\p{S}]/gu, '');
	if (probe === '') {
		return false;
	}
	for (const ghost of GHOST_SUBSTRINGS) {
		if (probe.includes(ghost)) {
			return true;
		}
	}
	const hammered = /^(.)\1{4,}$/u.exec(probe);
	return hammered !== null && !GHOST_REPEAT_ALLOWED.has(hammered[1] ?? '');
}

/** One completed speech segment, with its place on the capture timeline. */
export interface LiveSegment {
	/** Mono samples of the whole segment (pre-roll included). */
	samples: Float32Array;
	/** The frame index the segment began at, on the capture timeline. */
	startFrame: number;
}

/**
 * Builds segments from a stream of mono blocks, cutting at pauses.
 *
 * The segmenter holds three things: a pre-roll ring that keeps the last few
 * hundred milliseconds of silence so a word's onset is never clipped, the
 * growing speech segment, and a silence counter that decides when the pause
 * has lasted long enough to end it. A segment that runs past the maximum
 * length is emitted mid-speech rather than growing unbounded.
 */
export class PauseSegmenter {
	private readonly cfg: PauseSegmenterConfig;
	private readonly preRoll: Float32Array[] = [];
	private preRollFrames = 0;
	private segment: Float32Array[] = [];
	private segmentFrames = 0;
	private segmentStartFrame = 0;
	private totalFrames = 0;
	private silenceFrames = 0;
	private speaking = false;

	constructor(config?: Partial<PauseSegmenterConfig>) {
		this.cfg = { ...DEFAULT_PAUSE_SEGMENTER_CONFIG, ...config };
	}

	/** Frames accumulated into the open segment (0 when idle). */
	get heldFrames(): number {
		return this.segmentFrames;
	}

	/**
	 * Feeds one capture block.
	 * @param block - Mono samples from the capture graph
	 * @returns A completed segment, or null when the block stayed inside one
	 */
	feed(block: Float32Array): LiveSegment | null {
		this.totalFrames += block.length;
		const level = rmsOf(block);
		if (!this.speaking) {
			if (level < this.cfg.speechRms) {
				this.pushPreRoll(block);
				return null;
			}
			// Speech starts: the segment opens with the pre-roll behind it.
			this.speaking = true;
			this.silenceFrames = 0;
			this.segmentStartFrame = this.totalFrames - block.length;
			this.segmentFrames = 0;
			this.segment = [];
			for (const pre of this.preRoll) {
				this.segment.push(pre);
				this.segmentFrames += pre.length;
			}
		}
		this.segment.push(block);
		this.segmentFrames += block.length;
		if (level < this.cfg.silenceRms) {
			this.silenceFrames += block.length;
		} else {
			this.silenceFrames = 0;
		}
		if (this.segmentFrames >= (this.cfg.maxSegmentMs / 1000) * this.cfg.sampleRate) {
			// Continuous speech: cut without waiting for a pause.
			return this.emit(this.segmentFrames);
		}
		if (this.silenceFrames >= (this.cfg.silenceMs / 1000) * this.cfg.sampleRate) {
			// The pause has lasted long enough to end the segment. Speech
			// shorter than the floor is a blip, not a sentence: it is dropped
			// here rather than held open by continuing silence.
			const speechFrames = this.segmentFrames - this.silenceFrames;
			if (speechFrames < (this.cfg.minSpeechMs / 1000) * this.cfg.sampleRate) {
				this.reset();
				return null;
			}
			return this.emit(this.segmentFrames - this.silenceFrames + 0.2 * this.cfg.sampleRate);
		}
		return null;
	}

	/**
	 * Emits whatever is held when the session ends.
	 * @returns The tail segment, or null when it is too short to recognize
	 */
	flush(): LiveSegment | null {
		const speechFrames = this.segmentFrames - this.silenceFrames;
		if (!this.speaking || speechFrames < 0.25 * this.cfg.sampleRate) {
			this.reset();
			return null;
		}
		return this.emit(this.segmentFrames);
	}

	/** Drops everything held and returns to the idle state. */
	reset(): void {
		this.segment = [];
		this.segmentFrames = 0;
		this.silenceFrames = 0;
		this.speaking = false;
		this.preRoll.length = 0;
		this.preRollFrames = 0;
	}

	/**
	 * Assembles the held blocks into one segment, keeping `keepFrames` of the
	 * audio (trailing silence beyond the small tail is trimmed) and resetting.
	 */
	private emit(keepFrames: number): LiveSegment | null {
		const kept = Math.max(0, Math.min(this.segmentFrames, Math.floor(keepFrames)));
		const out = new Float32Array(kept);
		let offset = 0;
		let remaining = kept;
		for (const block of this.segment) {
			if (remaining <= 0) {
				break;
			}
			const taking = Math.min(block.length, remaining);
			out.set(block.subarray(0, taking), offset);
			offset += taking;
			remaining -= taking;
		}
		const startFrame = this.segmentStartFrame;
		this.reset();
		return { samples: out, startFrame };
	}

	/** Keeps the newest pre-roll worth of silence blocks behind the cursor. */
	private pushPreRoll(block: Float32Array): void {
		this.preRoll.push(block);
		this.preRollFrames += block.length;
		const cap = (this.cfg.preRollMs / 1000) * this.cfg.sampleRate;
		while (this.preRollFrames > cap && this.preRoll.length > 1) {
			this.preRollFrames -= this.preRoll[0]?.length ?? 0;
			this.preRoll.shift();
		}
	}
}

/**
 * Builds the display text for one transcribed segment: the session-relative
 * timestamp of when the segment began, then the recognized text with segment
 * newlines flattened (Chinese text carries no spaces, so the join is a plain
 * space that only shows up between Latin runs).
 * @param elapsedSeconds - Seconds since the session started
 * @param text - The segment's recognized text
 * @returns One display line
 */
export function formatLiveLine(elapsedSeconds: number, text: string): string {
	const total = Math.max(0, Math.floor(elapsedSeconds));
	const mm = String(Math.floor(total / 60)).padStart(2, '0');
	const ss = String(total % 60).padStart(2, '0');
	return `[${mm}:${ss}] ${text.replace(/\s*\n\s*/g, ' ').trim()}`;
}

/**
 * The wall-clock tag a marker click appends, e.g. `【重点 · 21:05:33】`.
 * @param kind - The marker's name (重点 / 问题 / …)
 * @param now - The moment of the click
 * @returns The tag text
 */
export function formatMarkerTag(kind: string, now: Date): string {
	const hh = String(now.getHours()).padStart(2, '0');
	const mi = String(now.getMinutes()).padStart(2, '0');
	const ss = String(now.getSeconds()).padStart(2, '0');
	return `【${kind} · ${hh}:${mi}:${ss}】`;
}

/**
 * The longest common prefix of two decode results, character-wise. The
 * streaming preview splits a re-decode at this boundary: everything the last
 * two decodes agree on is stable, the tail after it is still moving.
 * @param a - The previous decode
 * @param b - The new decode
 * @returns The shared prefix ('' when either side is empty)
 */
export function longestCommonPrefix(a: string, b: string): string {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a[i] === b[i]) {
		i++;
	}
	return a.slice(0, i);
}
