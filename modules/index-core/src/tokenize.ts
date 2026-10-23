/**
 * 统一索引 · 分词（索引侧与查询侧共用同一实现）。
 *
 * 设计要点（docs/unified-index-design.md）：
 *  - FTS5 unicode61 不切 CJK（连续中文成一个 token），分词必须在应用侧完成，
 *    产出写进 items.t_* 列（= FTS external-content 的数据源）。
 *  - 中文分词依赖可选的 cm-chs-patch（外部插件）。缺席时降级：CJK 连续块原样
 *    保留为一个 token（整词可查，2 字子串靠查询层 LIKE 兜底）——行为对齐
 *    omnisearch 的降级路径。
 *  - 拉丁词处理：非字母数字一律作分隔符（含连字符，无需单独拆连字符），
 *    camelCase 拆分可选（索引/查询两侧必须同开关，否则查不中）。
 */

/** cm-chs-patch 暴露的 segmenter 切片（duck typing，避免依赖其类型声明） */
export interface ChsSegmenter {
  cut: (word: string, options: { search: boolean }) => string[];
}

export interface TokenizeOptions {
  /** cm-chs-patch segmenter（可选）。缺席 = 降级模式 */
  chsSegmenter?: ChsSegmenter | null;
  /** 拆 camelCase（默认关） */
  splitCamel?: boolean;
}

/** CJK 统一表意文字 + 扩展 A/兼容 + 日文假名（中英混排识别「词块里有中文」用） */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 词级分隔：字母数字/下划线以外的任何字符都是分隔符（连字符、标点、空白、全角标点） */
const TOKEN_SPLIT = /[^\p{L}\p{N}_]+/u;

/** lower→Upper 边界拆 camelCase（AAABb 拆 Aaab；全大写缩写词不硬拆） */
function camelSplit(word: string): string[] {
  const parts = word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(" ");
  return parts.length > 1 ? parts.filter(Boolean) : [];
}

/** 词块切分 + 可选的中文分词 / camelCase 拆分 */
function tokenize(text: string, opts: TokenizeOptions): string[] {
  const raw = text.split(TOKEN_SPLIT).filter(Boolean);
  const out: string[] = [];
  for (const word of raw) {
    if (opts.chsSegmenter && CJK_RE.test(word)) {
      // search:true = 粒度更细的检索模式切分（含子词），索引查询两侧一致
      for (const seg of opts.chsSegmenter.cut(word, { search: true })) {
        out.push(seg);
        if (opts.splitCamel) out.push(...camelSplit(seg));
      }
    } else {
      out.push(word);
      if (opts.splitCamel) out.push(...camelSplit(word));
    }
  }
  // 空 token 过滤即可，不去重：重复对 FTS 排序影响可忽略，省一次 Set 开销
  return out.filter(Boolean);
}

/** 索引侧分词：产出写进 items.t_* 列（FTS 数据源） */
export function tokenizeForIndexing(text: string, opts: TokenizeOptions = {}): string[] {
  return tokenize(text, opts);
}

/** 查询侧分词。返回与索引侧同款的 token 流，由查询编译器决定组合方式 */
export function tokenizeForSearch(text: string, opts: TokenizeOptions = {}): string[] {
  return tokenize(text, opts);
}

/** 一个词块是否含 CJK（决定查询侧是否需要 LIKE 兜底） */
export function hasCJK(text: string): boolean {
  return CJK_RE.test(text);
}
