/**
 * 块引用（((uuid))）正则的单一出处。
 *
 * 三处消费方（index/fileFacts、features/links、features/prologFacts）此前各自
 * 手写同一正则——其中 fileFacts 的变体多吞一个尾随 `}`（facts 提取要容忍
 * embed 闭合括号），其余两处精确匹配。语义差异**有意保留**：这里只归一共享
 * 的 UUID 捕获体，两种变体分别导出并注明用途，防再漂移。
 */

/** ((uuid)) 的内层捕获体：8-4-4-4-12 hex。 */
export const BLOCK_UUID_BODY =
	'([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';

/** 精确变体：((uuid)) 恰好闭合（补全/链接上下文用）。 */
export const BLOCK_REF_RE = new RegExp(`\\(\\(${BLOCK_UUID_BODY}\\)\\)`, 'g');

/** 容忍尾随 `}` 的变体（facts 提取：((uuid))} 的 } 属于 embed 括号,不属于 id）。 */
export const BLOCK_REF_OPT_BRACE_RE = new RegExp(`\\(\\(${BLOCK_UUID_BODY}\\)\\)\\}?`, 'g');
