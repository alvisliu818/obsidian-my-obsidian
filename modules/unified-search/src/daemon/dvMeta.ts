/**
 * CachedMetadata 形状提取器（dataview 收编 · 解析归一，2026-11-23）。
 *
 * daemon 侧要产出 dataview parsePage 消费的 Obsidian metadataCache 成分：
 * frontmatter / frontmatterLinks / headings / links / embeds / tags /
 * sections / listItems。**只复刻形状，不复刻取值**——frontmatter 与内联
 * 字段的类型化（日期/数字/链接）全部发生在 dataview 自家的
 * parseFrontmatter / parseInlineValue（require 桥进 daemon bundle，纯 TS、
 * 无 obsidian 运行时依赖），语法与上游一字不差。这里唯一新写的语义面是
 * 「Obsidian 会怎么切这份 markdown」。
 *
 * 与 Obsidian metadataCache 的已知近似（B 方案的公开风险，见模块 NOTICE）：
 *  - YAML 用 js-yaml CORE_SCHEMA（YAML 1.2 core：日期保持字符串、无 1.1
 *    的 yes/no 布尔），与 Obsidian 的 yaml 包行为对齐；破损 YAML → 无
 *    frontmatter（Obsidian 同语义）；
 *  - 列表项续行按缩进近似（flush-left 的 lazy continuation 会被切成新段落）；
 *  - setext 标题（文字下一行 ---）按 ruling 处理；
 *  - 引用块内的列表产出 listItems 但 section 归 quote（containingListId
 *    落 -1，仅影响 ListItem.list 字段）。
 *
 * 纯逻辑：无 obsidian 依赖（js-yaml 是唯一外部依赖），vitest 直测。
 */
import * as yaml from "js-yaml";

export interface DvPos {
	start: { line: number };
	end: { line: number };
}

export interface DvHeadingCache {
	heading: string;
	level: number;
	position: DvPos;
}
export interface DvLinkCache {
	link: string;
	displayText?: string;
	position: DvPos;
}
export interface DvTagCache {
	tag: string;
	position: DvPos;
}
export interface DvListItemCache {
	position: DvPos;
	/** 父列表项的起始行号；顶层为 -1（Obsidian 语义）。 */
	parent: number;
	/** 行尾 ^block-id（dataview 用作 ListItem.blockId）。 */
	id?: string;
	/** 复选框内的字符（' ' = 未勾选；dataview 以此判 checked/completed）。 */
	task?: string;
}
export interface DvSectionCache {
	type: string;
	position: DvPos;
}
export interface DvFrontmatterLinkCache {
	link: string;
	displayText?: string;
}

/** dataview parsePage 实际消费的 CachedMetadata 子集。 */
export interface DvCachedMetadata {
	frontmatter?: Record<string, unknown>;
	frontmatterLinks: DvFrontmatterLinkCache[];
	headings: DvHeadingCache[];
	links: DvLinkCache[];
	embeds: DvLinkCache[];
	tags: DvTagCache[];
	listItems: DvListItemCache[];
	sections: DvSectionCache[];
}

