/**
 * 查询时间预算(og 深度吸收④,2026-11-21):块编辑器内的 {{query}} /
 * {{query-table}} / ```prolog 查询此前在渲染路径上同步执行——重查询(万级
 * fact 基 + 复杂目标)会把渲染帧按住几百毫秒。
 *
 * deferQueryRender:占位元素立即返回进 DOM,查询体挪到宏任务执行;完成时
 * generation + 连接性双守卫后换入结果。超过 QUERY_BUDGET_MS(og 同款 80ms)
 * 的结果打 data-slow-query 标记,慢查询在 UI 上可见(样式 + 元信息)。
 */

/** 查询预算(ms):超过即标记慢查询(og 同款 80ms)。 */
export const QUERY_BUDGET_MS = 80;

/**
 * 占位 → 宏任务执行 → 结果换入。placeholder 必须已挂进 DOM(由调用方先入
 * 树);run 闭包在执行时读最新索引,完成守卫看 renderGeneration(文件切换)
 * 与 placeholder.isConnected(子树被 patch 换掉)。onDone:结果换入后回写
 * (调用方的结果缓存指向 filled——缓存仍指占位的话,下次刷新会把已分离
 * 的占位塞回 DOM,"查询执行中…"永远不消失)。
 */
export function deferQueryRender(
	host: { renderGeneration: number },
	placeholder: HTMLElement,
	run: () => HTMLElement,
	onDone?: (filled: HTMLElement) => void,
): void {
	const gen = host.renderGeneration;
	const t0 = performance.now();
	window.setTimeout(() => {
		if (host.renderGeneration !== gen) return; // stale(文件切换)
		if (!placeholder.isConnected) return; // 子树已被 patch 换掉
		const filled = run();
		const ms = performance.now() - t0;
		if (ms > QUERY_BUDGET_MS) filled.dataset.slowQuery = '1';
		placeholder.replaceWith(filled);
		onDone?.(filled);
	}, 0);
}
