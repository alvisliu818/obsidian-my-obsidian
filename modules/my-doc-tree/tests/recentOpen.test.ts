/**
 * 「最近打开」区段的纯逻辑。
 *
 * 重点覆盖会静默出错的几种：重复打开不刷列表、上限裁剪、扩展名大小写、
 * 无扩展名文件（Dockerfile 这类）、chip 计数排序，以及 data.json 被手改坏
 * 时的消毒。挂载解析是库外行能否再打开的关键，用真实 Windows 路径形状
 * 的用例钉住。
 */

import { describe, expect, it } from 'vitest';
import {
  RECENT_FILTER_ALL,
  RECENT_OPEN_LIMIT,
  baseNameOf,
  extChipLabel,
  extOfPath,
  filterRecentOpen,
  pushRecentOpen,
  recentExtChips,
  recentOpenFrom,
  resolveMountForAbs,
  type RecentOpenEntry,
} from '../src/panels/recentOpen';

const entry = (path: string, kind: RecentOpenEntry['kind'], at = 1): RecentOpenEntry => ({ path, kind, at });

describe('recentOpen — pushRecentOpen', () => {
  it('puts the newest first and dedupes by (kind, path)', () => {
    let list: RecentOpenEntry[] = [];
    list = pushRecentOpen(list, 'a.md', 'vault', 1);
    list = pushRecentOpen(list, 'b.md', 'vault', 2);
    list = pushRecentOpen(list, 'a.md', 'vault', 3);
    expect(list.map((e) => e.path)).toEqual(['a.md', 'b.md']);
    expect(list[0].at).toBe(3);
  });

  it('treats the same path in vault and ext as two different entries', () => {
    let list: RecentOpenEntry[] = [];
    list = pushRecentOpen(list, 'x.md', 'vault', 1);
    list = pushRecentOpen(list, 'x.md', 'ext', 2);
    expect(list).toHaveLength(2);
    expect(list[0].kind).toBe('ext');
  });

  it('only bumps the timestamp when re-opening the current head', () => {
    const list = [entry('a.md', 'vault', 1), entry('b.md', 'vault', 2)];
    const same = pushRecentOpen(list, 'a.md', 'vault', 9);
    // 同一引用：没有新数组，调用方的 saveSettings 防重入判断才成立
    expect(same).toBe(list);
    expect(same[0].at).toBe(9);
    expect(same[1].at).toBe(2);
  });

  it('caps the list at RECENT_OPEN_LIMIT, dropping the tail', () => {
    let list: RecentOpenEntry[] = [];
    for (let i = 0; i < RECENT_OPEN_LIMIT + 10; i++) {
      list = pushRecentOpen(list, `f${i}.md`, 'vault', i);
    }
    expect(list).toHaveLength(RECENT_OPEN_LIMIT);
    expect(list[0].path).toBe(`f${RECENT_OPEN_LIMIT + 9}.md`);
    expect(list[list.length - 1].path).toBe('f10.md');
  });
});

describe('recentOpen — filtering by file type', () => {
  const list = [
    entry('notes/a.md', 'vault'),
    entry('D:\\m\\b.PNG', 'ext'),
    entry('Dockerfile', 'ext'),
    entry('D:\\m\\c.png', 'ext'),
  ];

  it('returns everything for the ALL sentinel', () => {
    expect(filterRecentOpen(list, RECENT_FILTER_ALL)).toHaveLength(4);
  });

  it('matches extensions case-insensitively', () => {
    expect(filterRecentOpen(list, 'png').map((e) => e.path)).toEqual(['D:\\m\\b.PNG', 'D:\\m\\c.png']);
  });

  it('treats extension-less files as their own bucket', () => {
    expect(filterRecentOpen(list, '').map((e) => e.path)).toEqual(['Dockerfile']);
  });

  it('yields an empty list for an absent extension', () => {
    expect(filterRecentOpen(list, 'pdf')).toEqual([]);
  });
});

