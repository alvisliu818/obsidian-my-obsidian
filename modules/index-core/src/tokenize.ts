/**
 * 统一索引 · 分词（索引侧与查询侧共用同一实现）。
 *
 * 设计要点（docs/unified-index-design.md）：
 *  - FTS5 unicode61 不切 CJK（连续中文成一个 token），分词必须在应用侧完成，
 *    产出写进 items.t_* 列（= FTS external-content 的数据源）。
 *  - 中文分词优先用可选的 cm-chs-patch（外部插件）。缺席时**内置 bigram 降级**
 *    （M2-5 基准实证：整块保留的旧降级在 7.5 万 item 大库上，≥2 字查询 FTS
 *    必然落空、每次搜索都跌进 5-6s 的全表 LIKE，主线程不可用）。bigram =
 *    2 字滑窗（步长 1）+ 整词：任意 ≥2 字子串查询经窗口短语/OR 命中 FTS，
 *    单字仍靠 ≤2 字 LIKE 兜底。代价是 CJK token 量 ≈ 字数（索引变大）。
 *  - 拉丁词处理：非字母数字一律作分隔符（含连字符，无需单独拆连字符），
 *    camelCase 拆分可选（索引/查询两侧必须同开关，否则查不中）。
 */

/** cm-chs-patch 暴露的 segmenter 切片（duck typing，避免依赖其类型声明） */
export interface ChsSegmenter {
  cut: (word: string, options: { search: boolean }) => string[];
}

export interface TokenizeOptions {
  /** cm-chs-patch segmenter（可选）。缺席/不合规 = 内置 bigram 降级 */
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

/**
 * 内置 bigram 降级切分：2 字滑窗（步长 1，全偏移覆盖）+ 整词，去重。
 * 全偏移是关键——步长 2 只覆盖偶对齐，一半的长查询会 FTS 落空跌进 LIKE。
 * 窗口按序产出：FTS 相邻位置使「整词查询的窗口序列」构成短语命中。
 */
function bigramCut(word: string): string[] {
  if (word.length <= 2) return [word];
  const chunks: string[] = [];
  for (let i = 0; i + 2 <= word.length; i++) chunks.push(word.slice(i, i + 2));
  chunks.push(word);
  return [...new Set(chunks)];
}

/** 词块切分 + 可选的中文分词 / camelCase 拆分 */
function tokenize(text: string, opts: TokenizeOptions): string[] {
  const raw = text.split(TOKEN_SPLIT).filter(Boolean);
  const out: string[] = [];
  for (const word of raw) {
    if (CJK_RE.test(word)) {
      // search:true = 粒度更细的检索模式切分（含子词），索引查询两侧一致；
      // segmenter 不合规（插件实例没有 cut）同样走 bigram 降级
      const segs =
        typeof opts.chsSegmenter?.cut === "function"
          ? opts.chsSegmenter.cut(word, { search: true })
          : bigramCut(word);
      for (const seg of segs) {
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
