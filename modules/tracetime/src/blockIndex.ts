import type { Block } from "./blocks";

export type BlockTimes = { createdAt: number; modifiedAt: number };

/**
 * 会话级历史栈容量（每种块内容一条，单文件定容 200）。
 * 与编辑器撤销栈（CM 默认 ~100 事件）同生死：文件关闭即清空。
 * 余量用于覆盖单事件动多个块的情况（粘贴、替换）；
 * 单操作超过容量的块版本在撤销时恢复不了时间戳（刷为当前时间），可接受。
 */
export const HISTORY_CAP = 200;

/**
 * 会话级“内容 → 时间戳”历史栈（内存态，LRU 定容）。
 *
 * 压栈 / 命中：新内容入栈（保留最早时间戳）；再次见到的内容挪到栈顶，
 * 时间戳照旧保留最早值。
 * 出栈：超容即从栈底逐出（Map 插入序，队头即栈底）。
 */
export function seedHistory(
	history: Map<bigint, BlockTimes>,
	blocks: { hash: bigint; createdAt: number; modifiedAt: number }[]
): void {
	for (const b of blocks) {
		const existing = history.get(b.hash);
		if (existing) {
			history.delete(b.hash);
			history.set(b.hash, existing);
		} else {
			history.set(b.hash, { createdAt: b.createdAt, modifiedAt: b.modifiedAt });
		}
	}
	while (history.size > HISTORY_CAP) {
		const oldest = history.keys().next();
		if (oldest.done) break;
		history.delete(oldest.value);
	}
}

/**
 * 有序数组块索引（MVP）。
 * 单篇 Markdown 通常只有几百个块，数组移动成本可忽略；
 * 达到几万块后再替换为 implicit treap + lazy offset。
 */
export class BlockIndex {
	blocks: Block[];

	constructor(blocks: Block[] = []) {
		this.blocks = blocks;
	}

	get count(): number {
		return this.blocks.length;
	}

	/** 与 [from, to) 相交的块，按文档顺序。 */
	queryOverlapping(from: number, to: number): Block[] {
		const all = this.blocks;
		let lo = 0;
		let hi = all.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (all[mid].to > from) hi = mid;
			else lo = mid + 1;
		}
		const result: Block[] = [];
		for (let i = lo; i < all.length && all[i].from < to; i++) {
			result.push(all[i]);
		}
		return result;
	}

	/**
	 * 用 newBlocks 替换与 [oldFrom, oldTo) 相交的旧块，
	 * 并对窗口之后的所有块批量加 delta 偏移（O(n) 简单循环，MVP 接受）。
	 * 返回被移除的旧块。
	 */
	replaceWindow(oldFrom: number, oldTo: number, newBlocks: Block[], delta: number): Block[] {
		const all = this.blocks;
		let lo = 0;
		let hi = all.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (all[mid].to > oldFrom) hi = mid;
			else lo = mid + 1;
		}
		const startIdx = lo;
		let endIdx = startIdx;
		while (endIdx < all.length && all[endIdx].from < oldTo) endIdx++;

		const removed = all.slice(startIdx, endIdx);
		all.splice(startIdx, endIdx - startIdx, ...newBlocks);

		if (delta !== 0) {
			for (let i = startIdx + newBlocks.length; i < all.length; i++) {
				all[i].from += delta;
				all[i].to += delta;
			}
		}
		return removed;
	}
}

/**
 * 块序列 reconciliation：公共前后缀 → 唯一 hash 匹配 → 历史恢复 → 等长位置对等保留身份。
 * 用于增量窗口替换和外部修改恢复（外部修改时传整个文件的块序列）。
 * 不修改 oldBlocks；直接在 newBlocks 上回迁 id / createdAt / modifiedAt。
 *
 * history（可选）：会话级“内容 → 时间戳”记忆。新块的 hash 在历史中出现过，
 * 说明内容被恢复成了某个历史状态（撤销、重做、删了又撤销、手打回原文），
 * 恢复当时的 createdAt / modifiedAt 而不是刷成现在。
 */
export function reconcileBlocks(
	oldBlocks: Block[],
	newBlocks: Block[],
	nowMin: number,
	history?: ReadonlyMap<bigint, BlockTimes>
): { blocks: Block[]; changed: boolean } {
	const carry = (o: Block, n: Block, touched: boolean) => {
		n.id = o.id;
		n.createdAt = o.createdAt;
		n.modifiedAt = touched ? nowMin : o.modifiedAt;
	};

	// 第一层：公共前缀
	let start = 0;
	while (
		start < oldBlocks.length &&
		start < newBlocks.length &&
		oldBlocks[start].hash === newBlocks[start].hash
	) {
		carry(oldBlocks[start], newBlocks[start], false);
		start++;
	}

	// 第一层：公共后缀
	let endOld = oldBlocks.length;
	let endNew = newBlocks.length;
	while (
		endOld > start &&
		endNew > start &&
		oldBlocks[endOld - 1].hash === newBlocks[endNew - 1].hash
	) {
		endOld--;
		endNew--;
		carry(oldBlocks[endOld], newBlocks[endNew], false);
	}

	const oldMid = oldBlocks.slice(start, endOld);
	const newMid = newBlocks.slice(start, endNew);
	const changed = oldMid.length > 0 || newMid.length > 0;

	if (oldMid.length > 0 && newMid.length > 0) {
		// 第二层：两侧都只出现一次的 hash 直接匹配（内容未变，可能移动了位置）
		const oldCount = new Map<bigint, number>();
		const newCount = new Map<bigint, number>();
		for (const b of oldMid) oldCount.set(b.hash, (oldCount.get(b.hash) ?? 0) + 1);
		for (const b of newMid) newCount.set(b.hash, (newCount.get(b.hash) ?? 0) + 1);

		const uniqueOld = new Map<bigint, Block>();
		for (const b of oldMid) {
			if (oldCount.get(b.hash) === 1) uniqueOld.set(b.hash, b);
		}

		const matchedOld = new Set<Block>();
		const remainingNew: Block[] = [];
		for (const n of newMid) {
			const o = newCount.get(n.hash) === 1 ? uniqueOld.get(n.hash) : undefined;
			if (o !== undefined && !matchedOld.has(o)) {
				carry(o, n, false);
				matchedOld.add(o);
			} else {
				remainingNew.push(n);
			}
		}

		// 第三层：历史恢复。内容回到某个历史状态（撤销/重做/手打回原文），
		// 恢复当时的时间戳；id 仍用新的，避免复制粘贴产生重复 id。
		const unrestored: Block[] = [];
		for (const n of remainingNew) {
			const h = history?.get(n.hash);
			if (h) {
				n.createdAt = h.createdAt;
				n.modifiedAt = h.modifiedAt;
			} else {
				unrestored.push(n);
			}
		}

		// 剩余块数量对等时按位置保留身份，仅更新 modifiedAt；
		// 数量不等时多出的块保留 parser 分配的新身份（createdAt = modifiedAt = now）。
		const remainingOld = oldMid.filter((o) => !matchedOld.has(o));
		if (unrestored.length === remainingOld.length) {
			for (let i = 0; i < unrestored.length; i++) {
				carry(remainingOld[i], unrestored[i], true);
			}
		}
	}

	return { blocks: newBlocks, changed };
}
