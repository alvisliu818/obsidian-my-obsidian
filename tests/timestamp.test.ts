import assert from 'node:assert/strict';
import test from 'node:test';
import { findMarkdownLinkTarget } from '../src/timestamp-target.ts';
import { parseTimestamp } from '../src/timestamp.ts';

test('parses minute and hour timestamps', () => {
	assert.deepEqual(parseTimestamp('#audio-timestamp=05:22'), {
		seconds: 322,
		label: '05:22',
	});
	assert.deepEqual(parseTimestamp('#audio-timestamp=01:05:30'), {
		seconds: 3930,
		label: '01:05:30',
	});
});

test('parses encoded timestamp links and rejects invalid values', () => {
	assert.equal(parseTimestamp('%23audio-timestamp%3D00%3A13')?.seconds, 13);
	assert.equal(parseTimestamp('#audio-timestamp=05:60'), null);
	assert.equal(parseTimestamp('#not-an-audio-timestamp=05:22'), null);
});

test('finds the clicked Markdown timestamp link in source mode', () => {
	const line = '[\\[00:13\\]](#audio-timestamp=00:13) Speaker: Welcome.';
	assert.equal(findMarkdownLinkTarget(line, 3), '#audio-timestamp=00:13');
	assert.equal(findMarkdownLinkTarget(line, 29), '#audio-timestamp=00:13');
	assert.equal(findMarkdownLinkTarget(line, line.length), null);
});

test('selects the correct link when a source line contains multiple links', () => {
	const line = '[Docs](https://example.com) [05:22](#audio-timestamp=05:22)';
	assert.equal(findMarkdownLinkTarget(line, 4), 'https://example.com');
	assert.equal(findMarkdownLinkTarget(line, 35), '#audio-timestamp=05:22');
});

test('maps the end of a rendered editor link back to its Markdown target', () => {
	const line = '[\\[00:55\\]](#audio-timestamp=00:55) Speaker: Test.';
	const linkEnd = line.indexOf(')');
	assert.equal(findMarkdownLinkTarget(line, linkEnd), '#audio-timestamp=00:55');
});
