/**
 * headerPath 纯函数用例：面包屑段推导 + 挂载找回兜底。
 *
 * 回归背景（2026-10-29 用户报）：打开入口/老页签的 state 不带 mountPath，
 * displayPath 退成裸文件名，头部面包屑只剩「挂载名 / 文件名」，挂载内的
 * 整段子目录链全丢。修法是视图层用 matchMountFor 按最长前缀找回挂载根。
 */
import { describe, expect, it } from 'vitest';
import {
	headerPathSegments,
	headerSegmentsFor,
	isUnderMount,
	matchMountFor,
	vaultRootOf,
	vaultSegments,
	type ExternalMountLike,
} from '../src/views/headerPath';

const MOUNTS: ExternalMountLike[] = [
	{ id: '260817', path: 'E:\\HOME\\BaiduSyncdisk\\260817', label: '260817' },
	{ id: 'BaiduSyncdisk', path: 'E:\\HOME\\BaiduSyncdisk', label: '' },
	{ id: 'Code', path: 'E:\\HOME\\Code', label: '' },
];

describe('headerPathSegments', () => {
	it('由 rel 反推挂载名 + 子目录链（文件名不算段）', () => {
		const segments = headerPathSegments(
			'E:\\HOME\\BaiduSyncdisk\\260817\\13-尚硅谷大模型技术之LangGraph\\3视频-langgraph\\day02\\代码\\04-node\\06-图的流式输出.py',
			'13-尚硅谷大模型技术之LangGraph/3视频-langgraph/day02/代码/04-node/06-图的流式输出.py',
			'260817',
		);
		expect(segments.map((s) => s.label)).toEqual([
			'260817',
			'13-尚硅谷大模型技术之LangGraph',
			'3视频-langgraph',
			'day02',
			'代码',
			'04-node',
		]);
		// 每段的 abs 是逐级拼出来的磁盘路径
		expect(segments[1].abs).toBe('E:/HOME/BaiduSyncdisk/260817/13-尚硅谷大模型技术之LangGraph');
		expect(segments[5].abs).toBe(
			'E:/HOME/BaiduSyncdisk/260817/13-尚硅谷大模型技术之LangGraph/3视频-langgraph/day02/代码/04-node',
		);
	});

	it('rel 只有文件名时只剩挂载名一段', () => {
		const segments = headerPathSegments('E:\\mnt\\a.md', 'a.md', 'mnt');
		expect(segments.map((s) => s.label)).toEqual(['mnt']);
	});
});

describe('isUnderMount', () => {
	it('严格在挂载之下（分隔符/大小写/尾斜杠归一）', () => {
		expect(isUnderMount('E:\\HOME\\BaiduSyncdisk\\260817\\a.py', 'e:/home/baidusyncdisk/260817/')).toBe(true);
		expect(isUnderMount('E:\\HOME\\BaiduSyncdisk\\a.py', 'E:/HOME/BaiduSyncdisk/260817')).toBe(false);
	});

	it('挂载根本身不算「之下」', () => {
		expect(isUnderMount('E:\\HOME\\BaiduSyncdisk\\260817', 'E:\\HOME\\BaiduSyncdisk\\260817')).toBe(false);
	});

	it('空挂载根恒为 false', () => {
		expect(isUnderMount('E:\\x\\a.py', '')).toBe(false);
	});
});

describe('matchMountFor', () => {
	it('最长前缀胜出：260817 内的文件命中 260817 而不是 BaiduSyncdisk', () => {
		const m = matchMountFor(
			'E:\\HOME\\BaiduSyncdisk\\260817\\13-尚硅谷大模型技术之LangGraph\\3视频-langgraph\\day02\\代码\\04-node\\06-图的流式输出.py',
			MOUNTS,
		);
		expect(m?.path).toBe('E:\\HOME\\BaiduSyncdisk\\260817');
		expect(m?.label).toBe('260817');
	});

	it('只命中外层挂载时返回它（label 可为空串）', () => {
		const m = matchMountFor('E:\\HOME\\BaiduSyncdisk\\notes\\a.md', MOUNTS);
		expect(m?.path).toBe('E:\\HOME\\BaiduSyncdisk');
		expect(m?.label).toBe('');
	});

	it('不在任何挂载之下返回 null（视图保持原状，不误挂）', () => {
		expect(matchMountFor('D:\\elsewhere\\a.py', MOUNTS)).toBeNull();
		expect(matchMountFor('', MOUNTS)).toBeNull();
	});
});

