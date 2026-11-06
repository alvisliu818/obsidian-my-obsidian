/**
 * Supertags (Tana supertags / Logseq DB new tags): a tag page's own properties
 * are the field template; `extends::` inherits; applying materializes fields
 * without ever overwriting user data.
 */

import { describe, expect, it } from 'vitest';
import {
  applySupertags,
  hasSupertags,
  lookupSupertag,
  normalizeTag,
  removeSupertags,
  resolveFieldsForTags,
  resolveSupertagFields,
  supertagDefFrom,
  supertagsIn,
  type SupertagRegistry,
} from '../src/features/supertags';

function reg(defs: Record<string, Record<string, string>>): SupertagRegistry {
  const m: SupertagRegistry = new Map();
  for (const [name, props] of Object.entries(defs)) {
    const d = supertagDefFrom(name, props);
    if (d) m.set(d.name, d);
  }
  return m;
}

describe('normalizeTag', () => {
  it('treats #Name, Name, paths and .md as the same tag', () => {
    expect(normalizeTag('#Person')).toBe('person');
    expect(normalizeTag('Person')).toBe('person');
    expect(normalizeTag('notes/Person.md')).toBe('person');
    expect(normalizeTag('[[Person]]')).toBe('person');
    expect(normalizeTag('  #PERSON  ')).toBe('person');
  });

  it('unwraps a bracketed tag with spaces', () => {
    expect(normalizeTag('#[[Two Words]]')).toBe('two words');
    expect(normalizeTag('[[Person|alias]]')).toBe('person');
  });

  it('agrees with the index: a "#" after the first char is a subpath cut', () => {
    // normalizeLinkTarget (query.ts) truncates there, so a supertag named the
    // same way resolves identically — divergence here would silently never
    // match a block tag.
    expect(normalizeTag('foo#bar')).toBe('foo');
  });
});

describe('supertagDefFrom', () => {
  it('builds a definition from a tag page with properties', () => {
    const d = supertagDefFrom('Person', { 'last name': '', birthday: '2000-01-01' });
    expect(d).toEqual({
      name: 'person',
      fields: [
        { key: 'last name', defaultValue: '' },
        { key: 'birthday', defaultValue: '2000-01-01' },
      ],
      parents: [],
    });
  });

  it('is null for a page with no properties — a plain tag is not a supertag', () => {
    expect(supertagDefFrom('Person', {})).toBeNull();
  });

  it('excludes the editor-owned and extends props from the fields', () => {
    const d = supertagDefFrom('Person', {
      id: 'abc',
      collapsed: 'true',
      style: 'color: red',
      extends: '#Contact',
      'last name': '',
    });
    expect(d?.fields).toEqual([{ key: 'last name', defaultValue: '' }]);
    expect(d?.parents).toEqual(['contact']);
  });

  it('parses several parents, comma or space separated', () => {
    expect(supertagDefFrom('Book', { extends: '#Media, #Work' })?.parents).toEqual(['media', 'work']);
  });

  it('is a definition when it only extends (no own fields)', () => {
    const d = supertagDefFrom('AudioBook', { extends: '#Book' });
    expect(d).not.toBeNull();
    expect(d?.fields).toEqual([]);
  });
});

describe('lookupSupertag', () => {
  it('finds definitions regardless of #, case and path', () => {
    const r = reg({ Person: { 'last name': '' } });
    expect(lookupSupertag(r, '#Person')?.name).toBe('person');
    expect(lookupSupertag(r, 'notes/Person.md')?.name).toBe('person');
    expect(lookupSupertag(r, 'Unknown')).toBeNull();
  });
});

