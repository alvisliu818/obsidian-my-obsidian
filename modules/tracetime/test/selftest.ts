// 一次性自检测试：node_modules/.bin/esbuild test/selftest.ts --bundle --platform=node --format=cjs --target=es2020 --outfile=test/selftest.cjs && node test/selftest.cjs
import { hashText, xxhash64 } from "../src/hash";
import { parseBlocks, makeBlockId, BlockType } from "../src/blocks";
import { BlockIndex, HISTORY_CAP, BlockTimes, reconcileBlocks, seedHistory } from "../src/blockIndex";
import { blocksToRecord, recordToBlocks } from "../src/record";
import { formatTimestamp } from "../src/format";
import { encode, decode } from "@msgpack/msgpack";

let failures = 0;
function check(name: string, cond: boolean) {
	if (cond) console.log(`ok   ${name}`);
	else {
		console.error(`FAIL ${name}`);
		failures++;
	}
}

// --- xxHash64 官方测试向量 ---
check("xxhash64('') ", xxhash64(new Uint8Array(0)) === 0xef46db3751d8e999n);
check("xxhash64('a')", hashText("a") === 0xd24ec4f1a98c6e5bn);
check("xxhash64('abc')", hashText("abc") === 0x44bc2cf5ad770999n);

// --- 解析器 ---
const md = [
	"---",
	"title: test",
	"---",
	"",
	"# Heading",
	"",
	"First paragraph line 1.",
	"paragraph line 2.",
	"",
	"```js",
	"const a = 1;",
	"",
	"const b = 2;",
	"```",
	"",
	"- item 1",
	"- item 2",
	"",
	"| a | b |",
	"|---|---|",
	"| 1 | 2 |",
	"",
	"> [!note] callout",
	"> body",
	"",
	"Last paragraph.",
].join("\n");

const blocks = parseBlocks(md, 0, 1000, makeBlockId);
const types = blocks.map((b) => b.type);
// 大纲粒度：- item 1 / - item 2 各自成块（无需空行分隔），列表共 2 块
check("block count = 9", blocks.length === 9);
check(
	"type sequence",
	types[0] === BlockType.Frontmatter &&
		types[1] === BlockType.Heading &&
		types[2] === BlockType.Paragraph &&
		types[3] === BlockType.Code &&
		types[4] === BlockType.List &&
		types[5] === BlockType.List &&
		types[6] === BlockType.Table &&
		types[7] === BlockType.Callout &&
		types[8] === BlockType.Paragraph
);
check("offsets cover text", blocks[0].from === 0 && blocks[blocks.length - 1].to === md.length);
check("code block spans blank line", md.slice(blocks[3].from, blocks[3].to).includes("const b = 2;"));
check(
	"no overlapping blocks",
	blocks.every((b, i) => i === 0 || b.from >= blocks[i - 1].to)
);

// --- 大纲列表（Logseq md 粒度）：列表行即块，无需空行 ---
const outline = [
	"- TODO parent item",
	"\t- child item",
	"\t\t- grand child",
	"- second top item",
	"\tsoft line under second",
	"- third item",
].join("\n");
const outlineBlocks = parseBlocks(outline, 0, 1000, makeBlockId);
// 6 行 → 5 块：软行 "\tsoft line under second" 归属 "- second top item"
check("outline: 5 blocks without blank lines", outlineBlocks.length === 5 && outlineBlocks.every((b) => b.type === BlockType.List));
check(
	"outline: non-overlapping and ordered",
	outlineBlocks.every((b, i) => i === 0 || b.from >= outlineBlocks[i - 1].to)
);
check("outline: child item is its own block", outline.slice(outlineBlocks[1].from, outlineBlocks[1].to).trim() === "- child item");
check("outline: soft line stays with its item", outline.slice(outlineBlocks[3].from, outlineBlocks[3].to).includes("soft line under second"));

// 项内缩进围栏并入该项；后续列表项另起块
const itemCode = "- item with code\n\t```js\n\tconst a = 1;\n\t```\n- next item";
const itemCodeBlocks = parseBlocks(itemCode, 0, 1000, makeBlockId);
check("outline: indented fence belongs to its item", itemCodeBlocks.length === 2 && itemCode.slice(itemCodeBlocks[0].from, itemCodeBlocks[0].to).includes("const a = 1;"));

