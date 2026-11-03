/**
 * 单一插件 id 下的模块/软依赖解析（2026-11-03）。
 *
 * 宿主插件（obsidian-my-obsidian）上的 moduleInstance(id) 是模块间协作的
 * 正门；插件表里的 my-* 别名键已随别名机制移除。这里保留三层回落：
 * 宿主实例 → 旧 my-* 表键 → 独立版上游 id——「模块关了、独立版还在」的
 * 用户软依赖不断（如 cm-chs-patch 分词）。
 */
export function resolveHostModule(
	app: unknown,
	moduleId: string,
	...legacyIds: string[]
): any | undefined {
	const table = (
		app as { plugins?: { plugins?: Record<string, unknown> } }
	).plugins?.plugins;
	const host = table?.["obsidian-my-obsidian"] as
		| { moduleInstance?: (id: string) => unknown }
		| undefined;
	const inst = host?.moduleInstance?.(moduleId);
	if (inst !== undefined) return inst;
	for (const id of legacyIds) {
		const v = table?.[id];
		if (v !== undefined) return v;
	}
	return undefined;
}