describe('resolveSupertagFields (inheritance)', () => {
  it('returns own fields when there are no parents', () => {
    const r = reg({ Person: { a: '1', b: '' } });
    expect(resolveSupertagFields(r, 'person').map((f) => f.key)).toEqual(['a', 'b']);
  });

  it('puts parent fields before child fields', () => {
    const r = reg({ Contact: { email: '' }, Person: { 'last name': '', extends: '#Contact' } });
    expect(resolveSupertagFields(r, 'person').map((f) => f.key)).toEqual(['email', 'last name']);
  });

  it('is transitive through several levels', () => {
    const r = reg({
      Book: { author: '' },
      Media: { duration: '' },
      AudioBook: { narrator: '', extends: '#Book #Media' },
    });
    expect(resolveSupertagFields(r, 'audiobook').map((f) => f.key)).toEqual([
      'author',
      'duration',
      'narrator',
    ]);
  });

  it('a child overrides the parent default, keeping the parent position', () => {
    const r = reg({ Base: { status: 'draft' }, Child: { status: 'final', extends: '#Base' } });
    const f = resolveSupertagFields(r, 'child');
    expect(f).toEqual([{ key: 'status', defaultValue: 'final' }]);
  });

  it('a diamond yields each field exactly once', () => {
    const r = reg({
      A: { shared: 'a', onlyA: '' },
      B: { shared: 'b', onlyB: '', extends: '#A' },
      C: { shared: 'c', extends: '#A' },
      D: { extends: '#B #C' },
    });
    const keys = resolveSupertagFields(r, 'd').map((f) => f.key);
    expect(keys).toEqual(['shared', 'onlyA', 'onlyB']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('terminates on a cycle instead of hanging', () => {
    const r = reg({ A: { a: '', extends: '#B' }, B: { b: '', extends: '#A' } });
    expect(resolveSupertagFields(r, 'a').map((f) => f.key).sort()).toEqual(['a', 'b']);
    // Self-extends is also survivable.
    const s = reg({ Loop: { x: '', extends: '#Loop' } });
    expect(resolveSupertagFields(s, 'loop').map((f) => f.key)).toEqual(['x']);
  });

  it('an unknown parent contributes nothing', () => {
    const r = reg({ Person: { a: '', extends: '#Ghost' } });
    expect(resolveSupertagFields(r, 'person').map((f) => f.key)).toEqual(['a']);
  });
});

describe('resolveFieldsForTags (multiple tags)', () => {
  it('merges templates, earlier tags winning', () => {
    const r = reg({ A: { shared: 'fromA', onlyA: '' }, B: { shared: 'fromB', onlyB: '' } });
    expect(resolveFieldsForTags(r, ['a', 'b'])).toEqual([
      { key: 'shared', defaultValue: 'fromA' },
      { key: 'onlyA', defaultValue: '' },
      { key: 'onlyB', defaultValue: '' },
    ]);
  });

  it('ignores plain tags in the set', () => {
    const r = reg({ A: { a: '' } });
    expect(resolveFieldsForTags(r, ['random', 'a'])).toEqual([{ key: 'a', defaultValue: '' }]);
  });
});

describe('supertagsIn / hasSupertags', () => {
  const r = reg({ Person: { a: '' } });
  it('picks only the tags that are definitions', () => {
    expect(supertagsIn(r, ['random', '#Person'])).toEqual(['person']);
    expect(hasSupertags(r, ['random'])).toBe(false);
    expect(hasSupertags(r, ['#Person'])).toBe(true);
  });
});

describe('applySupertags', () => {
  const r = reg({ Person: { 'last name': '', birthday: '2000-01-01' } });

  it('materializes declared fields and defaults', () => {
    expect(applySupertags({}, r, ['person'])).toEqual({ 'last name': '', birthday: '2000-01-01' });
  });

  it('NEVER overwrites an existing value — that would be data loss', () => {
    expect(applySupertags({ birthday: '1988-04-12' }, r, ['person'])).toEqual({
      birthday: '1988-04-12',
      'last name': '',
    });
  });

  it('is idempotent (returns null when nothing to add)', () => {
    const once = applySupertags({}, r, ['person'])!;
    expect(applySupertags(once, r, ['person'])).toBeNull();
  });

  it('returns null for plain tags only', () => {
    expect(applySupertags({}, r, ['random', 'other'])).toBeNull();
  });

  it('applies inherited fields too', () => {
    const r2 = reg({ Contact: { email: '' }, Person: { 'last name': '', extends: '#Contact' } });
    expect(Object.keys(applySupertags({}, r2, ['person'])!).sort()).toEqual(['email', 'last name']);
  });

  it('does not mutate the input', () => {
    const props = { birthday: 'x' };
    applySupertags(props, r, ['person']);
    expect(props).toEqual({ birthday: 'x' });
  });
});

describe('removeSupertags', () => {
  const r = reg({ Person: { 'last name': '', birthday: '2000-01-01' } });

  it('retracts untouched template fields', () => {
    const applied = applySupertags({}, r, ['person'])!;
    expect(removeSupertags(applied, r, ['person'], [])).toEqual({});
  });

  it('keeps a default value the user did not change', () => {
    expect(removeSupertags({ birthday: '2000-01-01' }, r, ['person'], [])).toEqual({});
  });

  it('KEEPS a value the user filled in — that is real data', () => {
    // 'last name' still holds its empty default → retracted;
    // 'birthday' was changed to 1988-04-12 → the user's data, kept.
    const filled = { 'last name': '', birthday: '1988-04-12' };
    expect(removeSupertags(filled, r, ['person'], [])).toEqual({ birthday: '1988-04-12' });
  });

  it('keeps fields still required by another tag on the node', () => {
    const r2 = reg({ Person: { email: '', nickname: '' }, Work: { email: '', team: '' } });
    const applied = applySupertags({}, r2, ['person', 'work'])!;
    expect(applied).toEqual({ email: '', nickname: '', team: '' });
    // Removing #Person retracts `nickname` (only it declares it) but keeps
    // `email`, which #Work still requires.
    expect(removeSupertags(applied, r2, ['person'], ['work'])).toEqual({ email: '', team: '' });
  });

  it('returns null when the removed tags own nothing', () => {
    expect(removeSupertags({ a: '1' }, r, ['random'], [])).toBeNull();
  });

  it('does not mutate the input', () => {
    const props = { 'last name': '', birthday: '2000-01-01' };
    removeSupertags(props, r, ['person'], []);
    expect(props).toEqual({ 'last name': '', birthday: '2000-01-01' });
  });
});
