/**
 * 只读路径判定（isReadOnlyEntry）单测。
 *
 * 2026-11-27 起与隐藏/例外名单共用同一套语法：
 *   - 纯文本 = 名字或路径段**整段相等**（不是子串，`Notes` 不误伤 `Notes2`）；
 *   - 裸正则（含正则元字符）或 `/正则/flags`（默认 i）。
 * 旧实现是「纯文本也当正则做子串匹配、`/正则/` 的斜杠不剥」，与设置页说明不符。
 */
import { describe, expect, it } from 'vitest';
import { isReadOnlyEntry } from '../src/features/mountFilter';

describe('isReadOnlyEntry', () => {
	const patterns = ['秘密', '\\.secret', '^_odp/keep', '/\\.draft\\.md$/'];

	it('纯文本：路径段整段相等', () => {
		expect(isReadOnlyEntry('_odp/秘密/x.md', patterns)).toBe(true);
		expect(isReadOnlyEntry('秘密/x.md', patterns)).toBe(true);
		expect(isReadOnlyEntry('秘密/x.md', ['秘密'])).toBe(true);
	});

	it('纯文本不再误伤同前缀的名字（Notes / Notes2）', () => {
		expect(isReadOnlyEntry('_odp/秘密笔记/x.md', patterns)).toBe(false);
		expect(isReadOnlyEntry('Notes2/a.md', ['Notes'])).toBe(false);
		expect(isReadOnlyEntry('Notes/a.md', ['Notes'])).toBe(true);
	});

	it('裸正则：整路径/裸名/段边界，大小写不敏', () => {
		expect(isReadOnlyEntry('_odp/a.secret', patterns)).toBe(true);
		expect(isReadOnlyEntry('_odp/BIG.SECRET', patterns)).toBe(true);
		expect(isReadOnlyEntry('_odp/keep/a.md', patterns)).toBe(true);
		expect(isReadOnlyEntry('_odp/other/x.md', patterns)).toBe(false);
	});

	it('/正则/flags 形态（旧实现根本没剥斜杠）', () => {
		expect(isReadOnlyEntry('a/b.draft.md', ['/\\.draft\\.md$/'])).toBe(true);
		expect(isReadOnlyEntry('a/b.draft.md', patterns)).toBe(true);
		expect(isReadOnlyEntry('a/b.md', patterns)).toBe(false);
	});

	it('非法正则被忽略，不影响其它条目', () => {
		expect(isReadOnlyEntry('a.md', ['['])).toBe(false);
		expect(isReadOnlyEntry('a.md', ['[', 'a\\.md$'])).toBe(true);
	});

	it('无任何命中 → 可编辑；空名单 → 全部可编辑', () => {
		expect(isReadOnlyEntry('Notes/other.md', patterns)).toBe(false);
		expect(isReadOnlyEntry('秘密/x.md', [])).toBe(false);
		expect(isReadOnlyEntry('秘密/x.md', undefined)).toBe(false);
	});
});
