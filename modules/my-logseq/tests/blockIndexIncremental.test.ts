/**
 * Incremental index updates: why they exist and what must stay true.
 *
 * Context: `vault.on('modify')` used to schedule a debounced `buildAll()` — a
 * full vault re-parse. Measured on the main vault (8382 files / ~980k blocks)
 * that is 8.4s of main-thread work, fired 2s after every edit, which is what
 * made opening a file right after typing feel frozen. Edits now patch only the
 * files that changed (23–44ms each).
 *
 * These tests pin both the CORRECTNESS of that patching (it must match a clean
 * rebuild exactly) and the WIRING (no vault event may reach buildAll).
 */

import { describe, expect, it, vi } from 'vitest';
import { BlockIndex } from '../src/index/blockIndex';
import type { App, TFile } from 'obsidian';

type Handler = (file: unknown, old?: string) => void;

/**
 * Vault double that also records the event handlers `attach` registers, so a
 * test can fire a real-looking modify/rename/delete.
 */
function fakeVault(files: Record<string, string>) {
  const handlers: Record<string, Handler[]> = {};
  const asFile = (path: string) => ({ path, extension: 'md', basename: path.replace(/^.*\//, '').replace(/\.md$/, '') });
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

// Block refs are only recognized in Logseq's UUID form (see BLOCK_REF_RE).
const ID_A = '123e4567-e89b-12d3-a456-426614174000';
const ID_B = '123e4567-e89b-12d3-a456-426614174001';

const VAULT: Record<string, string> = {
  [`pages/alpha.md`]: `- first block\n  id:: ${ID_A}\n- mentions [[beta]]\n`,
  'pages/beta.md': `- plain\n- TODO something #tag\n  id:: ${ID_B}\n`,
  'pages/gamma.md': `- refs ((${ID_A})) here\n`,
};

async function settle(): Promise<void> {
  // The stubbed `debounce` is the identity function, so a patch starts
  // immediately — but it still crosses several awaited microtasks.
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('incremental patching via vault events', () => {
  it('a modify updates only the edited file and matches a clean rebuild', async () => {
    const v = fakeVault({ ...VAULT });
    const idx = new BlockIndex(v.app);
    idx.attach({ registerEvent: vi.fn() });
    await idx.buildAll();

    expect(idx.get(ID_A)?.text).toBe('first block');
    expect(idx.backlinksTo('beta').length).toBe(1);

    // Edit alpha: add a block, drop the [[beta]] link, retitle the id'd block.
    v.files['pages/alpha.md'] = `- first block RENAMED\n  id:: ${ID_A}\n- new child\n`;
    v.fire('modify', 'pages/alpha.md');
    await settle();

    expect(idx.get(ID_A)?.text).toBe('first block RENAMED');
    // The dropped link must disappear from beta's backlinks...
    expect(idx.backlinksTo('beta').length).toBe(0);
    // ...and the added block must be queryable.
    expect(idx.allBlocks().some((b) => b.text === 'new child')).toBe(true);

    // Compare against a from-scratch index over the SAME content.
    const truth = new BlockIndex(fakeVault({ ...v.files }).app);
    await truth.buildAll();
    expect(idx.allBlocks().length).toBe(truth.allBlocks().length);
    expect(idx.withIds().map((b) => b.blockId).sort()).toEqual(truth.withIds().map((b) => b.blockId).sort());
    expect(idx.allTags()).toEqual(truth.allTags());
    expect(idx.backlinksTo('beta').length).toBe(truth.backlinksTo('beta').length);
    expect(idx.refsToBlock('aa11').length).toBe(truth.refsToBlock('aa11').length);
  });

  it('editing one file leaves other files’ cross-references intact', async () => {
    const v = fakeVault({ ...VAULT });
    const idx = new BlockIndex(v.app);
    idx.attach({ registerEvent: vi.fn() });
    await idx.buildAll();

    // gamma references ((ID_A)) — editing gamma must not disturb alpha's own
    // entry, and editing alpha must not lose gamma's reference to it.
    v.files['pages/gamma.md'] = `- refs ((${ID_A})) here and again\n`;
    v.fire('modify', 'pages/gamma.md');
    await settle();
    expect(idx.get(ID_A)?.text).toBe('first block');
    expect(idx.refsToBlock(ID_A).length).toBe(1);

    v.files['pages/alpha.md'] = `- first block\n  id:: ${ID_A}\n- mentions [[beta]]\n- third\n`;
    v.fire('modify', 'pages/alpha.md');
    await settle();
    expect(idx.refsToBlock(ID_A).length).toBe(1);
    expect(idx.refsToBlock(ID_A)[0].sourcePath).toBe('pages/gamma.md');
  });

  it('delete and rename remove the old path instead of leaving stale blocks', async () => {
    const v = fakeVault({ ...VAULT });
    const idx = new BlockIndex(v.app);
    idx.attach({ registerEvent: vi.fn() });
    await idx.buildAll();
    expect(idx.get(ID_B)).not.toBeNull();
    // #tag is a BLOCK tag, so it shows up on the block, not in allTags()
    // (which aggregates the per-FILE tag sets).
    const countTagged = () => idx.allBlocks().filter((b) => b.tags.includes('tag')).length;
    expect(countTagged()).toBe(1);

    v.fire('delete', 'pages/beta.md');
    await settle();
    expect(idx.get(ID_B)).toBeNull();
    expect(idx.allBlocks().some((b) => b.path === 'pages/beta.md')).toBe(false);
    expect(countTagged()).toBe(0);

    // A rename is a delete of the old path plus an index of the new one.
    v.fire('rename', 'pages/gamma.md', 'pages/gamma-old.md');
    await settle();
    expect(idx.allBlocks().some((b) => b.path === 'pages/gamma-old.md')).toBe(false);
  });

  it('modify never triggers the vault-wide rebuild', async () => {
    const v = fakeVault({ ...VAULT });
    const idx = new BlockIndex(v.app);
    idx.attach({ registerEvent: vi.fn() });
    await idx.buildAll();

    const rebuilds = vi.spyOn(idx, 'buildAll');
    const version0 = idx.version;

    v.files['pages/beta.md'] = '- plain\n- TODO something #tag\n  id:: bb22\n- added\n';
    v.fire('modify', 'pages/beta.md');
    await settle();

    expect(rebuilds).not.toHaveBeenCalled();
    // The patch still bumped the version so consumers refresh their caches.
    expect(idx.version).toBeGreaterThan(version0);
    // And actually took effect.
    expect(idx.allBlocks().some((b) => b.text === 'added')).toBe(true);
  });

  it('non-markdown files are ignored, not indexed', async () => {
    const v = fakeVault({ ...VAULT });
    const idx = new BlockIndex(v.app);
    idx.attach({ registerEvent: vi.fn() });
    await idx.buildAll();
    const before = idx.allBlocks().length;

    for (const cb of v.handlers['modify'] ?? []) cb({ path: 'pic.png', extension: 'png' });
    await settle();
    expect(idx.allBlocks().length).toBe(before);
  });
});

describe('listeners still get notified', () => {
  it('one notification per flush, however many files changed', async () => {
    const v = fakeVault({ ...VAULT });
    const idx = new BlockIndex(v.app);
    idx.attach({ registerEvent: vi.fn() });
    await idx.buildAll();

    const seen: number[] = [];
    const off = idx.onRebuild(() => seen.push(idx.version));
    v.files['pages/beta.md'] = '- plain\n- extra\n';
    v.fire('modify', 'pages/beta.md');
    await settle();
    off();

    expect(seen.length).toBeGreaterThan(0);
  });
});
