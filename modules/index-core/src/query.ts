/**
 * 统一索引 · 查询解析与 FTS5 MATCH 编译。
 *
 * 纪律：用户输入**永不直通** MATCH——所有 token 先过分词器（剥掉一切运算符
 * 字符），再以双引号短语形式写回（内部引号转义为 ""）。因此 logseq 式的
 * 「大写一遍 + 原样一遍」双跑不再需要：MATCH 串的语法完全由编译器生成。
 *
 * M1 语法：
 *   foo bar          裸词（AND 语义，词内多分词变体 OR）
 *   "黑板报 前端"     短语（有序相邻）
 *   -foo / -"foo"    排除
 *   title:foo        限标题列
 *   tag:foo          限标签列（# 可省）
 *   path:2024        路径子串过滤（files.path）
 *   ext:md           扩展名过滤
 *   backlink:笔记    反链过滤：链接指向该目标的文档（target_item/悬空键双路）
 *   uni*             前缀（按设计仅 title/tags 列展开，content 前缀噪音大）
 */

import { hasCJK, tokenizeForSearch, type TokenizeOptions } from "./tokenize";
import { resolveKeyOf } from "./links";

export type QueryField = "title" | "tag" | "path" | "ext" | "backlink";

export interface QueryTerm {
  kind: "term" | "phrase";
  field?: QueryField;
  /** 原始片段（LIKE 兜底与高亮用） */
  text: string;
  exclude: boolean;
  /** 尾随 * （仅 kind=term） */
  prefix: boolean;
}

const FIELD_NAMES: ReadonlySet<string> = new Set(["title", "tag", "path", "ext", "backlink"]);
const FIELD_PREFIX_RE = /^([a-zA-Z]+):(.*)$/;

/** 解析查询串。宽松容错：未闭合引号视为短语开头吃到串尾；未知 field: 前缀按裸词处理 */
export function parseQuery(input: string): QueryTerm[] {
  const terms: QueryTerm[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    if (/\s/.test(input[i])) {
      i++;
      continue;
    }
    let exclude = false;
    if (input[i] === "-" || input[i] === "!") {
      exclude = true;
      i++;
      if (i >= n) break;
    }
    let field: QueryField | undefined;
    const rest = input.slice(i);
    const fm = FIELD_PREFIX_RE.exec(rest);
    if (fm && FIELD_NAMES.has(fm[1].toLowerCase())) {
      field = fm[1].toLowerCase() as QueryField;
      i += fm[1].length + 1;
      if (i >= n || /\s/.test(input[i])) {
        // 只有 field: 没有值 → 忽略该前缀
        continue;
      }
    }
    if (input[i] === '"') {
      const end = input.indexOf('"', i + 1);
      const stop = end === -1 ? n : end;
      const text = input.slice(i + 1, stop);
      i = end === -1 ? n : end + 1;
      if (text.trim()) terms.push({ kind: "phrase", field, text, exclude, prefix: false });
      continue;
    }
    // 裸词：读到下一个空白
    let j = i;
    while (j < n && !/\s/.test(input[j])) j++;
    let text = input.slice(i, j);
    i = j;
    let prefix = false;
    if (text.endsWith("*") && text.length > 1) {
      prefix = true;
      text = text.slice(0, -1);
    }
    if (text) terms.push({ kind: "term", field, text, exclude, prefix });
  }
  return terms;
}

export interface CompiledQuery {
  /** FTS5 MATCH 表达式；null = 纯过滤查询（无正/负词） */
  match: string | null;
  /** 路径子串过滤（lowercase，AND 语义） */
  pathFilters: string[];
  /** 扩展名过滤（lowercase，OR 语义） */
  extFilters: string[];
  /** 反链过滤键（resolveKeyOf 归一，lowercase，AND 语义）：命中「链接指向该键」
   *  的文档——已解析走 target_item，悬空走 resolve_key 双路（M2-4） */
  backlinkFilters: string[];
  /** LIKE 兜底触发词：短中文（≤2 字）或降级模式（无分词器）下的中文词 */
  likeTerms: string[];
  /** 全部正向词原文（LIKE 兜底的 AND 约束，保证兜底结果满足完整查询） */
  positiveTexts: string[];
  /** 全部排除词原文（LIKE 兜底的 NOT LIKE 约束） */
  excludeTexts: string[];
  /** 正向 token（高亮用，去重） */
  tokens: string[];
  /** 无 match 且无过滤（空查询） */
  isEmpty: boolean;
}