// 段落不吞掉后续列表行
const paraList = parseBlocks("plain paragraph\n- list after paragraph", 0, 1000, makeBlockId);
check("paragraph does not swallow list line", paraList.length === 2 && paraList[0].type === BlockType.Paragraph && paraList[1].type === BlockType.List);

// --- reconcile：修改中间块保留 id/createdAt，更新 modifiedAt ---
const edited = md.replace("paragraph line 2.", "paragraph line 2 CHANGED.");
const blocks2 = parseBlocks(edited, 0, 2000, makeBlockId);
const merged = reconcileBlocks(blocks, blocks2, 2000);
check("reconcile reports changed", merged.changed === true);
check("untouched block keeps id", merged.blocks[4].id === blocks[4].id);
check("untouched block keeps modifiedAt", merged.blocks[4].modifiedAt === 1000);
check("changed block keeps id", merged.blocks[2].id === blocks[2].id);
check("changed block keeps createdAt", merged.blocks[2].createdAt === 1000);
check("changed block bumps modifiedAt", merged.blocks[2].modifiedAt === 2000);

// --- reconcile：块移动后通过唯一 hash 保留身份 ---
const para = "First paragraph line 1.\nparagraph line 2.";
const last = "Last paragraph.";
const moved = md.replace(para, "TMP").replace(last, para).replace("TMP", last);
const blocks3 = parseBlocks(moved, 0, 3000, makeBlockId);
const merged3 = reconcileBlocks(blocks, blocks3, 3000);
const movedPara = merged3.blocks.find((b) => b.hash === blocks[8].hash);
check("moved block keeps id via unique hash", movedPara !== undefined && movedPara.id === blocks[8].id);

// --- BlockIndex.replaceWindow：窗口替换 + 后续块 delta 平移 ---
const idx = new BlockIndex(blocks.map((b) => ({ ...b })));
const oldFrom = blocks[2].from;
const oldTo = blocks[2].to;
const newText = "First paragraph line 1.\nparagraph line 2 CHANGED.";
const reparsed = parseBlocks(newText, oldFrom, 2000, makeBlockId);
reconcileBlocks([blocks[2]], reparsed, 2000);
const delta = newText.length - (oldTo - oldFrom);
idx.replaceWindow(oldFrom, oldTo, reparsed, delta);
check("replaceWindow count stable", idx.count === blocks.length);
check("replaceWindow shifts later blocks", idx.blocks[3].from === blocks[3].from + delta);
check("replaceWindow keeps earlier blocks", idx.blocks[1].from === blocks[1].from);
check(
	"replaceWindow new block content",
	md.length >= 0 && idx.blocks[2].hash === reparsed[0].hash
);

// --- queryOverlapping ---
const hits = idx.queryOverlapping(idx.blocks[3].from + 1, idx.blocks[3].from + 2);
check("queryOverlapping single", hits.length === 1 && hits[0].id === idx.blocks[3].id);

// --- 持久化记录：msgpack 编解码 roundtrip（bigint 以 hex 字符串存储） ---
const record = blocksToRecord("欢迎.md", blocks);
const roundtripped = recordToBlocks(decode(encode(record)) as ReturnType<typeof blocksToRecord>);
check(
	"record roundtrip preserves id/hash/times",
	roundtripped.length === blocks.length &&
		roundtripped.every((b, i) => b.id === blocks[i].id && b.hash === blocks[i].hash) &&
		roundtripped[2].createdAt === blocks[2].createdAt &&
		roundtripped[2].modifiedAt === blocks[2].modifiedAt
);
check(
	"record roundtrip preserves prefix/suffix",
	roundtripped[2].prefix === blocks[2].prefix && roundtripped[2].suffix === blocks[2].suffix
);

// --- 时间标签阶梯规则 ---
import { DEFAULT_SETTINGS } from "../src/format";
const fmt = { ...DEFAULT_SETTINGS }; // 刚刚3 / 分钟60 / 小时24 / 昨天开 / 其余关
const fmtNow = new Date(2026, 6, 20, 12, 0, 0); // 2026-07-20 12:00 本地时间
const toMin = (d: Date) => Math.floor(d.getTime() / 60000);
const f = (d: Date, s = fmt) => formatTimestamp(toMin(d), s, fmtNow);

