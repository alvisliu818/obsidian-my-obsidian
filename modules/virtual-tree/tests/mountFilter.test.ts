/**
 * Mount filters and virtual-tree shaping.
 *
 * These are the rules a mounted folder's visibility actually rests on, so the
 * cases below are the ones that would silently show the wrong files: exclude
 * beating include, ancestor folders of a surviving file, invalid regexes not
 * throwing, and pruning a subtree instead of listing it.
 */

import { describe, expect, it } from 'vitest';
import {
  buildTree,
  compileFilter,
  countTree,
  dirPruned,
  entryMatches,
  isTextMount,
  validateMountPath,
  type ScanEntry,
} from '../src/features/mountFilter';
import { extOf, joinAbs } from '../src/features/extFs';

const F = (include = '', exclude = '') => compileFilter({ include, exclude });

const e = (rel: string, isDir = false): ScanEntry => ({
  rel,
  name: rel.slice(rel.lastIndexOf('/') + 1),
  isDir,
  abs: 'D:\\m\\' + rel.replace(/\//g, '\\'),
});

describe('mountFilter — regex compilation', () => {
  it('treats an empty pattern as "no rule" rather than a match-everything regex', () => {
    const f = F();
    expect(f.include).toBeNull();
    expect(f.exclude).toBeNull();
    expect(entryMatches('anything/at/all.md', f)).toBe(true);
  });

  it('records an invalid pattern instead of throwing at render time', () => {
    const f = F('([unclosed', 'also(bad');
    expect(f.errors.include).toBe('([unclosed');
    expect(f.errors.exclude).toBe('also(bad');
    // A broken filter degrades to "show everything", never to a blank tree.
    expect(entryMatches('a.md', f)).toBe(true);
  });

  it('matches case-insensitively so \\.md$ also catches .MD', () => {
    const f = F('\\.md$');
    expect(entryMatches('notes/a.md', f)).toBe(true);
    expect(entryMatches('notes/a.MD', f)).toBe(true);
    expect(entryMatches('notes/a.txt', f)).toBe(false);
  });
});

describe('mountFilter — include / exclude precedence', () => {
  it('lets exclude win over include', () => {
    const f = F('.*', 'draft');
    expect(entryMatches('final.md', f)).toBe(true);
    expect(entryMatches('draft.md', f)).toBe(false);
  });

  it('matches the bare file name as well as the relative path', () => {
    // '^draft' has no '/' in it, so it can only work against the name.
    const f = F('', '^draft');
    expect(entryMatches('work/draft.md', f)).toBe(false);
    expect(entryMatches('work/final.md', f)).toBe(true);
  });

  it('matches against the relative path so a folder can be filtered wholesale', () => {
    const f = F('', '[\\\\/]archive[\\\\/]');
    expect(entryMatches('x/archive/y.md', f)).toBe(false);
    expect(entryMatches('archive/y.md', f)).toBe(false);
    expect(entryMatches('x/archived/y.md', f)).toBe(true);
  });

  it('prunes a directory only on a whole-segment match', () => {
    const byName = F('', '^drafts$');
    expect(dirPruned('drafts', byName)).toBe(true);
    expect(dirPruned('drafts-2024', byName)).toBe(false);

    // A suffix pattern must not stop us from DESCENDING into a folder that
    // merely contains .tmp files — otherwise its real contents vanish too.
    const bySuffix = F('', '\\.tmp$');
    expect(dirPruned('scratch', bySuffix)).toBe(false);
    expect(dirPruned('scratch.tmp', bySuffix)).toBe(true);
  });
});

describe('mountFilter — tree building', () => {
  const entries = [
    e('a.md'),
    e('sub', true),
    e('sub/b.md'),
    e('sub/deep', true),
    e('sub/deep/c.txt'),
    e('z.log'),
    e('node_modules', true),
    e('node_modules/pkg', true),
    e('node_modules/pkg/index.js'),
  ];

  it('nests by relative path and keeps folders before files', () => {
    const tree = buildTree(entries, F());
    expect(tree.map((n) => n.name)).toEqual(['node_modules', 'sub', 'a.md', 'z.log']);
    const sub = tree.find((n) => n.name === 'sub')!;
    expect(sub.isDir).toBe(true);
    expect(sub.children.map((n) => n.name)).toEqual(['deep', 'b.md']);
    expect(sub.children[0].children.map((n) => n.name)).toEqual(['c.txt']);
  });

  it('creates ancestor folders even when the folder name itself fails the filter', () => {
    // A file survives, so its parents must exist to hold it.
    const tree = buildTree([e('secret-notes/ok.md')], F('\\.md$'));
    expect(tree.map((n) => n.name)).toEqual(['secret-notes']);
    expect(tree[0].children.map((n) => n.name)).toEqual(['ok.md']);
  });

  it('marks a folder whose every child was filtered away as empty', () => {
    // The scanner emits a row for a directory BEFORE descending into it, so a
    // folder survives even when every file under it is filtered out — the user
    // sees "this folder exists but nothing in it matched" rather than nothing.
    const tree = buildTree([e('pics', true), e('pics/a.png'), e('pics/b.png')], F('\\.md$'));
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('pics');
    expect(tree[0].isDir).toBe(true);
    expect(tree[0].empty).toBe(true);
    expect(tree[0].children).toHaveLength(0);
  });

  it('never emits a filtered-out file even when its folder survives', () => {
    const tree = buildTree(entries, F('\\.md$'));
    const names: string[] = [];
    const walk = (n: { name: string; children: unknown[] }[]): void => {
      for (const x of n) {
        names.push(x.name);
        walk(x.children as { name: string; children: unknown[] }[]);
      }
    };
    walk(tree);
    expect(names).not.toContain('c.txt');
    expect(names).not.toContain('index.js');
    expect(names).toContain('a.md');
  });

  it('counts files and folders separately', () => {
    // Folders (4): node_modules, node_modules/pkg, sub, sub/deep
    // Files    (5): a.md, z.log, sub/b.md, sub/deep/c.txt,
    //                 node_modules/pkg/index.js
    expect(countTree(buildTree(entries, F()))).toEqual({ files: 5, folders: 4 });
  });

  it('returns an empty tree for an empty scan', () => {
    expect(buildTree([], F())).toEqual([]);
  });
});

describe('mountFilter — text vs binary routing', () => {
  it('routes common note and code extensions to the editor', () => {
    for (const ext of ['md', 'markdown', 'txt', 'json', 'yaml', 'ts', 'py', 'canvas']) {
      expect(isTextMount(ext)).toBe(true);
    }
  });

  it('routes everything else to the system app', () => {
    // Being wrong here would mean writing text over a binary file.
    for (const ext of ['png', 'jpg', 'pdf', 'mp4', 'zip', 'exe', 'woff2']) {
      expect(isTextMount(ext)).toBe(false);
    }
    expect(isTextMount('')).toBe(false);
  });

  it('accepts extensions in any case', () => {
    expect(extOf('NOTE.MD')).toBe('md');
    expect(extOf('noext')).toBe('');
    expect(extOf('a.b.c')).toBe('c');
  });
});

describe('mountFilter — path validation', () => {
  it('accepts absolute Windows paths', () => {
    expect(validateMountPath('D:\\notes')).toBeNull();
    expect(validateMountPath('E:/notes/inbox')).toBeNull();
    expect(validateMountPath('\\\\server\\share')).toBeNull();
  });

  it('rejects relative paths, blanks and characters Windows forbids', () => {
    expect(validateMountPath('')).toMatch(/empty/i);
    expect(validateMountPath('notes/inbox')).toMatch(/absolute/i);
    expect(validateMountPath('D:\\no?pe')).toMatch(/characters/i);
  });
});

describe('extFs — path joining', () => {
  it('uses the separator the mount root already uses', () => {
    expect(joinAbs('D:\\m', 'sub/a.md')).toBe('D:\\m\\sub\\a.md');
    expect(joinAbs('D:/m/', 'a.md')).toBe('D:/m/a.md');
  });

  it('does not double the separator when the root ends with one', () => {
    expect(joinAbs('D:\\m\\', 'a.md')).toBe('D:\\m\\a.md');
  });
});