describe('vaultSegments', () => {
	const ROOT = 'E:\\HOME\\Local\\logseq-e2e-vault';

	it('库根文件：只有「/」一段（回归：面包屑上没有根路径）', () => {
		const segments = vaultSegments(ROOT, 'E:\\HOME\\Local\\logseq-e2e-vault\\06-图的流式输出.py');
		expect(segments.map((s) => s.label)).toEqual(['/']);
		expect(segments[0].isVaultRoot).toBe(true);
		expect(segments[0].abs).toBe('E:/HOME/Local/logseq-e2e-vault');
	});

	it('库内嵌套文件：「/」+ 库内子目录链（文件名不算段）', () => {
		const segments = vaultSegments(ROOT, 'E:\\HOME\\Local\\logseq-e2e-vault\\测试目录\\04-节点\\06-图的流式输出.py');
		expect(segments.map((s) => s.label)).toEqual(['/', '测试目录', '04-节点']);
		expect(segments[1].abs).toBe('E:/HOME/Local/logseq-e2e-vault/测试目录');
		expect(segments[2].isVaultRoot).toBeUndefined();
	});

	it('库外文件返回空段', () => {
		expect(vaultSegments(ROOT, 'E:\\elsewhere\\a.py')).toEqual([]);
		expect(vaultSegments('', 'E:\\elsewhere\\a.py')).toEqual([]);
	});
});

/** headerSegmentsFor 需要的最小 App 桩：virtual-tree 挂载配置 + 库适配器。 */
function stubApp(mounts: ExternalMountLike[], vaultRoot: string): unknown {
	return {
		plugins: { plugins: { 'obsidian-virtual-tree': { settings: { externalMounts: mounts } } } },
		vault: { adapter: { basePath: vaultRoot } },
	};
}

describe('headerSegmentsFor', () => {
	const ROOT = 'E:\\HOME\\Local\\logseq-e2e-vault';

	it('库内文件（不在任何挂载下）：走「/ + 库内目录链」', () => {
		const segments = headerSegmentsFor(
			stubApp(MOUNTS, ROOT) as never,
			'E:\\HOME\\Local\\logseq-e2e-vault\\06-图的流式输出.py',
			'06-图的流式输出.py',
			'',
		);
		expect(segments.map((s) => s.label)).toEqual(['/']);
	});

	it('挂载文件仍走挂载链，首段标 isMount', () => {
		const segments = headerSegmentsFor(
			stubApp(MOUNTS, ROOT) as never,
			'E:\\HOME\\BaiduSyncdisk\\260817\\sub\\a.py',
			'sub/a.py',
			'',
		);
		expect(segments.map((s) => s.label)).toEqual(['260817', 'sub']);
		expect(segments[0].isMount).toBe(true);
	});

	it('挂载指向库内子目录时挂载优先（更具体）', () => {
		const inner: ExternalMountLike[] = [
			{ id: 'inner', path: 'E:\\HOME\\Local\\logseq-e2e-vault\\测试目录', label: '测试挂载' },
		];
		const segments = headerSegmentsFor(
			stubApp(inner, ROOT) as never,
			'E:\\HOME\\Local\\logseq-e2e-vault\\测试目录\\a.py',
			'a.py',
			'',
		);
		expect(segments.map((s) => s.label)).toEqual(['测试挂载']);
		expect(segments[0].isMount).toBe(true);
	});

	it('库根都拿不到时维持旧兜底（rel 子目录链）', () => {
		const segments = headerSegmentsFor(
			stubApp([], '') as never,
			'E:\\elsewhere\\a.py',
			'a.py',
			'',
		);
		expect(segments).toEqual([]);
	});
});

describe('vaultRootOf', () => {
	it('优先 getFullPath，兜底 basePath，并归一尾分隔符', () => {
		expect(vaultRootOf({ vault: { adapter: { basePath: 'E:\\v\\' } } } as never)).toBe('E:/v');
		expect(
			vaultRootOf({ vault: { adapter: { getFullPath: () => 'E:\\v2', basePath: 'E:\\v' } } } as never),
		).toBe('E:/v2');
		expect(vaultRootOf({ vault: {} } as never)).toBe('');
	});
});
