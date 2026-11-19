/**
 * 按宿主对象（view / plugin）键控的会话状态工厂——两个同型 WeakMap 手写
 * 模式（blockBacklinks.expandedByView / pageReferences.collapsedByView）的
 * 统一出处。WeakMap 键控：宿主被 GC 时状态随之回收,无泄漏。
 */

/** 惰性创建的 per-key 会话状态。init 缺席时调用方自行 set（见 set）。 */
export interface PerViewState<K extends object, V> {
	/** 取该 key 的状态;不存在时用 init（或调用方先 set）创建。 */
	get(key: K): V;
	/** 显式写入（init 缺席的用法）。 */
	set(key: K, value: V): void;
	/** 该 key 是否已有状态。 */
	has(key: K): boolean;
	/** 删除该 key 的状态（会话重置）。 */
	delete(key: K): void;
}

export function perViewState<K extends object, V>(
	init?: (key: K) => V,
): PerViewState<K, V> {
	const map = new WeakMap<K, V>();
	return {
		get(key: K): V {
			let v = map.get(key);
			if (v === undefined) {
				v = init ? init(key) : (undefined as unknown as V);
				if (v !== undefined) map.set(key, v);
			}
			return v as V;
		},
		set(key: K, value: V): void {
			map.set(key, value);
		},
		has(key: K): boolean {
			return map.has(key);
		},
		delete(key: K): void {
			map.delete(key);
		},
	};
}