describe('recentOpen — ext helpers', () => {
  it('reads the extension off either path separator', () => {
    expect(extOfPath('a/b/c.md')).toBe('md');
    expect(extOfPath('D:\\m\\c.PNG')).toBe('png');
    expect(extOfPath('Dockerfile')).toBe('');
    expect(extOfPath('archive.tar.gz')).toBe('gz');
  });

  it('takes the basename off either path separator', () => {
    expect(baseNameOf('a/b/c.md')).toBe('c.md');
    expect(baseNameOf('D:\\m\\c.md')).toBe('c.md');
  });

  it('labels the no-extension bucket for chips', () => {
    expect(extChipLabel('')).toBe('无扩展名');
    expect(extChipLabel('md')).toBe('md');
  });
});

describe('recentOpen — recentExtChips', () => {
  it('orders by count desc then name asc, so common types lead', () => {
    const list = [
      entry('a.md', 'vault'),
      entry('b.md', 'vault'),
      entry('c.png', 'vault'),
      entry('Dockerfile', 'ext'),
      entry('LICENSE', 'ext'),
    ];
    // 次数相同按扩展名升序：''（无扩展名）字典序在最前
    expect(recentExtChips(list)).toEqual([
      { ext: '', count: 2 },
      { ext: 'md', count: 2 },
      { ext: 'png', count: 1 },
    ]);
  });

  it('is empty for an empty list', () => {
    expect(recentExtChips([])).toEqual([]);
  });
});

describe('recentOpen — recentOpenFrom sanitizer', () => {
  it('keeps only well-shaped entries and caps the length', () => {
    const raw = [
      { path: 'a.md', kind: 'vault', at: 5 },
      { path: '', kind: 'vault', at: 5 },
      { path: 'b.md', kind: 'nope', at: 5 },
      { path: 'c.md', kind: 'ext' },
      'garbage',
      null,
      { path: 'd.md', kind: 'ext', at: 'NaN' },
    ];
    const out = recentOpenFrom(raw);
    expect(out).toEqual([
      { path: 'a.md', kind: 'vault', at: 5 },
      { path: 'c.md', kind: 'ext', at: 0 },
      { path: 'd.md', kind: 'ext', at: 0 },
    ]);
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(recentOpenFrom(undefined)).toEqual([]);
    expect(recentOpenFrom({})).toEqual([]);
    expect(recentOpenFrom('x')).toEqual([]);
  });
});

describe('recentOpen — resolveMountForAbs', () => {
  const mounts = [
    { id: 'notes', path: 'D:\\notes', label: '' },
    { id: 'deep', path: 'E:\\a\\b', label: '' },
  ];

  it('resolves a file directly under the mount root', () => {
    const hit = resolveMountForAbs(mounts, 'D:\\notes\\x.md');
    expect(hit?.mount.id).toBe('notes');
    expect(hit?.rel).toBe('x.md');
  });

  it('resolves a nested file, with forward slashes in rel', () => {
    const hit = resolveMountForAbs(mounts, 'E:\\a\\b\\sub\\dir\\y.png');
    expect(hit?.mount.id).toBe('deep');
    expect(hit?.rel).toBe('sub/dir/y.png');
  });

  it('does not match a sibling folder sharing a name prefix', () => {
    expect(resolveMountForAbs(mounts, 'D:\\notes-old\\z.md')).toBeNull();
  });

  it('matches the mount root itself as rel "" (a mounted single file)', () => {
    const hit = resolveMountForAbs([{ id: 'f', path: 'D:\\solo.md', label: '' }], 'D:\\solo.md');
    expect(hit?.rel).toBe('');
  });

  it('is case-insensitive about drive letters and separators', () => {
    const hit = resolveMountForAbs(mounts, 'd:/NOTES/sub/x.md');
    expect(hit?.mount.id).toBe('notes');
    expect(hit?.rel).toBe('sub/x.md');
  });

  it('returns null for a path outside every mount', () => {
    expect(resolveMountForAbs(mounts, 'C:\\elsewhere\\x.md')).toBeNull();
  });
});
