/**
 * dataview 页面数据的 JSON 安全层（dataview 收编 · 解析归一，2026-11-23）。
 *
 * 上游链路里 parsePage 产物经 Transferable.transferable() 后 Map/Set 仍是
 * 实例，靠 postMessage / IndexedDB 的结构化克隆过界——结构化克隆保留
 * Map/Set。dv_pages 表走 JSON 文本存储，JSON.stringify 会把 Map/Set 静默
 * 丢成 `{}`，所以这里加一层标记编解码：
 *
 *   Map  ↔ { "___dv-map": [[k, v], ...] }
 *   Set  ↔ { "___dv-set": [v, ...] }
 *
 * 编码侧输入是 transferable() 产物（DateTime/Link/Duration 已换成
 * `___transfer-type` 标记对象），解码侧产物再交回 dataview 的
 * Transferable.value() 还原——两层各管各的标记，互不重叠。
 *
 * 纯逻辑：无 obsidian / luxon 依赖，daemon 与渲染端 bundle 共用，vitest 直测。
 */

const MAP_TAG = "___dv-map";
const SET_TAG = "___dv-set";

/** Map/Set 实例 → 标记对象；嵌套递归。原始类型原样通过。 */
export function dehydrateValue(value: unknown): unknown {
	if (value instanceof Map) {
		return {
			[MAP_TAG]: [...value.entries()].map(([k, v]) => [dehydrateValue(k), dehydrateValue(v)]),
		};
	}
	if (value instanceof Set) {
		return { [SET_TAG]: [...value].map((v) => dehydrateValue(v)) };
	}
	if (Array.isArray(value)) return value.map(dehydrateValue);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = dehydrateValue(v);
		}
		return out;
	}
	return value;
}

/** 标记对象 → Map/Set 实例；嵌套递归。产物交 Transferable.value() 前调用。 */
export function hydrateValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(hydrateValue);
	if (value !== null && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		if (MAP_TAG in obj) {
			const pairs = (obj[MAP_TAG] as unknown[]).map((pair) => {
				const [k, v] = pair as unknown[];
				return [hydrateValue(k), hydrateValue(v)] as [unknown, unknown];
			});
			return new Map(pairs);
		}
		if (SET_TAG in obj) {
			return new Set((obj[SET_TAG] as unknown[]).map(hydrateValue));
		}
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj)) out[k] = hydrateValue(v);
		return out;
	}
	return value;
}
