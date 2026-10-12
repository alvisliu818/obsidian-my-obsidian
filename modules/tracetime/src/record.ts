import type { Block } from "./blocks";

/**
 * 持久化记录：不保存段落全文，只保存身份、hash、前后缀、长度和时间。
 * bigint 以 16 进制字符串存储——@msgpack/msgpack 默认编码器不认 bigint。
 * 块元组顺序：[idHex, order, type, hashHex, prefix, suffix, textLength, createdAtMin, modifiedAtMin]
 */
export interface FileRecord {
	version: number;
	path: string;
	updatedAt: number;
	blocks: unknown[][];
}

export function blocksToRecord(path: string, blocks: Block[]): FileRecord {
	return {
		version: 1,
		path,
		updatedAt: Date.now(),
		blocks: blocks.map((b, i) => [
			b.id.toString(16),
			i,
			b.type,
			b.hash.toString(16),
			b.prefix,
			b.suffix,
			b.to - b.from,
			b.createdAt,
			b.modifiedAt,
		]),
	};
}

export function recordToBlocks(record: FileRecord): Block[] {
	return record.blocks.map((t) => {
		const a = t as [string, number, number, string, string, string, number, number, number];
		return {
			id: BigInt(`0x${a[0]}`),
			from: 0,
			to: a[6] ?? 0,
			type: a[2],
			hash: BigInt(`0x${a[3]}`),
			prefix: a[4] ?? "",
			suffix: a[5] ?? "",
			createdAt: a[7],
			modifiedAt: a[8],
		};
	});
}
