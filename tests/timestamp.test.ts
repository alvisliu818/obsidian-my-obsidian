import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePluginLanguage } from '../src/language.ts';
import {
	extractMediaReferences,
	selectMediaBinding,
} from '../src/media-index.ts';
import type { MediaBinding, MediaType } from '../src/media-index.ts';
import { getNavigationAction } from '../src/navigation.ts';
import { findMarkdownLinkTarget } from '../src/timestamp-target.ts';
import { parseTimestamp } from '../src/timestamp.ts';

function binding(id: string | null, path: string, type: MediaType): MediaBinding {
	return {
		id,
		sourceLink: path,
		type,
		file: null as never,
	};
}

test('parses audio and video timestamps with aliases', () => {
	assert.deepEqual(parseTimestamp('#audio-time=05:22'), {
		seconds: 322,
		label: '05:22',
		mediaType: 'audio',
		mediaId: null,
	});
	assert.deepEqual(parseTimestamp('#video-time=01:05:30&video=PART-2'), {
		seconds: 3930,
		label: '01:05:30',
		mediaType: 'video',
		mediaId: 'part-2',
	});
});

test('parses encoded links and rejects legacy, mismatched, or invalid values', () => {
	assert.equal(parseTimestamp('%23audio-time%3D00%3A13%26audio%3Dmain')?.mediaId, 'main');
	assert.equal(parseTimestamp('%23video-time%3D00%3A13%26video%3Ddemo')?.mediaId, 'demo');
	assert.equal(parseTimestamp('#audio-time=05:60'), null);
	assert.equal(parseTimestamp('#video-time=00:13&video=invalid!'), null);
	assert.equal(parseTimestamp('#video-time=00:13&audio=wrong')?.mediaId, null);
	assert.equal(parseTimestamp('#audio-timestamp=05:22'), null);
	assert.equal(parseTimestamp('#not-an-audio-time=05:22'), null);
});

test('finds audio and video Markdown links in source mode', () => {
	const audioLine = '[\\[00:13\\]](#audio-time=00:13&audio=main) Speaker: Welcome.';
	assert.equal(findMarkdownLinkTarget(audioLine, 3), '#audio-time=00:13&audio=main');
	assert.equal(findMarkdownLinkTarget(audioLine, 29), '#audio-time=00:13&audio=main');
	assert.equal(findMarkdownLinkTarget(audioLine, audioLine.length), null);

	const videoLine = '[\\[00:55\\]](#video-time=00:55&video=demo) Demo.';
	assert.equal(findMarkdownLinkTarget(videoLine, videoLine.indexOf(')')), '#video-time=00:55&video=demo');
});

test('extracts normalized audio and video aliases from same-line comments', () => {
	assert.deepEqual(
		extractMediaReferences([
			'![[part-one.mp3]] %%audio-id: PART_1%%',
			'![[part-two.m4a]] %% audio-id: part-2 %%',
			'![[legacy.wav]]',
		].join('\n'), 'audio'),
		[
			{ id: 'part_1', sourceLink: 'part-one.mp3', type: 'audio' },
			{ id: 'part-2', sourceLink: 'part-two.m4a', type: 'audio' },
			{ id: null, sourceLink: 'legacy.wav', type: 'audio' },
		],
	);
	assert.deepEqual(
		extractMediaReferences([
			'![[demo.mp4]] %%video-id: DEMO%%',
			'![[second.webm]] %%video-id: second%%',
		].join('\n'), 'video'),
		[
			{ id: 'demo', sourceLink: 'demo.mp4', type: 'video' },
			{ id: 'second', sourceLink: 'second.webm', type: 'video' },
		],
	);
});

test('selects single and explicitly aliased media', () => {
	const single = binding(null, 'single.mp3', 'audio');
	assert.equal(selectMediaBinding([single], null).binding, single);

	const first = binding('part1', 'part1.mp4', 'video');
	const second = binding('part2', 'part2.mp4', 'video');
	assert.equal(selectMediaBinding([first, second], 'PART2').binding, second);
	assert.equal(selectMediaBinding([first, second], null).error, 'ambiguous');
	assert.equal(selectMediaBinding([first, second], 'missing').error, 'unknown');
});

test('rejects duplicate aliases without falling back', () => {
	const duplicate = [
		binding('main', 'one.mp4', 'video'),
		binding('main', 'two.mp4', 'video'),
	];
	assert.equal(selectMediaBinding(duplicate, 'main').error, 'duplicate');
});

test('maps navigation settings without changing same-file state', () => {
	assert.equal(getNavigationAction('continue', false), 'none');
	assert.equal(getNavigationAction('pause', false), 'pause');
	assert.equal(getNavigationAction('close', false), 'close');
	assert.equal(getNavigationAction('pause', true), 'none');
	assert.equal(getNavigationAction('close', true), 'none');
});

test('follows Chinese Obsidian locales and falls back to English for others', () => {
	assert.equal(resolvePluginLanguage('auto', 'zh-cn'), 'zh-CN');
	assert.equal(resolvePluginLanguage('auto', 'zh-tw'), 'zh-CN');
	assert.equal(resolvePluginLanguage('auto', 'ja'), 'en');
	assert.equal(resolvePluginLanguage('auto', 'de'), 'en');
	assert.equal(resolvePluginLanguage('zh-CN', 'en'), 'zh-CN');
	assert.equal(resolvePluginLanguage('en', 'zh-cn'), 'en');
});
