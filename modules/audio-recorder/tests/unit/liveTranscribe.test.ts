/**
 * Tests for the live-transcribe pure logic: the pause segmenter's cutting
 * rules, the line and tag formatting, and the hand-rolled multipart body the
 * inference client sends.
 */

import {
	formatLiveLine,
	formatMarkerTag,
	PauseSegmenter,
} from '../../src/live/liveAudio';
import { buildMultipartBody } from '../../src/live/inferenceClient';

const RATE = 16_000;

/** A block of `seconds` at a constant level (constant c has rms c). */
function block(seconds: number, level: number): Float32Array {
	return new Float32Array(Math.round(seconds * RATE)).fill(level);
}

/** The segmenter tuned the way the controller tunes it. */
function makeSegmenter(): PauseSegmenter {
	return new PauseSegmenter();
}

describe('the pause segmenter', () => {
	it('cuts a segment one pause after speech, pre-roll included', () => {
		const segmenter = makeSegmenter();
		// 0.3 s of quiet lands in the pre-roll ring.
		for (let i = 0; i < 3; i++) {
			expect(segmenter.feed(block(0.1, 0.001))).toBeNull();
		}
		// 1.0 s of speech stays open.
		for (let i = 0; i < 10; i++) {
			expect(segmenter.feed(block(0.1, 0.02))).toBeNull();
		}
		// 0.6 s of silence is not yet the configured 0.7 s pause.
		for (let i = 0; i < 6; i++) {
			expect(segmenter.feed(block(0.1, 0.001))).toBeNull();
		}
		// The next silent block crosses the pause: the segment comes out.
		const segment = segmenter.feed(block(0.1, 0.001));
		expect(segment).not.toBeNull();
		// Kept audio: 0.3 s pre-roll + 1.0 s speech + 0.2 s silence tail.
		expect(segment!.samples.length).toBe(Math.round(1.5 * RATE));
		// The segment began where the pre-roll ended, at 0.3 s.
		expect(segment!.startFrame).toBe(Math.round(0.3 * RATE));
	});

	it('cuts continuous speech at the maximum segment length', () => {
		const segmenter = makeSegmenter();
		let segment = null;
		for (let i = 0; i < 16 && segment === null; i++) {
			segment = segmenter.feed(block(1, 0.02));
		}
		expect(segment).not.toBeNull();
		expect(segment!.samples.length).toBe(15 * RATE);
		expect(segment!.startFrame).toBe(0);
	});

	it('discards a blip too short to recognize', () => {
		const segmenter = makeSegmenter();
		for (let i = 0; i < 3; i++) {
			expect(segmenter.feed(block(0.1, 0.001))).toBeNull();
		}
		expect(segmenter.feed(block(0.3, 0.02))).toBeNull();
		// 0.6 s speech + 0.3 s pre-roll is under the 0.8 s floor: the pause
		// ends the segment and throws it away rather than recognizing it.
		for (let i = 0; i < 7; i++) {
			expect(segmenter.feed(block(0.1, 0.001))).toBeNull();
		}
		// And the segmenter is idle again: more silence stays null.
		expect(segmenter.feed(block(1, 0.001))).toBeNull();
		expect(segmenter.flush()).toBeNull();
	});

	it('flushes the open segment when the session ends', () => {
		const segmenter = makeSegmenter();
		for (let i = 0; i < 10; i++) {
			expect(segmenter.feed(block(0.1, 0.02))).toBeNull();
		}
		const segment = segmenter.flush();
		expect(segment).not.toBeNull();
		expect(segment!.samples.length).toBe(RATE);
		// After a flush the segmenter is empty.
		expect(segmenter.flush()).toBeNull();
	});
});

describe('the live line and marker tags', () => {
	it('stamps a line with the session-relative time', () => {
		expect(formatLiveLine(65, ' 你好\n世界 ')).toBe('[01:05] 你好 世界');
		expect(formatLiveLine(0, 'hi')).toBe('[00:00] hi');
	});

	it('formats a marker tag with wall-clock time', () => {
		const at = new Date(2026, 9, 17, 21, 5, 3);
		expect(formatMarkerTag('重点', at)).toBe('【重点 · 21:05:03】');
	});
});

describe('the multipart body builder', () => {
	it('carries the fields and the file bytes the server reads', () => {
		const fileBytes = new Uint8Array([1, 2, 0, 255, 13, 10, 4]);
		const { body, contentType } = buildMultipartBody(
			[
				{ name: 'response_format', value: 'verbose_json' },
				{ name: 'language', value: 'zh' },
			],
			{
				name: 'file',
				filename: 'chunk.wav',
				mime: 'audio/wav',
				data: fileBytes.buffer.slice(
					fileBytes.byteOffset,
					fileBytes.byteOffset + fileBytes.byteLength,
				),
			},
		);
		expect(contentType).toMatch(/^multipart\/form-data; boundary=----aar-live-/);
		const boundary = /boundary=(.+)$/.exec(contentType)![1];
		const text = new TextDecoder('latin1').decode(new Uint8Array(body));
		expect(text).toContain('name="response_format"');
		expect(text).toContain('verbose_json');
		expect(text).toContain('name="language"');
		expect(text).toContain('zh');
		expect(text).toContain('filename="chunk.wav"');
		expect(text).toContain('Content-Type: audio/wav');
		// The binary part survives byte for byte, CRLF pairs and all.
		const fileIndex = text.indexOf('Content-Type: audio/wav\r\n\r\n');
		const raw = new Uint8Array(body);
		const start = fileIndex + 'Content-Type: audio/wav\r\n\r\n'.length;
		for (let i = 0; i < fileBytes.length; i++) {
			expect(raw[start + i]).toBe(fileBytes[i]);
		}
		expect(text).toContain(`--${boundary}--`);
	});
});