check("format: 刚刚", f(new Date(2026, 6, 20, 11, 59)) === "刚刚");
check("format: N 分钟前", f(new Date(2026, 6, 20, 11, 30)) === "30 分钟前");
check("format: N 小时前", f(new Date(2026, 6, 20, 9, 0)) === "3 小时前");
check(
	"format: 小时档优先于今天档",
	f(new Date(2026, 6, 20, 9, 0), { ...fmt, todayTimeOnly: true }) === "3 小时前"
);
check(
	"format: 关小时档后今天显示时刻",
	f(new Date(2026, 6, 20, 9, 0), { ...fmt, hoursAgoLimit: 0, todayTimeOnly: true }) === "09:00"
);
check(
	"format: 昨天（超过 24h 落档）",
	f(new Date(2026, 6, 19, 8, 0)) === "昨天 08:00"
);
check(
	"format: N 天前",
	f(new Date(2026, 6, 15, 12, 0), { ...fmt, yesterdayWithTime: false, daysAgoLimit: 30 }) ===
		"5 天前"
);
check(
	"format: 今年 MM-DD",
	f(new Date(2026, 2, 8, 9, 0), { ...fmt, thisYearShort: true }) === "03-08"
);
check("format: 回退完整格式", f(new Date(2025, 6, 19, 8, 5)) === "2025-07-19 08:05");
check(
	"format: 自定义日期格式",
	f(new Date(2025, 6, 19, 8, 5), { ...fmt, dateFormat: "MM/DD HH:mm" }) === "07/19 08:05"
);
check(
	"format: 两位年 + 不补零月日",
	f(new Date(2025, 6, 9, 8, 5), { ...fmt, dateFormat: "YY年M月D日" }) === "25年7月9日"
);
check(
	"format: 当月第几周",
	f(new Date(2025, 6, 19, 8, 5), { ...fmt, dateFormat: "M月第W周" }) === "7月第3周"
);
check(
	"format: 关刚刚档后落档",
	f(new Date(2026, 6, 20, 11, 59), { ...fmt, justNowMinutes: 0 }) === "1 分钟前"
);

// --- 撤销恢复时间戳（会话级历史栈） ---
const history = new Map<bigint, BlockTimes>();
seedHistory(history, blocks);
const paraOriginal = "First paragraph line 1.\nparagraph line 2.";
const paraEdited = "First paragraph line 1.\nparagraph line 2 CHANGED.";
// 编辑：A → A'
const editParsed = parseBlocks(paraEdited, blocks[2].from, 2000, makeBlockId);
const r1 = reconcileBlocks([blocks[2]], editParsed, 2000, history);
check("edit bumps modifiedAt", r1.blocks[0].createdAt === 1000 && r1.blocks[0].modifiedAt === 2000);
seedHistory(history, r1.blocks);
// 撤销：A' → A（内容回到最初）
const undoParsed = parseBlocks(paraOriginal, blocks[2].from, 3000, makeBlockId);
const r2 = reconcileBlocks(r1.blocks, undoParsed, 3000, history);
check("undo restores createdAt", r2.blocks[0].createdAt === 1000);
check("undo restores modifiedAt", r2.blocks[0].modifiedAt === 1000);
// 重做：A → A'（恢复编辑时那一版的时间，而不是重做时刻）
const redoParsed = parseBlocks(paraEdited, blocks[2].from, 4000, makeBlockId);
const r3 = reconcileBlocks(r2.blocks, redoParsed, 4000, history);
check("redo restores edited version times", r3.blocks[0].modifiedAt === 2000);

// --- 历史栈：LRU 定容 + 保留最早时间戳 + 栈底逐出 ---
const stack = new Map<bigint, BlockTimes>();
const fakeBlocks = (from: number, count: number, modifiedAt: number) =>
	Array.from({ length: count }, (_, i) => ({
		hash: BigInt(from + i),
		createdAt: modifiedAt,
		modifiedAt,
	}));
seedHistory(stack, fakeBlocks(0, HISTORY_CAP, 1000));
// 重复内容不覆盖最早时间戳，但会挪到栈顶（LRU）
seedHistory(stack, fakeBlocks(0, 10, 9999));
check("history keeps earliest times", stack.get(5n)?.modifiedAt === 1000);
check("history cap respected", stack.size === HISTORY_CAP);
// 压入新内容触发栈底逐出
seedHistory(stack, fakeBlocks(HISTORY_CAP, 100, 2000));
check("history evicts from bottom", stack.size <= HISTORY_CAP && !stack.has(20n));
check("history keeps newest", stack.get(BigInt(HISTORY_CAP + 99))?.modifiedAt === 2000);
// 被 LRU 刷到栈顶的条目在容量逐出中存活（0..9 刚被刷新过）
check("history LRU refresh survives eviction", stack.has(5n));

