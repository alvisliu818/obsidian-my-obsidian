import { hashText, normalizeBlockText } from "./hash";

export enum BlockType {
	Frontmatter = 0,
	Heading = 1,
	Paragraph = 2,
	Code = 3,
	Quote = 4,
	List = 5,
	Table = 6,
	Callout = 7,
	ThematicBreak = 8,
}

export interface Block {
	id: bigint;
	from: number; // 绝对偏移（含）
	to: number; // 绝对偏移（不含）
	type: BlockType;
	hash: bigint; // xxHash64(标准化文本)
	prefix: string; // 标准化文本前 32 字符，供外部恢复
	suffix: string; // 标准化文本后 32 字符
	createdAt: number; // 分钟
	modifiedAt: number; // 分钟
}

const idBuffer = new BigUint64Array(1);

export function makeBlockId(): bigint {
	crypto.getRandomValues(idBuffer);
	return idBuffer[0];
}

const FENCE_RE = /^(```|~~~)/;
const HEADING_RE = /^#{1,6}\s/;
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
/** 列表行（大纲块边界）：标记前允许至多 3 个空白字符（含 Tab）。 */
export const LIST_RE = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/;
const CALLOUT_RE = /^>\s*\[![^\]]+\]/;

function classify(line: string): BlockType {
	const trimmed = line.trimStart();
	if (CALLOUT_RE.test(trimmed)) return BlockType.Callout;
	if (trimmed.startsWith(">")) return BlockType.Quote;
	if (LIST_RE.test(line)) return BlockType.List;
	if (trimmed.startsWith("|")) return BlockType.Table;
	return BlockType.Paragraph;
}

/**
 * 轻量行级块解析器。只解析传入的文本片段（增量窗口或全文），
 * baseOffset 为片段在文档中的起始偏移。
 *
 * 分组规则：空行是块边界；代码围栏可跨空行；frontmatter 只在文档开头识别。
 */
export function parseBlocks(
	text: string,
	baseOffset: number,
	nowMin: number,
	makeId: () => bigint
): Block[] {
	const lines = text.split("\n");
	const starts = new Array<number>(lines.length + 1);
	starts[0] = baseOffset;
	for (let k = 0; k < lines.length; k++) {
		starts[k + 1] = starts[k] + lines[k].length + 1;
	}
	const textEnd = baseOffset + text.length;

	const blocks: Block[] = [];
	const push = (startIdx: number, endIdx: number, type: BlockType) => {
		const from = starts[startIdx];
		const to = Math.min(starts[endIdx] - 1, textEnd);
		if (to <= from) return;
		const normalized = normalizeBlockText(lines.slice(startIdx, endIdx).join("\n"));
		blocks.push({
			id: makeId(),
			from,
			to,
			type,
			hash: hashText(normalized),
			prefix: normalized.slice(0, 32),
			suffix: normalized.slice(-32),
			createdAt: nowMin,
			modifiedAt: nowMin,
		});
	};

	let i = 0;

	// frontmatter：仅当窗口从文档开头开始
	if (baseOffset === 0 && lines.length > 0 && lines[0].trim() === "---") {
		let j = 1;
		while (j < lines.length && lines[j].trim() !== "---" && lines[j].trim() !== "...") j++;
		if (j < lines.length) {
			push(0, j + 1, BlockType.Frontmatter);
			i = j + 1;
		}
	}

	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "") {
			i++;
			continue;
		}
		const s = i;
		const trimmed = line.trimStart();
		let type: BlockType;

		if (FENCE_RE.test(trimmed)) {
			const fence = trimmed.slice(0, 3);
			i++;
			while (i < lines.length && !lines[i].trimStart().startsWith(fence)) i++;
			if (i < lines.length) i++; // 闭围栏行
			type = BlockType.Code;
		} else if (HEADING_RE.test(trimmed)) {
			i++;
			type = BlockType.Heading;
		} else if (HR_RE.test(line)) {
			i++;
			type = BlockType.ThematicBreak;
		} else {
			type = classify(line);
			i++;
			if (type === BlockType.Table) {
				while (i < lines.length && lines[i].trimStart().startsWith("|")) i++;
			} else if (type === BlockType.List) {
				// 大纲列表（Logseq md 粒度）：每个列表行即一个块，项间不需要空行。
				// 软行与缩进内容（缩进围栏、引用、更深段落）归属当前项，直到
				// 空行 / 下一列表行（任意缩进，LIST_RE 覆盖至 3 空格 + 标记）/ 顶格结构行。
				while (i < lines.length && lines[i].trim() !== "" && !LIST_RE.test(lines[i])) {
					const t = lines[i].trimStart();
					const atColumn0 = !/^\s/.test(lines[i]);
					if (atColumn0 && (FENCE_RE.test(t) || HEADING_RE.test(t) || HR_RE.test(lines[i]) || t.startsWith(">"))) break;
					i++;
				}
			} else {
				// 段落/引用/Callout：延续到空行，但不让段落吞掉新结构
				// （列表行同样另起块——大纲列表无需空行分隔）
				while (i < lines.length && lines[i].trim() !== "") {
					const t = lines[i].trimStart();
					if (type === BlockType.Paragraph && (FENCE_RE.test(t) || HEADING_RE.test(t) || HR_RE.test(lines[i]) || LIST_RE.test(lines[i]))) break;
					i++;
				}
			}
		}
		push(s, i, type);
	}

	return blocks;
}
