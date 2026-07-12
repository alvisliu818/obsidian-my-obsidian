import assert from 'node:assert/strict';
import test from 'node:test';
import {
	extractAudioReferences,
	selectAudioBinding,
} from '../src/audio-index.ts';
import type { AudioBinding } from '../src/audio-index.ts';
import { getNavigationAction } from '../src/navigation.ts';
import { findMarkdownLinkTarget } from '../src/timestamp-target.ts';
import { parseTimestamp } from '../src/timestamp.ts';

function binding(id: string | null, path: string): AudioBinding {
	return {
		id,
		sourceLink: path,
		file: null as never,
	};
}

test('parses minute, hour, and audio alias timestamps', () => {
	assert.deepEqual(parseTimestamp('#audio-time=05:22'), {
		seconds: 322,
		label: '05:22',
		audioId: null,
	});
	assert.deepEqual(parseTimestamp('#audio-time=01:05:30&audio=PART-2'), {
		seconds: 3930,
		label: '01:05:30',
		audioId: 'part-2',
	});
});

test('parses encoded new links and rejects legacy or invalid values', () => {
	assert.equal(parseTimestamp('%23audio-time%3D00%3A13%26audio%3Dmain')?.audioId, 'main');
	assert.equal(parseTimestamp('#audio-time=05:60'), null);
	assert.equal(parseTimestamp('#audio-time=00:13&audio=invalid!'), null);
	assert.equal(parseTimestamp('#audio-timestamp=05:22'), null);
	assert.equal(parseTimestamp('#not-an-audio-time=05:22'), null);
});

test('finds the clicked Markdown audio-time link in source mode', () => {
	const line = '[\\[00:13\\]](#audio-time=00:13&audio=main) Speaker: Welcome.';
	assert.equal(findMarkdownLinkTarget(line, 3), '#audio-time=00:13&audio=main');
	assert.equal(findMarkdownLinkTarget(line, 29), '#audio-time=00:13&audio=main');
	assert.equal(findMarkdownLinkTarget(line, line.length), null);
});

test('maps the rendered editor link and external icon position to its target', () => {
	const line = '[\\[00:55\\]](#audio-time=00:55) Speaker: Test.';
	const linkEnd = line.indexOf(')');
	assert.equal(findMarkdownLinkTarget(line, linkEnd), '#audio-time=00:55');
});

test('extracts normalized audio aliases from same-line hidden comments', () => {
	const references = extractAudioReferences([
		'![[part-one.mp3]] %%audio-id: PART_1%%',
		'![[part-two.m4a]] %% audio-id: part-2 %%',
		'![[legacy.wav]]',
	].join('\n'));
	assert.deepEqual(references, [
		{ id: 'part_1', sourceLink: 'part-one.mp3' },
		{ id: 'part-2', sourceLink: 'part-two.m4a' },
		{ id: null, sourceLink: 'legacy.wav' },
	]);
});

test('selects single and explicitly aliased recordings', () => {
	const single = binding(null, 'single.mp3');
	assert.equal(selectAudioBinding([single], null).binding, single);

	const first = binding('part1', 'part1.mp3');
	const second = binding('part2', 'part2.mp3');
	assert.equal(selectAudioBinding([first, second], 'PART2').binding, second);
	assert.equal(selectAudioBinding([first, second], null).error, 'ambiguous');
	assert.equal(selectAudioBinding([first, second], 'missing').error, 'unknown');
});

test('rejects duplicate aliases without falling back', () => {
	const duplicate = [binding('main', 'one.mp3'), binding('main', 'two.mp3')];
	assert.equal(selectAudioBinding(duplicate, 'main').error, 'duplicate');
});

test('maps navigation settings without changing same-file state', () => {
	assert.equal(getNavigationAction('continue', false), 'none');
	assert.equal(getNavigationAction('pause', false), 'pause');
	assert.equal(getNavigationAction('close', false), 'close');
	assert.equal(getNavigationAction('pause', true), 'none');
	assert.equal(getNavigationAction('close', true), 'none');
});