// --- applyEditToIndex：真实 CM ChangeSet 走增量更新路径 ---
// 回归：编辑发生在文档末尾时，旧代码用正方向 mapPos 映回旧坐标会抛
// RangeError（changeset 越界），索引损坏、标签全消失
import { EditorState } from "@codemirror/state";
import { applyEditToIndex } from "../src/editApply";

const EDIT_SAMPLE = [
	"# 标题",
	"",
	"第一段文字，随便写点什么。",
	"",
	"第二段文字，也很普通。",
	"",
	"第三段，文档的结尾。",
].join("\n");

function simulateEdits(name: string, edits: { from: number; to?: number; insert: string }[], sample = EDIT_SAMPLE) {
	const simBlocks = parseBlocks(sample, 0, 100, makeBlockId);
	const simHistory = new Map<bigint, BlockTimes>();
	seedHistory(simHistory, simBlocks);
	const sim = { index: new BlockIndex(simBlocks), history: simHistory };

	let state = EditorState.create({ doc: sample });
	let now = 200;
	let threw = false;
	for (const e of edits) {
		const tr = state.update({ changes: { from: e.from, to: e.to ?? e.from, insert: e.insert } });
		state = tr.state;
		try {
			applyEditToIndex(sim, tr.startState.doc, tr.state.doc, tr.changes, now);
		} catch {
			threw = true;
		}
		now += 1;
	}
	check(`${name}: no throw`, !threw);

	const doc = state.doc;
	const bs = sim.index.blocks;
	let sound = bs.length > 0;
	for (let i = 0; i < bs.length; i++) {
		if (bs[i].from < 0 || bs[i].to > doc.length || bs[i].from >= bs[i].to) sound = false;
		if (i > 0 && bs[i].from < bs[i - 1].to) sound = false;
	}
	check(`${name}: index sound`, sound);
	// 可视范围查询（measureLabels 同款）必须查得到块
	check(`${name}: queryOverlapping hits`, sim.index.queryOverlapping(0, doc.length).length === bs.length);
}

const ep2 = EDIT_SAMPLE.indexOf("第二段");
simulateEdits("edit: middle of paragraph", [{ from: ep2 + 3, insert: "新插入的" }]);
simulateEdits("edit: new line after paragraph", [
	{ from: ep2 + "第二段文字，也很普通。".length, insert: "\n新加的一行" },
]);
simulateEdits("edit: typing burst", [
	{ from: ep2 + 3, insert: "A" },
	{ from: ep2 + 4, insert: "B" },
	{ from: ep2 + 5, insert: "C" },
]);
simulateEdits("edit: append at doc end", [{ from: EDIT_SAMPLE.length, insert: "\n\n末尾新行" }]);
simulateEdits("edit: last line content", [
	{ from: EDIT_SAMPLE.indexOf("结尾"), insert: "（改过）" },
]);
simulateEdits("edit: delete text", [{ from: ep2, to: ep2 + 4, insert: "" }]);

// --- 大纲文档（无空行分隔）：增量窗口必须停在列表行边界 ---
const OUTLINE_SAMPLE = ["- 第一个块", "- 第二个块", "- 第三个块", "- 第四个块"].join("\n");
const ob2 = OUTLINE_SAMPLE.indexOf("第二个块");
simulateEdits("outline: middle item edit", [{ from: ob2 + 2, insert: "改" }], OUTLINE_SAMPLE);
simulateEdits("outline: typing burst in middle item", [
	{ from: ob2 + 2, insert: "A" },
	{ from: ob2 + 3, insert: "B" },
], OUTLINE_SAMPLE);
simulateEdits("outline: append new item at end", [
	{ from: OUTLINE_SAMPLE.length, insert: "\n- 第五个块" },
], OUTLINE_SAMPLE);
// 大纲编辑后，每个条目仍是独立块（粒度不塌缩）
{
	const simBlocks = parseBlocks(OUTLINE_SAMPLE, 0, 100, makeBlockId);
	check("outline: four separate blocks", simBlocks.length === 4);
}

if (failures > 0) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
} else {
	console.log("all tests passed");
}