const RE_FENCE = /^\s*(`{3,}|~{3,})/;
const RE_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RE_RULING = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
/** 列表项：允许块引用前缀（Obsidian 支持引用内列表；dataview 的正则同款容忍）。 */
const RE_LIST_ITEM = /^(?:>\s*)*(\s*)([-*+]|\d+[.)])(\s+(.*))?$/;
/** 列表行判定（extractCachedMetadata 与 listSpanEnd 共用）。 */
const isListItemLine = (s: string): RegExpExecArray | null => RE_LIST_ITEM.exec(s);
const RE_TASK = /^\s*\[(.)\]/;
const RE_BLOCKID = /\s\^([A-Za-z0-9][\w-]*)\s*$/;
/** 单遍链接扫描：wikilink（含 ! 嵌入）与 md link（含 ! 嵌入）。 */
const RE_LINK_SCAN =
	/(!?)\[\[([^\][]+)\]\]|(!?)\[([^\][]*)\]\(([^()]*(?:\s+"[^"]*")?[^()]*)\)/g;
/** 行内 hashtag：# 前需空白/起始/包裹符号（index-writer 的 TAG_RE 同族，加 Unicode）。 */
const RE_TAG = /(^|[\s(\[【（])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;
const RE_INLINE_CODE = /`[^`]*`/g;

interface LinkHit {
	link: string;
	display?: string;
	embed: boolean;
}

/** 从一行文本提取 wikilink / md link（不判 code 上下文——调用方负责）。 */
function extractLinksInLine(line: string): LinkHit[] {
	const hits: LinkHit[] = [];
	for (const m of line.matchAll(RE_LINK_SCAN)) {
		if (m[2] !== undefined) {
			const bar = m[2].indexOf("|");
			const link = (bar >= 0 ? m[2].slice(0, bar) : m[2]).trim();
			if (!link) continue;
			hits.push({
				link,
				display: bar >= 0 ? m[2].slice(bar + 1).trim() : undefined,
				embed: m[1] === "!",
			});
		} else if (m[5] !== undefined) {
			const target = m[5].trim().replace(/^<|>$/g, "");
			// md link 带标题："url title" ——取首个空白前段
			const link = target.split(/\s+/)[0] ?? "";
			if (!link) continue;
			hits.push({ link, display: m[4] || undefined, embed: m[3] === "!" });
		}
	}
	return hits;
}

/** frontmatter 原文里的链接（Obsidian 1.4+ frontmatterLinks 语义）。 */
function extractFrontmatterLinks(raw: string): DvFrontmatterLinkCache[] {
	return extractLinksInLine(raw)
		.filter((h) => !h.embed)
		.map((h) => ({ link: h.link, displayText: h.display }));
}

/** 纯文本行 → tags（先剥行内代码/链接/wikilink，防 [[a#b]] 与 URL 伪命中）。 */
function extractTagsInLine(line: string): string[] {
	const bare = line
		.replace(RE_INLINE_CODE, " ")
		.replace(/!?\[[^\][]*\]\([^)]*\)/g, " ")
		.replace(/!?\[\[[^\][]*\]\]/g, " ");
	const out: string[] = [];
	for (const m of bare.matchAll(RE_TAG)) {
		const tag = m[2];
		// Obsidian：纯数字不是 tag（至少含一个非数字字符）
		if (!/[^\p{N}]/u.test(tag)) continue;
		out.push("#" + tag);
	}
	return out;
}

export function extractCachedMetadata(content: string): DvCachedMetadata {
	const lines = content.split("\n");
	const n = lines.length;
	const meta: DvCachedMetadata = {
		frontmatterLinks: [],
		headings: [],
		links: [],
		embeds: [],
		tags: [],
		listItems: [],
		sections: [],
	};

	// ---- frontmatter（Obsidian 语义：sections 不含 frontmatter 区域） ----
	let idx = 0;
	if ((lines[0] ?? "").trim() === "---") {
		let close = -1;
		for (let j = 1; j < n; j++) {
			const t = lines[j].trim();
			if (t === "---" || t === "...") {
				close = j;
				break;
			}
		}
		if (close > 0) {
			const raw = lines.slice(1, close).join("\n");
			try {
				const fm = yaml.load(raw, { schema: yaml.CORE_SCHEMA }) as unknown;
				if (fm && typeof fm === "object" && !Array.isArray(fm)) {
					meta.frontmatter = fm as Record<string, unknown>;
				}
			} catch {
				/* 破损 YAML → 无 frontmatter */
			}
			meta.frontmatterLinks = extractFrontmatterLinks(raw);
			idx = close + 1;
		}
	}

	// ---- 逐行扫描 ----
	// listItems 的父链栈：按缩进回溯（indent < 当前项的最近项即父项）。
	const parentStack: { indent: number; line: number }[] = [];

	const flushParagraph = (end: number): void => {
		if (paraStart >= 0) {
			meta.sections.push({ type: "paragraph", position: { start: { line: paraStart }, end: { line: end } } });
			paraStart = -1;
		}
	};
	const flushQuote = (end: number): void => {
		if (quoteStart >= 0) {
			meta.sections.push({ type: "quote", position: { start: { line: quoteStart }, end: { line: end } } });
			quoteStart = -1;
		}
	};
	let paraStart = -1;
	let quoteStart = -1;

	while (idx < n) {
		const line = lines[idx] ?? "";

		// 围栏代码块：整段成 'code' section；内容不提 links/tags/headings
		// （Obsidian metadataCache 对围栏内容不产链接/标签）。
		const fence = RE_FENCE.exec(line);
		if (fence) {
			flushParagraph(idx - 1);
			flushQuote(idx - 1);
			const marker = fence[1];
			let close = -1;
			for (let j = idx + 1; j < n; j++) {
				if ((lines[j] ?? "").trimStart().startsWith(marker)) {
					close = j;
					break;
				}
			}
			const end = close >= 0 ? close : n - 1;
			meta.sections.push({ type: "code", position: { start: { line: idx }, end: { line: end } } });
			idx = end + 1;
			continue;
		}

		// 标题（顶格 #；引用内的 # 归 quote 内容）
		const heading = RE_HEADING.exec(line);
		if (heading) {
			flushParagraph(idx - 1);
			flushQuote(idx - 1);
			meta.sections.push({ type: "heading", position: { start: { line: idx }, end: { line: idx } } });
			meta.headings.push({
				heading: heading[2] ?? "",
				level: (heading[1] ?? "#").length,
				position: { start: { line: idx }, end: { line: idx } },
			});
			for (const tag of extractTagsInLine(line)) {
				meta.tags.push({ tag, position: { start: { line: idx }, end: { line: idx } } });
			}
			for (const hit of extractLinksInLine(line)) {
				(hit.embed ? meta.embeds : meta.links).push({ link: hit.link, displayText: hit.display, position: { start: { line: idx }, end: { line: idx } } });
			}
			idx++;
			continue;
		}

		// 分隔线（ruling）
		if (RE_RULING.test(line)) {
			flushParagraph(idx - 1);
			flushQuote(idx - 1);
			meta.sections.push({ type: "ruling", position: { start: { line: idx }, end: { line: idx } } });
			idx++;
			continue;
		}

		// 块引用行（含 callout）：连续 > 行成 quote section；内部的列表行
		// 同时产出 listItems（Obsidian 对引用内列表同样入 listItems）。
		if (/^\s*>/.test(line)) {
			flushParagraph(idx - 1);
			if (quoteStart < 0) quoteStart = idx;
			const item = isListItemLine(line);
			if (item) {
				const itemEnd = listSpanEnd(idx, item, lines, n);
				pushListItem(meta, parentStack, idx, itemEnd, item, lines);
				idx = itemEnd + 1;
				continue;
			}
			// quote 行内的 tags/links 照常提取（dataview 不跳过 quote section）
			for (const tag of extractTagsInLine(line)) {
				meta.tags.push({ tag, position: { start: { line: idx }, end: { line: idx } } });
			}
			for (const hit of extractLinksInLine(line)) {
				(hit.embed ? meta.embeds : meta.links).push({ link: hit.link, displayText: hit.display, position: { start: { line: idx }, end: { line: idx } } });
			}
			idx++;
			continue;
		}
		flushQuote(idx - 1);

		// 空行：断段落
		if (line.trim() === "") {
			flushParagraph(idx - 1);
			idx++;
			continue;
		}

		// 列表项：收集整个 list run（含嵌套项/续行/项间空行）成一个
		// 'list' section；listItems 逐项入栈算 parent。
		const item = isListItemLine(line);
		if (item) {
			flushParagraph(idx - 1);
			const runStart = idx;
			let runEnd = idx;
			let cursor = idx;
			while (cursor < n) {
				const l = lines[cursor] ?? "";
				const it = isListItemLine(l);
				if (it) {
					const spanEnd = listSpanEnd(cursor, it, lines, n);
					pushListItem(meta, parentStack, cursor, spanEnd, it, lines);
					runEnd = spanEnd;
					cursor = spanEnd + 1;
					continue;
				}
				if (l.trim() === "") {
					// 项间空行：看下一个非空行是否仍是列表内容
					let k = cursor + 1;
					while (k < n && (lines[k] ?? "").trim() === "") k++;
					if (k < n && isListItemLine(lines[k] ?? "")) {
						runEnd = k - 1;
						cursor = k;
						continue;
					}
					break;
				}
				if (RE_FENCE.test(l) || RE_HEADING.test(l) || /^\s*>/.test(l)) break;
				// 非列表非空行：若缩进深于当前栈顶项，视为最后一项的续行
				const top = parentStack.length ? parentStack[parentStack.length - 1] : null;
				const curIndent = leadingSpaces(l);
				if (top && curIndent > top.indent) {
					runEnd = cursor;
					cursor++;
					continue;
				}
				break;
			}
			meta.sections.push({ type: "list", position: { start: { line: runStart }, end: { line: runEnd } } });
			parentStack.length = 0;
			idx = runEnd + 1;
			continue;
		}

		// 普通段落行：tags/links 照提，段落组段
		if (paraStart < 0) paraStart = idx;
		for (const tag of extractTagsInLine(line)) {
			meta.tags.push({ tag, position: { start: { line: idx }, end: { line: idx } } });
		}
		for (const hit of extractLinksInLine(line)) {
			(hit.embed ? meta.embeds : meta.links).push({ link: hit.link, displayText: hit.display, position: { start: { line: idx }, end: { line: idx } } });
		}
		idx++;
	}
	flushParagraph(n - 1);
	flushQuote(n - 1);
	return meta;
}

function leadingSpaces(s: string): number {
	let i = 0;
	while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
	return i;
}

/**
 * 单个列表项的行跨度（含自身的续行；不含子项）。续行 = 紧随的非空行缩进
 * 深于该项的标记缩进且不是新列表项/结构行；空行即止。
 */
function listSpanEnd(start: number, m: RegExpExecArray, lines: string[], n: number): number {
	const indent = (m[1] ?? "").length;
	let end = start;
	for (let j = start + 1; j < n; j++) {
		const l = lines[j] ?? "";
		if (l.trim() === "") break;
		if (RE_FENCE.test(l) || RE_HEADING.test(l) || /^\s*>/.test(l)) break;
		if (isListItemLine(l)) break;
		if (leadingSpaces(l) <= indent) break;
		end = j;
	}
	return end;
}

/** 产出一个 listItems 条目并维护父链栈。 */
function pushListItem(
	meta: DvCachedMetadata,
	stack: { indent: number; line: number }[],
	line: number,
	end: number,
	m: RegExpExecArray,
	lines: string[],
): void {
	const indent = (m[1] ?? "").length;
	while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
	const parent = stack.length ? stack[stack.length - 1].line : -1;
	stack.push({ indent, line });

	const entry: DvListItemCache = {
		position: { start: { line }, end: { line: end } },
		parent,
	};

	// task：标记后紧跟 [x] 复选框 —— 取框内字符（Obsidian 语义：' ' 未勾选）
	const afterMarker = (m[4] ?? "") || "";
	const task = RE_TASK.exec(afterMarker);
	if (task) entry.task = task[1] ?? " ";

	// ^block-id：从最后一行向前找行尾块 id
	for (let j = end; j >= line; j--) {
		const bm = RE_BLOCKID.exec(lines[j] ?? "");
		if (bm) {
			entry.id = bm[1];
			break;
		}
	}

	meta.listItems.push(entry);
}
