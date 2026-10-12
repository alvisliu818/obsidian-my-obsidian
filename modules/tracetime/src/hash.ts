// xxHash64 纯 TypeScript 实现（BigInt），避免引入原生依赖。
// 只用于普通编辑路径的快速非加密 hash，不做安全用途。

const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;
const MASK = 0xffffffffffffffffn;

function rotl64(x: bigint, r: bigint): bigint {
	return ((x << r) | (x >> (64n - r))) & MASK;
}

function round(acc: bigint, input: bigint): bigint {
	acc = (acc + input * PRIME64_2) & MASK;
	acc = rotl64(acc, 31n);
	acc = (acc * PRIME64_1) & MASK;
	return acc;
}

function mergeRound(acc: bigint, val: bigint): bigint {
	acc ^= round(0n, val);
	acc = (acc * PRIME64_1 + PRIME64_4) & MASK;
	return acc;
}

export function xxhash64(data: Uint8Array, seed = 0n): bigint {
	const len = data.length;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let i = 0;
	let h: bigint;

	if (len >= 32) {
		let v1 = (seed + PRIME64_1 + PRIME64_2) & MASK;
		let v2 = (seed + PRIME64_2) & MASK;
		let v3 = seed & MASK;
		let v4 = (seed - PRIME64_1) & MASK;
		for (; i + 32 <= len; i += 32) {
			v1 = round(v1, view.getBigUint64(i, true));
			v2 = round(v2, view.getBigUint64(i + 8, true));
			v3 = round(v3, view.getBigUint64(i + 16, true));
			v4 = round(v4, view.getBigUint64(i + 24, true));
		}
		h = (rotl64(v1, 1n) + rotl64(v2, 7n) + rotl64(v3, 12n) + rotl64(v4, 18n)) & MASK;
		h = mergeRound(h, v1);
		h = mergeRound(h, v2);
		h = mergeRound(h, v3);
		h = mergeRound(h, v4);
	} else {
		h = (seed + PRIME64_5) & MASK;
	}

	h = (h + BigInt(len)) & MASK;

	while (i + 8 <= len) {
		const k1 = round(0n, view.getBigUint64(i, true));
		h ^= k1;
		h = (rotl64(h, 27n) * PRIME64_1 + PRIME64_4) & MASK;
		i += 8;
	}
	if (i + 4 <= len) {
		h ^= (BigInt(view.getUint32(i, true)) * PRIME64_1) & MASK;
		h = (rotl64(h, 23n) * PRIME64_2 + PRIME64_3) & MASK;
		i += 4;
	}
	while (i < len) {
		h ^= (BigInt(data[i]) * PRIME64_5) & MASK;
		h = (rotl64(h, 11n) * PRIME64_1) & MASK;
		i++;
	}

	h ^= h >> 33n;
	h = (h * PRIME64_2) & MASK;
	h ^= h >> 29n;
	h = (h * PRIME64_3) & MASK;
	h ^= h >> 32n;
	return h & MASK;
}

const encoder = new TextEncoder();

export function hashText(text: string): bigint {
	return xxhash64(encoder.encode(text));
}

// 标准化：压缩空白、去掉空行。用于跨偏移/跨格式的稳定匹配。
// 注意：代码块内部仅空白变化的编辑不会被识别为修改，这是设计上的取舍。
export function normalizeBlockText(raw: string): string {
	const lines = raw.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const t = line.replace(/\s+/g, " ").trim();
		if (t.length > 0) out.push(t);
	}
	return out.join("\n");
}
