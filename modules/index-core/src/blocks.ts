/**
 * 统一索引 · 块级拆分解析器（M2-2，设计 §2）。
 *
 * 1 文件 = 文件级 item + N 块级 item（parent_rowid=文件 item、ord 序号）。
 * 只拆带 `id:: ` 属性行的块（既定方案）：无 id 块不产 item——文件级 item 已
 * 索引全文，全量拆块会让库内内容双份入 FTS；带 id 才拆也让 block_id 天然
 * 趋近唯一（跨文件同 id 由 writer 的 statement 级容错兜底）。
 *
 * 块边界（与 logseq 模块 BlockIndex 的约定对齐，但不抢其权威）：
 *  - md（logseq 风格）：列表项行（^\s*[-*+]\s）开块；后续非列表行缩进比块首
 *    深才归入本块；空行、下一个列表项行、缩进回退收块。嵌套列表各自成块
 *  - org：星标标题行（^\*{1,6}\s）开块，到下一个标题行收块（空行留在块内，
 *    收尾裁剪）
 *  - `id:: ^uuid` 属性行：块 id，剥前导 ^ 后存 block_id——与 links.anchor
 *    （[[页#^id]] 的 "^id"）同规归一，解析端剥 ^ 后精确匹配
 *  - Obsidian 原生行尾 `^id` token、org :PROPERTIES: 抽屉不在本解析器范围
 *    （对应块引用回退文件级解析）；代码围栏不感知（含 id:: 的围栏段会误拆，
 *    概率与代价都可接受）
 */

export interface ParsedBlock {
  /** 块首行去标记后的文本（块级 item 的 title） */
  title: string;
  /** 块内容（不含 id:: 属性行，尾部空白裁剪） */
  content: string;
  /** id:: 行提取的块 id（剥前导 ^） */
  blockId: string;
}

/** `id:: uuid` 属性行（[\s]*$ 容忍 CRLF 尾巴） */
const ID_LINE_RE = /^[\t ]*id::[ \t]*(\S+)[\s]*$/;
/** md 列表项开块 */
const MD_BLOCK_RE = /^[\t ]*[-*+][ \t]+/;
/** org 星标标题开块 */
const ORG_BLOCK_RE = /^\*{1,6}[ \t]+/;

/** 块 id 归一：剥前导 ^（`id:: ^abc` 与 `[[页#^abc]]` 两侧统一） */
export function normalizeBlockId(v: string): string {
  return v.startsWith("^") ? v.slice(1) : v;
}

/**
 * 解析一个文件的块级拆分。无 `id::` 字样的文件零成本短路返回 []；
 * 同文件重复 id 只保首个（UNIQUE 约束前置防御）。
 */
export function extractBlocks(content: string, format: "md" | "org"): ParsedBlock[] {
  if (!content.includes("id::")) return [];
  const lines = content.split("\n");
  const startRe = format === "org" ? ORG_BLOCK_RE : MD_BLOCK_RE;
  const out: ParsedBlock[] = [];
  const seen = new Set<string>();
  let start = -1; // 当前块首行下标（-1 = 块外：页属性/普通段落）
  let startIndent = 0;
  let blockId: string | null = null;
  let idLine = -1;

  const flush = (endExclusive: number) => {
    if (start !== -1 && blockId !== null && !seen.has(blockId)) {
      const body = lines
        .slice(start, endExclusive)
        .filter((_, i) => start + i !== idLine)
        .join("\n")
        .replace(/[\s]+$/, "");
      if (body.trim()) {
        seen.add(blockId);
        out.push({
          title: lines[start].replace(startRe, "").trim(),
          content: body,
          blockId,
        });
      }
    }
    start = -1;
    blockId = null;
    idLine = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (startRe.test(line)) {
      flush(i);
      start = i;
      startIndent = line.length - line.trimStart().length;
      continue;
    }
    if (start === -1) continue;
    if (!line.trim()) {
      if (format === "md") flush(i); // md 空行收块；org 空行留块内
      continue;
    }
    const im = ID_LINE_RE.exec(line);
    if (im) {
      if (blockId === null) {
        const id = normalizeBlockId(im[1]);
        if (id) blockId = id;
      }
      idLine = i;
      continue;
    }
    if (format === "md") {
      const indent = line.length - line.trimStart().length;
      // 缩进回退到块首及以内的非列表行（列表后的普通段落）不属于本块
      if (indent <= startIndent) flush(i);
    }
  }
  flush(lines.length);
  return out;
}
