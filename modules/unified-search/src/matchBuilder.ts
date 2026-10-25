/**
 * 用户查询 → 守护进程 blocks_fts 的 FTS5 MATCH 表达式。
 *
 * 安全纪律：用户输入**永不直通** MATCH——每个 term/phrase 以双引号短语形式
 * 写回（内部引号转义 ""），表达式完全由本模块拼装，FTS5 语法面受控。
 * trigram tokenizer：子串命中，中文毫秒级；<3 字符的 term trigram 命中不了
 * （FTS5 的物理限制），照发不误（空结果，不炸）。
 *
 * 字段算符的落地（daemon 的 blocks_fts 只有 bkey/path/text 三列）：
 *   path:x / ext:md   → 客户端后置过滤（命中行的 path）
 *   tag:x             → 文本 term "#x"（logseq 标签在块文本里就是 #x）
 *   backlink:x        → daemon backlinksTo 查源路径集合，客户端过滤
 *   title:x           → 降级为文本 term（daemon 无独立标题列）
 *   uni*              → 去尾 * 按子串查（trigram 无前缀语义）
 */
import { parseQuery, type QueryTerm } from "../../index-core/src/query";

export interface MatchPlan {
	/** FTS5 MATCH 表达式；空串 = 无正项（纯排除），调用方直接不查 */
	match: string;
	/** 正项裸词（未引用）。trigram 只能匹配 ≥3 字符——有更短的就用 LIKE 路径 */
	positive: string[];
	/** 排除项裸词（LIKE 路径客户端过滤用） */
	negative: string[];
	/** path: 子串过滤（小写） */
	pathSubs: string[];
	/** ext: 扩展名（小写，不带点） */
	exts: string[];
	/** backlink: 页名（小写） */
	backlinkPages: string[];
	/** 高亮 tokens（原词） */
	tokens: string[];
}

export function buildMatchPlan(input: string): MatchPlan {
	const terms = parseQuery(input) as QueryTerm[];
	const positive: string[] = [];
	const negative: string[] = [];
	const plan: MatchPlan = {
		match: "", positive: [], negative: [], pathSubs: [], exts: [], backlinkPages: [], tokens: [],
	};
	const quote = (t: string): string => '"' + t.replace(/"/g, '""') + '"';
	for (const t of terms) {
		if (t.field === "path") {
			plan.pathSubs.push(t.text.toLowerCase());
			continue;
		}
		if (t.field === "ext") {
			plan.exts.push(t.text.toLowerCase().replace(/^\./, ""));
			continue;
		}
		if (t.field === "backlink") {
			plan.backlinkPages.push(t.text.toLowerCase());
			continue;
		}
		const text = t.field === "tag" ? (t.text.startsWith("#") ? t.text : "#" + t.text) : t.text;
		// uni* → uni（去尾 *；trigram 下就是普通子串语义）
		plan.tokens.push(t.prefix && text.length > 1 ? text.slice(0, -1) : text);
		(t.exclude ? negative : positive).push(text);
	}
	plan.positive = positive;
	plan.negative = negative;
	// FTS5 的 NOT 是二元运算符：正项 AND 连接，排除项用二目 NOT 追加在尾部
	// （((pos NOT neg1) NOT neg2)…）。没有正项时无法表达纯排除 → 不查。
	if (positive.length) {
		plan.match =
			positive.map(quote).join(" AND ") + negative.map((n) => " NOT " + quote(n)).join("");
	}
	return plan;
}
