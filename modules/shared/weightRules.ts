/**
 * 跨模块共享的路径权重规则（依赖-free 纯函数，无 obsidian 导入——
 * 各模块 esbuild 独立打包时按相对路径各自内联，不会拖入对方依赖树）。
 *
 * 格式：逐行 `权重:正则`（如 `10:^Important/`），路径命中第一条规则生效。
 * 消费方：md-editor 双链提示候选排序、unified-search 搜索结果加权。
 */

export interface WeightRule {
	regex: RegExp;
	weight: number;
}

/** 解析 `权重:正则` 行；非数字开头/空行/坏正则丢弃。 */
export function parseWeightRules(patterns: readonly string[] | undefined): WeightRule[] {
	const rules: WeightRule[] = [];
	for (const raw of patterns ?? []) {
		const m = /^(\d+):(.+)$/.exec(raw.trim());
		if (!m) continue;
		try {
			rules.push({ regex: new RegExp(m[2], 'i'), weight: Number(m[1]) });
		} catch {
			/* 坏正则丢弃 */
		}
	}
	return rules;
}

/** 路径的权重：第一条命中的规则生效（缺省 0）。 */
export function weightForPath(path: string, rules: readonly WeightRule[]): number {
	for (const rule of rules) if (rule.regex.test(path)) return rule.weight;
	return 0;
}

/**
 * 稳定权重重排：权重降序，同权重保持原序（FTS rank 序 / 库内顺序）。
 * 无规则时原样返回副本（不重排）。
 */
export function rankByWeight<T extends { path: string }>(
	items: readonly T[],
	rules: readonly WeightRule[],
): T[] {
	if (!rules.length) return [...items];
	return items
		.map((item, i) => ({ item, w: weightForPath(item.path, rules), i }))
		.sort((a, b) => b.w - a.w || a.i - b.i)
		.map((x) => x.item);
}
