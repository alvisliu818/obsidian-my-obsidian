/**
 * Supertag index integration: a tag page's own `key:: value` lines become the
 * definition, instances are found vault-wide, and the collection columns come
 * from the RESOLVED template. Runs the real BlockIndex over a fake vault.
 */

import { describe, expect, it } from 'vitest';
import { BlockIndex } from '../src/index/blockIndex';
import { buildSupertagCollection } from '../src/features/supertagCollection';
import { applySupertags, removeSupertags } from '../src/features/supertags';
import { collectBlockTags, removeTagFromText } from '../src/features/supertagText';
import type { App, TFile } from 'obsidian';

/** Minimal vault: the index only uses getMarkdownFiles + cachedRead. */
function fakeApp(files: Record<string, string>): App {
  const list = Object.keys(files).map((path) => ({ path, extension: 'md', basename: path.split('/').pop()!.replace(/\.md$/, '') }));
  return {
    vault: {
      getMarkdownFiles: () => list as unknown as TFile[],
      cachedRead: async (f: TFile) => files[f.path],
    },
  } as unknown as App;
}

const VAULT: Record<string, string> = {
  // The tag page IS the definition (Logseq DB: properties live on the tag page).
  'Person.md': 'lastname::\nbirthday::\nextends:: #Contact\n',
  'Contact.md': 'email::\n',
  // Instances scattered across files; one INHERITS the tag from its parent.
  'notes/meet.md': '- Marisha #Person\n  lastname:: rv\n  birthday:: 1988-04-12\n',
  'journal/2026-10-04.md': '- TODO call #Person\n- Ada #Contact\n',
  // An ordinary tag page (no properties) must NOT become a supertag.
  'random.md': 'just a note\n',
};

async function index(): Promise<BlockIndex> {
  const idx = new BlockIndex(fakeApp(VAULT));
  await idx.buildAll();
  return idx;
}

describe('supertag definitions from the index', () => {
  it('a page with properties defines a supertag under its own name', async () => {
    const idx = await index();
    const def = idx.supertagDef('Person');
    expect(def?.name).toBe('person');
    expect(def?.parents).toEqual(['contact']);
    expect(def?.fields.map((f) => f.key)).toEqual(['lastname', 'birthday']);
  });

  it('is found through #, case and path variants', async () => {
    const idx = await index();
    expect(idx.supertagDef('#Person')?.name).toBe('person');
    expect(idx.supertagDef('notes/Person.md')?.name).toBe('person');
  });

  it('a page with NO properties is an ordinary tag, not a supertag', async () => {
    const idx = await index();
    expect(idx.supertagDef('random')).toBeNull();
    expect(idx.supertagRegistry().has('random')).toBe(false);
  });

  it('a parent tag with only `extends` still counts as a definition', async () => {
    const idx = await index();
    expect(idx.supertagDef('Contact')).not.toBeNull();
  });
});

describe('supertagInstances (the collection)', () => {
  it('finds every block carrying the tag, across files', async () => {
    const idx = await index();
    const rows = idx.supertagInstances('person');
    expect(rows.map((r) => r.path).sort()).toEqual(['journal/2026-10-04.md', 'notes/meet.md']);
    // The index stores the first line with the TODO marker stripped (marker
    // lives in its own field), so the text is 'call #Person'.
    const todo = rows.find((r) => r.path === 'journal/2026-10-04.md')!;
    expect(todo.text).toBe('call #Person');
    expect(todo.marker).toBe('TODO');
  });

  it('exposes every block prop, not just the query-relevant subset', async () => {
    const idx = await index();
    const marisha = idx.supertagInstances('person').find((r) => r.path === 'notes/meet.md')!;
    expect(marisha.blockProps['lastname']).toBe('rv');
    expect(marisha.blockProps.birthday).toBe('1988-04-12');
    // The narrow `props` field keeps its old shape (query-table unchanged).
    expect(marisha.props).toEqual({});
  });

  it('does not match a prefix of a longer tag', async () => {
    const idx = new BlockIndex(fakeApp({ 'a.md': '- x #person\n- y #personnel\n' }));
    await idx.buildAll();
    expect(idx.supertagInstances('person').map((r) => r.text)).toEqual(['x #person']);
  });
});

describe('buildSupertagCollection', () => {
  it('columns follow the resolved template, including inherited fields', async () => {
    const idx = await index();
    const model = buildSupertagCollection(idx.supertagRegistry(), 'Person', idx.supertagInstances('Person'))!;
    // email comes from #Contact via extends::, and precedes the own fields.
    expect(model.columns).toEqual(['email', 'lastname', 'birthday']);
  });

  it('is null for an ordinary tag (no section at all)', async () => {
    const idx = await index();
    expect(buildSupertagCollection(idx.supertagRegistry(), 'random', [])).toBeNull();
  });

  it('hides editor-owned columns', async () => {
    const idx = new BlockIndex(fakeApp({ 'T.md': 'id:: x\ncollapsed:: true\nextends:: #P\nnote::\n', 'P.md': 'note::\n' }));
    await idx.buildAll();
    const model = buildSupertagCollection(idx.supertagRegistry(), 'T', idx.supertagInstances('T'))!;
    expect(model.columns).toEqual(['note']);
  });
});

describe('apply / remove round-trip on real indexed blocks', () => {
  it('applying #Person to a plain block materializes the inherited fields', async () => {
    const idx = await index();
    const reg = idx.supertagRegistry();
    const before = { text: 'Marisha Silva' };
    const withTag = `${before.text} #person`;
    const after = applySupertags({}, reg, [...collectBlockTags(withTag)])!;
    expect(after).toEqual({ email: '', 'lastname': '', birthday: '' });
  });

  it('a filled-in value survives removing the tag; empty fields are retracted', async () => {
    const idx = await index();
    const reg = idx.supertagRegistry();
    const applied = applySupertags({ 'lastname': 'rv', birthday: '1988-04-12' }, reg, ['person'])!;
    expect(removeSupertags(applied, reg, ['person'], [])).toEqual({ 'lastname': 'rv', birthday: '1988-04-12' });
  });

  it('tag add/remove on text is byte-stable across cycles', async () => {
    const idx = await index();
    const t = 'Ada Lovelace #contact';
    const removed = removeTagFromText(t, 'contact');
    expect(removed).toBe('Ada Lovelace');
    expect(`${removed} #contact`).toBe(t);
    expect(idx.supertagDef('Contact')).not.toBeNull();
  });
});
