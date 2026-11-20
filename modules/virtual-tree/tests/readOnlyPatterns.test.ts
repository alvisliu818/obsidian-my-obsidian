/**
 * 只读路径判定（isReadOnlyEntry）单测。
 * 语义 = mountFilter 的 exclude 三查（整路径/裸名/路径段，正则子串，大小写
 * 不敏）——不是 easy-sync 的同段前缀语义。模式为原始正则（无 / 定界符）。
 */
import { describe, expect, it } from 'vitest';
import { isReadOnlyEntry } from '../src/features/mountFilter';

describe('isReadOnlyEntry', () => {
	const patterns = ['秘密', '\\.secret', '^_odp/keep'];

	it('正则子串命中整路径', () => {
		expect(isReadOnlyEntry('_odp/秘密/x.md', patterns)).toBe(true);
		expect(isReadOnlyEntry('秘密/x.md', patterns)).toBe(true);
	});

	it('裸名命中（文件名含秘密）', () => {
		expect(isReadOnlyEntry('_odp/秘密笔记/x.md', patterns)).toBe(true);
	});

	it('扩展名命中（大小写不敏）', () => {
		expect(isReadOnlyEntry('_odp/a.secret', patterns)).toBe(true);
		expect(isReadOnlyEntry('_odp/BIG.SECRET', patterns)).toBe(true);
	});

	it('锚定开头：仅该前缀只读', () => {
		expect(isReadOnlyEntry('_odp/keep/a.md', patterns)).toBe(true);
		expect(isReadOnlyEntry('_odp/other/x.md', patterns)).toBe(false);
	});

	it('无任何命中 → 可编辑', () => {
		expect(isReadOnlyEntry('Notes/other.md', patterns)).toBe(false);
	});

	it('空名单 → 全部可编辑', () => {
		expect(isReadOnlyEntry('秘密/x.md', [])).toBe(false);
		expect(isReadOnlyEntry('秘密/x.md', undefined)).toBe(false);
	});
});