/** FTS5 引号短语：内部引号翻倍转义，运算符/括号全部失效 */
function quote(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

const ALL_COLUMNS = "t_title t_headings t_tags t_content";

/** 单个 term → 列限定的变体组；无产出返回 null */
function termToExpr(term: QueryTerm, opts: TokenizeOptions): string | null {
  const colPrefix = term.field === "title" ? "t_title" : term.field === "tag" ? "t_tags" : null;

  if (term.kind === "phrase") {
    const tokens = tokenizeForSearch(term.text, opts);
    if (!tokens.length) return null;
    const phrase = quote(tokens.join(" "));
    return colPrefix ? `${colPrefix} : ${phrase}` : phrase;
  }

  const variants = [...new Set(tokenizeForSearch(term.text, opts))];
  if (!variants.length) return null;
  if (term.prefix) {
    // 前缀仅 title/tags 列（设计决策：content 前缀噪音大）
    const pfx = variants.map((v) => `${quote(v)}*`).join(" OR ");
    return `(t_title : (${pfx}) OR t_tags : (${pfx}))`;
  }
  const body = variants.map((v) => quote(v)).join(" OR ");
  return colPrefix ? `${colPrefix} : (${body})` : `(${body})`;
}

/** 解析 + 编译一步到位 */
export function compileQuery(input: string, opts: TokenizeOptions = {}): CompiledQuery {
  const terms = parseQuery(input);
  const positives: string[] = [];
  const negatives: string[] = [];
  const pathFilters: string[] = [];
  const extFilters: string[] = [];
  const backlinkFilters: string[] = [];
  const likeTerms: string[] = [];
  const positiveTexts: string[] = [];
  const excludeTexts: string[] = [];
  const tokens: string[] = [];

  for (const term of terms) {
    if (term.field === "path") {
      if (term.text.trim()) pathFilters.push(term.text.toLowerCase());
      continue;
    }
    if (term.field === "ext") {
      const e = term.text.replace(/^\./, "").toLowerCase();
      if (e) extFilters.push(e);
      continue;
    }
    if (term.field === "backlink") {
      // 反链过滤项：键走 resolveKeyOf 归一（剥锚点/解码/小写），searcher 双路命中
      const key = resolveKeyOf(term.text);
      if (key) backlinkFilters.push(key);
      continue;
    }
    if (term.exclude) {
      const expr = termToExpr(term, opts);
      if (expr) negatives.push(expr);
      excludeTexts.push(term.text);
      continue;
    }
    const expr = termToExpr(term, opts);
    if (expr) positives.push(expr);
    positiveTexts.push(term.text);
    // LIKE 兜底触发词：中文裸词——unicode61 对「短词/降级整块」必然漏
    if (term.kind === "term" && !term.field && hasCJK(term.text)) {
      const segmented = opts.chsSegmenter != null;
      if (term.text.length <= 2 || !segmented) likeTerms.push(term.text);
    }
    tokens.push(...tokenizeForSearch(term.text, opts));
    if (term.kind === "term" && term.prefix) tokens.push(term.text);
  }

  // MATCH 组装：正向 AND，负向 NOT 左折叠
  let match: string | null = null;
  if (positives.length) match = `(${positives.join(") AND (")})`;
  for (const neg of negatives) {
    match = match ? `(${match}) NOT (${neg})` : `(${ALL_COLUMNS}) NOT (${neg})`;
  }

  return {
    match,
    pathFilters,
    extFilters,
    backlinkFilters,
    likeTerms,
    positiveTexts,
    excludeTexts,
    tokens: [...new Set(tokens)],
    isEmpty:
      match === null &&
      pathFilters.length === 0 &&
      extFilters.length === 0 &&
      backlinkFilters.length === 0,
  };
}
