/**
 * 场景二 core 逻辑冒烟测试（node 运行，无测试框架依赖）。
 * 运行方式：
 *   npx esbuild tests/smoke-core.ts --bundle --platform=node --format=cjs \
 *     --outfile=node_modules/.cache/smoke.cjs && node node_modules/.cache/smoke.cjs
 */
import assert from 'node:assert/strict';
import {
	addCjkLatinSpaces,
	cleanupAiOutputArtifacts,
	removeClippedListPrefixes,
	removeExtraBlankLines,
	splitBilingualParagraphsInText,
} from '../src/core/cleanup-text';
import {
	buildDeleteFromCurrentToEnd,
	buildDeleteFromStartToCurrent,
} from '../src/core/delete-range';
import { mergeSelectionIntoList } from '../src/core/list-merge';
import { toggleChineseEnglishPunctuationOutsideFences } from '../src/core/punctuation';

let passed = 0;
function test(name: string, fn: () => void): void {
	fn();
	passed += 1;
	console.log(`  ok ${name}`);
}

// ---- removeExtraBlankLines ----
test('连续空行合并为一行', () => {
	const r = removeExtraBlankLines('a\n\n\n\nb\n\n\n');
	assert.equal(r.text, 'a\n\nb\n');
	assert.equal(r.removedLines, 4);
});

test('围栏内空行不动', () => {
	const r = removeExtraBlankLines('a\n\n```\n\n\nx\n\n```\n\n\nb');
	assert.equal(r.text, 'a\n\n```\n\n\nx\n\n```\n\nb');
});

// ---- removeClippedListPrefixes ----
test('剪藏前缀清理', () => {
	const r = removeClippedListPrefixes('- • 苹果\n1. 1. 香蕉\n- 正常项');
	assert.equal(r.text, '- 苹果\n1. 香蕉\n- 正常项');
	assert.equal(r.removedCount, 2);
});

// ---- cleanupAiOutputArtifacts ----
test('AI 残留六规则', () => {
	const src = [
		'结论<span style="display:none">隐藏</span>如下<sup>[1]</sup>^^2^^',
		'这是正文内容[1](https://example.com/a)',
		'纯文本尾巴 https://example.com/b',
		'| 列A | 列B[https://example.com/c] |',
		'---',
		'详见[^1]与[1_2]标记。',
	].join('\n');
	const r = cleanupAiOutputArtifacts(src);
	assert.ok(!r.text.includes('<sup'));
	assert.ok(!r.text.includes('^^'));
	assert.ok(!r.text.includes('display:none'));
	assert.ok(!r.text.includes('https://example.com'));
	assert.ok(!r.text.includes('[^1]'));
	assert.ok(r.text.includes('| 列A | 列B |'), `表格行保留管道符，实际:${r.text}`);
	assert.equal(r.removedDividerCount, 1);
});

// ---- 标点互转 ----
test('英转中（数字间标点保护）', () => {
	const r = toggleChineseEnglishPunctuationOutsideFences('Hello, world. Pi is 3.14, ok?');
	assert.equal(r.mode, 'en-to-zh');
	assert.equal(r.next, 'Hello， world。 Pi is 3.14， ok？');
});

test('中转英', () => {
	const r = toggleChineseEnglishPunctuationOutsideFences('你好，世界。问？！');
	assert.equal(r.mode, 'zh-to-en');
	assert.equal(r.next, '你好,世界.问?!');
});

test('围栏内标点不动（判向只看围栏外）', () => {
	const src = '说："好。"\n```\n"x, y"\n```\n';
	const r = toggleChineseEnglishPunctuationOutsideFences(src);
	assert.equal(r.mode, 'zh-to-en', '代码块内的英文逗号不参与判向');
	assert.ok(r.next.includes('"x, y"'), '代码块内容原样保留');
	assert.ok(r.next.startsWith('说:"好.'), '围栏外已转换');
});

// ---- 列表合并 ----
test('段落行转列表项 + 已列行规范化', () => {
	const src = '段落甲\n段落甲续行\n- item\n* item2';
	const r = mergeSelectionIntoList(src);
	assert.equal(
		r.text,
		'- 段落甲\n  段落甲续行\n- item\n- item2',
	);
	assert.equal(r.convertedParagraphGroups, 1);
	assert.equal(r.continuationLines, 1);
	assert.equal(r.normalizedListLines, 1);
	assert.equal(r.resultItemCount, 3);
});

test('首行有序则整体重编号', () => {
	const src = '1. 第一\n第二段\n3. 序号漂移';
	const r = mergeSelectionIntoList(src);
	assert.equal(r.isOrdered, true);
	assert.equal(r.text, '1. 第一\n2. 第二段\n3. 序号漂移');
});

// ---- 删区间 ----
test('断尾求真：从当前段落删到文末', () => {
	const src = '第一段\n\n第二段行甲\n第二段行乙\n尾部';
	// 光标在 line 2（第二段行甲）
	const r = buildDeleteFromCurrentToEnd(src, 2);
	assert.equal(r.text, '第一段\n');
	assert.equal(r.deletedLineCount, 3);
	assert.deepEqual([r.deletedFromLine, r.deletedToLine], [2, 4]);
});

test('删前段：frontmatter 保留 + 分隔线保护 + 含当前段', () => {
	const src = ['---', 'title: x', '---', '', '垃圾1', '垃圾2', '---', '', '正文第一段', '正文续行'].join('\n');
	// 光标在 line 8（正文第一段）
	const r = buildDeleteFromStartToCurrent(src, 8);
	assert.equal(r.separatorLineIndex, 6);
	assert.equal(r.text, ['---', 'title: x', '---', '', '垃圾1', '垃圾2', '---'].join('\n'));
	assert.equal(r.deletedLineCount, 3, '删除范围含当前段落末行');
});

test('删前段：无分隔线时从正文起点删', () => {
	const src = ['---', 'fm', '---', '', '垃圾A', '光标段'].join('\n');
	const r = buildDeleteFromStartToCurrent(src, 5);
	assert.equal(r.separatorLineIndex, null);
	assert.equal(r.text, ['---', 'fm', '---'].join('\n'), 'frontmatter 保留，正文起点（含空行）起全删');
});

// ---- 双语拆分 ----
test('中英混排单段拆为两段', () => {
	const src = '这是一段中文的说明文字，介绍背景与结论。This is the English version of the same paragraph, for reference.';
	const r = splitBilingualParagraphsInText(src);
	assert.equal(r.splitCount, 1);
	assert.ok(r.text.includes('\n\n'));
});

// ---- 盘古空格 ----
test('CJK 与拉丁之间补空格（URL 跳过）', () => {
	const r = addCjkLatinSpaces('使用Obsidian插件，见https://obsidian.md/help页面。');
	assert.equal(r.text, '使用 Obsidian 插件，见https://obsidian.md/help页面。');
	assert.equal(r.changedCount, 2);
});

console.log(`\n${passed} tests passed`);
