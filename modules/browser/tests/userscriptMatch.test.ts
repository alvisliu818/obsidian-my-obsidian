// 用户脚本 URL 匹配（matchPattern 模块的 safePattern/userScriptMatches）。
// 关键锚点：TM 系脚本的非标准通配 host（host 写 `**`）——标准 match pattern
// 不认，不归一的话直装条目永不命中（源侧实测 SEJ 直装副本失效）。

import { describe, expect, it } from 'vitest';
import { safePattern, userScriptMatches } from '../src/extensions/matchPattern';

describe('safePattern', () => {
	it('标准 match pattern 正常匹配', () => {
		expect(safePattern('*://example.com/*', 'https://example.com/a')).toBe(true);
		expect(safePattern('https://example.com/*', 'http://example.com/a')).toBe(false);
		expect(safePattern('*://*.example.com/*', 'https://cdn.example.com/a')).toBe(true);
		// Chrome 语义：`*.` 含裸域（example.com 本身也命中）
		expect(safePattern('*://*.example.com/*', 'https://example.com/a')).toBe(true);
	});

	it('非标准 `://**/` 归一为任意主机后命中（源侧踩坑）', () => {
		expect(safePattern('*://**/*', 'https://any.where/x')).toBe(true);
		expect(safePattern('*://**/*', 'http://127.0.0.1:8765/test.user.js')).toBe(true);
	});

	it('不匹配的域名返回 false', () => {
		expect(safePattern('*://example.com/*', 'https://other.com/')).toBe(false);
	});
});

describe('userScriptMatches', () => {
	it('matches 命中 + excludeMatches 优先排除', () => {
		const entry = {
			matches: ['*://example.com/*'],
			excludeMatches: ['*://example.com/private/*'],
		};
		expect(userScriptMatches(entry, 'https://example.com/a')).toBe(true);
		expect(userScriptMatches(entry, 'https://example.com/private/x')).toBe(false);
	});

	it('无 matches 的条目不注入', () => {
		expect(userScriptMatches({ matches: [] }, 'https://example.com/')).toBe(false);
	});
});
