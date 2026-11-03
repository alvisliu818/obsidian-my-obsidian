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
	countByType,
	formatKeyInfo,
	scanKeyInfo,
	SUMMARY_CALLOUT_PREFIX,
} from '../src/core/key-info';
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

// ---- 场景一 关键信息提炼 ----
const SAMPLE = [
	'---',
	'editor: native',
	'---',
	'',
	'# 一级标题',
	'',
	'正文里有**加粗要点**和==高亮要点==，还有 *斜体* 与 `行内代码`。',
	'',
	'## 二级标题',
	'',
	'> 这是一段引述，',
	'> 跨了两行。',
	'',
	'> [!note] 一个 callout',
	'> 也是引述块',
	'',
	'```python',
	'print("hi")',
	'```',
	'',
	'标签 #工作 和双链 [[另一篇笔记]]。',
].join('\n');

test('扫描：八类要素都认得出', () => {
	const items = scanKeyInfo(SAMPLE);
	const types = new Set(items.flatMap((i) => i.types));
	for (const t of ['heading', 'bold', 'highlight', 'italic', 'inlineCode', 'blockquote', 'tag', 'link']) {
		assert.ok(types.has(t as never), `缺少 ${t}`);
	}
});

test('扫描：同一行多个要点合并为一条', () => {
	const items = scanKeyInfo(SAMPLE);
	const line = items.find((i) => i.text.includes('加粗要点'));
	assert.ok(line, '没找到含加粗要点那条');
	assert.deepEqual(line.types.sort(), ['bold', 'highlight', 'inlineCode', 'italic']);
	assert.equal(line.text, '加粗要点；高亮要点；斜体；`行内代码`');
});

test('扫描：连续引述行合成一条，且带行号', () => {
	const items = scanKeyInfo(SAMPLE);
	const q = items.filter((i) => i.types.includes('blockquote'));
	assert.equal(q.length, 2, '应有两段引述（普通引述 + callout）');
	assert.equal(q[0].text, '这是一段引述， 跨了两行。');
	assert.equal(q[0].line, 10, '行号应是引述起始行');
	assert.ok(q[1].text.includes('一个 callout'));
});

test('扫描：代码块内部不拆出假要点', () => {
	const items = scanKeyInfo(SAMPLE);
	const code = items.filter((i) => i.types.includes('codeBlock'));
	assert.equal(code.length, 1);
	assert.equal(code[0].lang, 'python');
	// print("hi") 那行不该产生 heading/bold 之类（fence 是 16，内容行 17）
	assert.ok(!items.some((i) => i.line === 17 && i.types.some((t) => t !== 'codeBlock')));
});

test('扫描：标题行的 # 不当成标签', () => {
	const items = scanKeyInfo('# 标题一\n\n# 标题二\n');
	assert.ok(items.every((i) => i.types.includes('heading')));
	assert.ok(items.every((i) => !i.types.includes('tag')));
});

test('扫描：自家插入的摘要区块被整段跳过', () => {
	// 摘要 callout 的内容行也带 `>` 前缀（与 insertSummaryAtTop 的实际输出一致）
	const doc =
		`${SUMMARY_CALLOUT_PREFIX}：全要素摘要\n` +
		'> ## 标题（1）\n> - （第 5 行）真标题\n\n# 真标题\n';
	const items = scanKeyInfo(doc);
	assert.equal(items.length, 1, '只应剩下真正的标题');
	assert.equal(items[0].line, 4);
});

test('筛选：只留用户点名的四类（加粗/高亮/代码块/引述块）', () => {
	const items = scanKeyInfo(SAMPLE);
	const kept = items.filter((i) =>
		i.types.some((t) => ['bold', 'highlight', 'codeBlock', 'blockquote'].includes(t)),
	);
	// 筛选以「行」为单位：同一行的斜体/行内代码会跟着加粗那条一起进来，
	// 这正是「同一行多个要点合并为一条」的语义。
	assert.ok(kept.length > 0);
	assert.ok(
		kept.every((i) =>
			i.types.some((t) => ['bold', 'highlight', 'codeBlock', 'blockquote'].includes(t)),
		),
	);
	// 纯标题 / 纯标签 / 纯双链的行不该入选
	assert.ok(
		!kept.some((i) => {
			const only = i.types.length === 1 ? i.types[0] : null;
			return only === 'heading' || only === 'tag' || only === 'link';
		}),
	);
	// 标题行（纯 heading）确实被排除了
	assert.ok(!kept.some((i) => i.types.length === 1 && i.types[0] === 'heading'));
});

test('格式化：按类型分组，带行号', () => {
	const items = scanKeyInfo(SAMPLE);
	const out = formatKeyInfo(items, { types: ['heading'] });
	assert.ok(out.startsWith('## 标题（2）'), out.slice(0, 30));
	assert.ok(out.includes('- （第 5 行）一级标题'));
	assert.ok(out.includes('- （第 9 行）二级标题'));
});

test('格式化：maxLevel 限制标题层级', () => {
	const items = scanKeyInfo(SAMPLE);
	const out = formatKeyInfo(items, { types: ['heading'], maxLevel: 1 });
	assert.ok(out.includes('一级标题'));
	assert.ok(!out.includes('二级标题'));
});

test('格式化：无命中时返回空串', () => {
	assert.equal(formatKeyInfo([]), '');
	assert.equal(formatKeyInfo(scanKeyInfo('纯正文，没有任何要素。')), '');
});

test('统计：countByType 给出分类计数', () => {
	const items = scanKeyInfo(SAMPLE);
	const s = countByType(items);
	assert.ok(s.includes('标题 2'), s);
	assert.ok(s.includes('引述 2'), s);
});

console.log(`\n${passed} tests passed`);
