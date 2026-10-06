/**
 * Which editor a mounted file opens in, and what path its header shows.
 *
 * Both came from screenshots: `.gitignore` opened as a markdown document with
 * headings and bullet lists, and the header showed a long absolute Windows path
 * instead of the name the user recognises.
 *
 * The routing rule is by CONTENT — markdown is prose, everything else is read
 * line by line — which is why this asserts the absence of a routing list rather
 * than the presence of one.
 */

import { describe, expect, it } from 'vitest';
import { isMarkdownFile, relativeDisplayPath } from '../src/features/codeFileKind';

describe('isMarkdownFile — the only format that opens in the block editor', () => {
  it('accepts the markdown extensions', () => {
    for (const n of ['note.md', 'a.markdown', 'b.MD', 'c.mdown', 'd.mkd', 'e.mdx']) {
      expect(isMarkdownFile(n)).toBe(true);
    }
  });

  it('sends dotfiles to the code editor, NOT the block editor', () => {
    // The reported bug: `.gitignore` rendered as a document with `# 忽略所有文件`
    // as a heading and `*.log` as bullets. It has no extension at all, so an
    // allowlist-shaped check had nothing to match and it fell through to prose.
    expect(isMarkdownFile('.gitignore')).toBe(false);
    expect(isMarkdownFile('.env')).toBe(false);
    expect(isMarkdownFile('.editorconfig')).toBe(false);
  });

  it('sends code and config to the code editor', () => {
    for (const n of [
      'a.ts', 'a.py', 'a.json', 'a.yaml', 'a.yml', 'a.toml', 'a.ini',
      'a.sh', 'a.html', 'a.css', 'a.jsx', 'a.rs', 'a.go', 'a.sql',
    ]) {
      expect(isMarkdownFile(n)).toBe(false);
    }
  });

  it('sends plain text and binaries away from the block editor', () => {
    for (const n of ['notes.txt', 'readme', 'photo.png', 'data.csv', 'a.pdf', 'LICENSE']) {
      expect(isMarkdownFile(n)).toBe(false);
    }
  });

  it('uses the last path segment, so a folder cannot flip the routing', () => {
    expect(isMarkdownFile('notes.md/other.txt')).toBe(false);
    expect(isMarkdownFile('some.ts/deep/note.md')).toBe(true);
  });
});

describe('relativeDisplayPath — the header shows a name, not a Windows path', () => {
  it('strips the mount root, so nested files keep their folder', () => {
    expect(
      relativeDisplayPath('D:\\notes\\a\\b\\note.ts', 'D:\\notes', 'note.ts'),
    ).toBe('a/b/note.ts');
  });

  it('shows just the filename for a file at the mount root', () => {
    expect(relativeDisplayPath('D:\\notes\\a.ts', 'D:\\notes', 'a.ts')).toBe('a.ts');
  });

  it('tolerates mixed separators, which Windows reports freely', () => {
    expect(relativeDisplayPath('D:/notes/sub/x.ts', 'D:\\notes\\', 'x.ts')).toBe('sub/x.ts');
    expect(relativeDisplayPath('D:\\notes/sub/x.ts', 'D:/notes', 'x.ts')).toBe('sub/x.ts');
  });

  it('is case-insensitive, since Windows paths are', () => {
    expect(relativeDisplayPath('D:\\Notes\\a.ts', 'd:\\notes', 'a.ts')).toBe('a.ts');
  });

  it('falls back to the filename when the file is outside the mount', () => {
    // Happens if a mount moved after the tab was opened; showing an unrelated
    // absolute path would be worse than the bare name.
    expect(relativeDisplayPath('C:\\other\\a.ts', 'D:\\notes', 'a.ts')).toBe('a.ts');
  });

  it('falls back to the basename when there is no filename at all', () => {
    expect(relativeDisplayPath('D:\\notes', '', '')).toBe('notes');
  });
});