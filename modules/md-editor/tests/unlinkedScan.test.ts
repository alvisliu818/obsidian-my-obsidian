/**
 * Unlinked-mention scan: correctness first, speed second.
 *
 * The scan now prunes candidates with per-file 128-bit character signatures
 * instead of walking every block (see BlockIndex.unlinkedMentions). A bug in
 * the signature would silently DROP results, so every case here is checked
 * against a naive oracle that does the obvious full walk with a substring
 * test. Anything the optimizer changes, must not change these answers.
 */

import { describe, expect, it, vi } from 'vitest';
import { BlockIndex } from '../src/index/blockIndex';
import type { App, TFile } from 'obsidian';

type Handler = (file: unknown, old?: string) => void;

function fakeVault(files: Record<string, string>) {
  const handlers: Record<string, Handler[]> = {};
  const asFile = (path: string) => ({
    path,
    extension: 'md',
    basename: path.replace(/^.*\//, '').replace(/\.md$/, ''),
  });
  return {
    files,
    handlers,
    app: {
      vault: {
        getMarkdownFiles: () => Object.keys(files).map(asFile) as unknown as TFile[],
        getAbstractFileByPath: (p: string) => (p in files ? asFile(p) : null),
        cachedRead: async (f: TFile) => {
          if (!(f.path in files)) throw new Error('missing: ' + f.path);
          return files[f.path];
        },
        on: (name: string, cb: Handler) => {
          (handlers[name] ??= []).push(cb);
          return { __handler: name };
        },
      },
    } as unknown as App,
    fire(name: string, path: string, oldPath?: string) {
      for (const cb of handlers[name] ?? []) cb(asFile(path), oldPath);
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The obvious implementation: walk every block, test every one. */
function oracle(idx: BlockIndex, title: string, currentPath: string): string[] {
  const q = title.trim().toLowerCase();
  if (q.length < 3) return [];
  const self = currentPath.toLowerCase();
  const out: string[] = [];
  for (const b of idx.allBlocks()) {
    const lower = b.text.toLowerCase();
    if (!lower.includes(q)) continue;
    if (b.path.toLowerCase() === self) continue;
    if (b.links.some((l) => l.toLowerCase() === q)) continue;
    out.push(`${b.path}|${b.blockId}|${lower.split(q).length - 1}`);
  }
  return out.sort();
}

const scan = (idx: BlockIndex, title: string, currentPath: string, max = 10000) =>
  idx
    .unlinkedMentions(title, currentPath, max)
    .map((h) => `${h.entry.path}|${h.entry.blockId}|${h.count}`)
    .sort();

const VAULT: Record<string, string> = {
  'notes/机器.md': '- 提到了 机器学习 这个方向\n- 另一条 机器学习 和 机器学习 再一次\n',
  'notes/book.md': '- speak about 机器学习\n- plain line\n- Machine Learning Mixed CASE studies\n',
  'notes/linked.md': '- mentions [[机器学习]] here\n- and 机器学习 too, but already linked\n',
  'notes/repeat.md': '- aaaaaa\n- 哈哈哈哈哈\n- ABAbaba\n',
  'notes/self.md': '- 机器学习 appears on its own page\n',
};

describe('unlinked scan matches the naive oracle', () => {
  it('agrees for every kind of title', async () => {
    const idx = new BlockIndex(fakeVault({ ...VAULT }).app);
    await idx.buildAll();

    const titles = ['机器学习', 'machine learning', 'MACHINE LEARNING', '机器学习 X', 'aaaaaa', '哈哈'];
    for (const title of titles) {
      for (const cur of ['notes/self.md', 'notes/机器.md', 'notes/nothing.md']) {
        expect(scan(idx, title, cur), `title="${title}" from ${cur}`).toEqual(oracle(idx, title, cur));
      }
    }
  });

  it('excludes the current page itself and already-linked blocks', async () => {
    const idx = new BlockIndex(fakeVault({ ...VAULT }).app);
    await idx.buildAll();

    const fromSelf = await idx.unlinkedMentions('机器学习', 'notes/self.md', 100);
    expect(fromSelf.some((h) => h.entry.path === 'notes/self.md')).toBe(false);
    // linked.md has TWO blocks mentioning the title: the one that also links
    // it drops out, the plain-text one must survive — per block, not per file.
    const rows = idx.unlinkedMentions('机器学习', 'notes/nothing.md', 100).filter((h) => h.entry.path === 'notes/linked.md');
    expect(rows.length).toBe(1);
    expect(rows[0].entry.text).toContain('already linked');
    expect(rows[0].entry.links).toHaveLength(0);
  });

  it('counts repeated occurrences within one block', async () => {
    const idx = new BlockIndex(fakeVault({ ...VAULT }).app);
    await idx.buildAll();
    const hits = idx.unlinkedMentions('机器学习', 'notes/nothing.md', 100);
    const twice = hits.find((h) => h.entry.path === 'notes/机器.md' && h.count === 2);
    expect(twice).toBeDefined();
  });

  it('honours the max cap', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 40; i++) many[`notes/f${i}.md`] = `- ${i} mentions 目标词 here\n`;
    const idx = new BlockIndex(fakeVault(many).app);
    await idx.buildAll();

    expect(idx.unlinkedMentions('目标词', 'notes/none.md', 7).length).toBe(7);
    expect(idx.unlinkedMentions('目标词', 'notes/none.md', 100).length).toBe(40);
  });

  it('ignores titles shorter than 3 characters', async () => {
    const idx = new BlockIndex(fakeVault({ ...VAULT }).app);
    await idx.buildAll();
    expect(idx.unlinkedMentions('ab', 'notes/x.md', 50)).toEqual([]);
  });

  it('repeated queries are stable (the signature cache cannot drift)', async () => {
    const idx = new BlockIndex(fakeVault({ ...VAULT }).app);
    await idx.buildAll();
    const first = scan(idx, '机器学习', 'notes/nothing.md');
    for (let i = 0; i < 3; i++) {
      expect(scan(idx, '机器学习', 'notes/nothing.md')).toEqual(first);
    }
  });
});

describe('unlinked scan stays correct across index updates', () => {
  it('reflects an edit to one file without rebuilding the rest', async () => {
    const v = fakeVault({ ...VAULT });
    const idx = new BlockIndex(v.app);
    idx.attach({ registerEvent: vi.fn() });
    await idx.buildAll();

    const before = scan(idx, '新增关键词', 'notes/nothing.md');
    expect(before.length).toBe(0);

    v.files['notes/book.md'] = '- speak about 机器学习\n- now it has 新增关键词 too\n';
    v.fire('modify', 'notes/book.md');
    await settle();

    expect(scan(idx, '新增关键词', 'notes/nothing.md')).toEqual(oracle(idx, '新增关键词', 'notes/nothing.md'));
    expect(idx.unlinkedMentions('新增关键词', 'notes/nothing.md', 50).length).toBe(1);
    // Unrelated titles are untouched by that patch.
    expect(scan(idx, '机器学习', 'notes/nothing.md')).toEqual(oracle(idx, '机器学习', 'notes/nothing.md'));
  });

  it('drops results from a deleted file', async () => {
    const v = fakeVault({ ...VAULT });
    const idx = new BlockIndex(v.app);
    idx.attach({ registerEvent: vi.fn() });
    await idx.buildAll();

    expect(idx.unlinkedMentions('机器学习', 'notes/nothing.md', 100).some((h) => h.entry.path === 'notes/book.md')).toBe(
      true,
    );
    v.fire('delete', 'notes/book.md');
    await settle();
    expect(idx.unlinkedMentions('机器学习', 'notes/nothing.md', 100).some((h) => h.entry.path === 'notes/book.md')).toBe(
      false,
    );
    expect(scan(idx, '机器学习', 'notes/nothing.md')).toEqual(oracle(idx, '机器学习', 'notes/nothing.md'));
  });
});
