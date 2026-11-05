/**
 * DNR 规则引擎匹配语义（对齐 Chrome declarativeNetRequest 的常用子集）。
 *
 * 规则集直接喂 ingest 的等价入口（load 读盘前的内存态）——通过 load 的目录
 * 形态不便构造，这里用 eval 期注入：DnrBlocker 的 ingest 是私有方法，测试
 * 走 (blocker as any).ingest(...) + finalize 分组，与 load 的真实路径一致。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DnrBlocker } from '../src/browser/dnrEngine';

function makeBlocker(rules: any[]): DnrBlocker {
	const b = new DnrBlocker();
	// 走真实路径：ingest + finalizeGroups（load 内部的两步）
	(b as any).ingest(rules);
	(b as any).finalizeGroups((b as any).blockGroupMap, (b as any).blockGroups);
	(b as any).finalizeGroups((b as any).allowGroupMap, (b as any).allowGroups);
	(b as any).loaded = true;
	return b;
}

const IMG = 'image';
const SCRIPT = 'script';
const MAIN = 'main_frame';

describe('DnrBlocker.shouldBlock', () => {
	it('||domain^ 锚定：域名后缀命中（含子域），路径前缀生效', () => {
		const b = makeBlocker([{ action: { type: 'block' }, condition: { urlFilter: '||ads.example.com^' } }]);
		expect(b.shouldBlock('https://ads.example.com/x.js', SCRIPT)).toBe(true);
		expect(b.shouldBlock('https://cdn.ads.example.com/y.png', IMG)).toBe(true);
		expect(b.shouldBlock('https://example.com/', MAIN)).toBe(false);
		expect(b.shouldBlock('https://notads.example.com/', SCRIPT)).toBe(false);
	});

	it('路径前缀：||d^/p 命中 /p 开头', () => {
		const b = makeBlocker([
			{ action: { type: 'block' }, condition: { urlFilter: '||cdn.test.com^/banners/' } },
		]);
		expect(b.shouldBlock('https://cdn.test.com/banners/a.png', IMG)).toBe(true);
		expect(b.shouldBlock('https://cdn.test.com/other/a.png', IMG)).toBe(false);
	});

	it('allow 例外优先于 block', () => {
		const b = makeBlocker([
			{ action: { type: 'block' }, condition: { urlFilter: '||ads.net^' } },
			{ action: { type: 'allow' }, condition: { urlFilter: '||ads.net^/good' } },
		]);
		expect(b.shouldBlock('https://ads.net/bad.js', SCRIPT)).toBe(true);
		expect(b.shouldBlock('https://ads.net/good.js', SCRIPT)).toBe(false);
	});

	it('resourceTypes 约束：类型不符不拦（v1 误杀教训）', () => {
		const b = makeBlocker([
			{ action: { type: 'block' }, condition: { urlFilter: '||t.com^', resourceTypes: ['image'] } },
		]);
		expect(b.shouldBlock('https://t.com/a.gif', IMG)).toBe(true);
		// 脚本请求同 URL 不拦——initiatorDomains + urlFilter 的规则被放大成
		// 拦一切曾是 bidianer 误杀根因
		expect(b.shouldBlock('https://t.com/a.js', SCRIPT)).toBe(false);
	});

	it('domainType thirdParty：referrer 同站不拦、跨站拦；无 referrer fail-open', () => {
		const b = makeBlocker([
			{ action: { type: 'block' }, condition: { urlFilter: '||track.io^', domainType: 'thirdParty' } },
		]);
		expect(b.shouldBlock('https://track.io/p.gif', IMG, 'https://other.com/page')).toBe(true);
		expect(b.shouldBlock('https://track.io/p.gif', IMG, 'https://www.track.io/page')).toBe(false);
		// 拿不到 referrer：fail-open 不拦
		expect(b.shouldBlock('https://track.io/p.gif', IMG)).toBe(false);
	});

	it('regexFilter：RE2 兼容子集生效；非法正则 fail-open 跳过', () => {
		const ok = makeBlocker([{ action: { type: 'block' }, condition: { regexFilter: 'banner[0-9]+\\.png' } }]);
		expect(ok.shouldBlock('https://x.com/banner123.png', IMG)).toBe(true);
		expect(ok.shouldBlock('https://x.com/banner.png', IMG)).toBe(false);
		const bad = makeBlocker([{ action: { type: 'block' }, condition: { regexFilter: '(?P<name>x)' } }]);
		expect(bad.shouldBlock('https://x.com/x', IMG)).toBe(false);
	});

	it('泛匹配（无 || 锚）按约束签名分组编译', () => {
		const b = makeBlocker([{ action: { type: 'block' }, condition: { urlFilter: '-ad-300x250.' } }]);
		expect(b.shouldBlock('https://a.com/img-ad-300x250.1.png', IMG)).toBe(true);
		expect(b.shouldBlock('https://b.com/plain.png', IMG)).toBe(false);
	});

	it('非 http(s) 协议与未加载引擎不拦', () => {
		const b = makeBlocker([{ action: { type: 'block' }, condition: { urlFilter: '||x.com^' } }]);
		expect(b.shouldBlock('file:///x.com/a.png', IMG)).toBe(false);
		const fresh = new DnrBlocker();
		expect(fresh.shouldBlock('https://x.com/a.png', IMG)).toBe(false);
	});

	it('stats 计数：blocked 累计', () => {
		const b = makeBlocker([{ action: { type: 'block' }, condition: { urlFilter: '||c.net^' } }]);
		b.shouldBlock('https://c.net/1', SCRIPT);
		b.shouldBlock('https://c.net/2', SCRIPT);
		expect(b.stats.blocked).toBe(2);
	});
});

afterEach(() => {
	// 无全局状态——每个用例独立的 DnrBlocker 实例
});
