/**
 * 索引忽略（2026-11-28 用户需求）：黑白名单正则的判定语义。
 *
 * 纯函数，不碰 obsidian —— 渲染端（库外清单过滤）与索引守护进程（库内扫描）
 * 共用同一份实现，正确性在这里锁死。
 */
import { describe, expect, it } from 'vitest';
import {
  compileIndexIgnore,
  isIndexDirPruned,
  isIndexIgnored,
  isIndexIgnoredPath,
  legacyFolderListToPatterns,
  normalizeIgnoreConfig,
} from '../../shared/indexIgnore';

const ignored = (rel: string, blacklist: string[], whitelist: string[] = []): boolean =>
  isIndexIgnored(rel, compileIndexIgnore({ blacklist, whitelist }));

describe('索引忽略 — 黑名单', () => {
  it('没有黑名单时不启用（白名单单独存在没有意义）', () => {
    const rules = compileIndexIgnore({ blacklist: [], whitelist: ['keep.md'] });
    expect(rules.active).toBe(false);
    expect(isIndexIgnored('a.md', rules)).toBe(false);
  });

  it('纯文本命中文件名/路径段，且整段相等（Notes 不误伤 Notes2）', () => {
    expect(ignored('a/draft.md', ['draft.md'])).toBe(true);
    expect(ignored('Notes/a.md', ['Notes'])).toBe(true);
    expect(ignored('x/Notes/a.md', ['Notes'])).toBe(true);
    expect(ignored('Notes2/a.md', ['Notes'])).toBe(false);
    expect(ignored('a/note.md', ['draft.md'])).toBe(false);
  });

  it('裸正则按路径/文件名/段边界匹配', () => {
    expect(ignored('a/x.tmp', ['\\.tmp$'])).toBe(true);
    expect(ignored('.obsidian/plugins/x.md', ['^\\.'])).toBe(true);
    expect(ignored('notes/a.md', ['^\\.'])).toBe(false);
  });

  it('/正则/flags 形态默认大小写不敏感，g/y 不参与', () => {
    expect(ignored('a/X.TMP', ['/\\.tmp$/'])).toBe(true);
    expect(ignored('a/x.txt', ['/\\.tmp$/'])).toBe(false);
  });

  it('非法正则被忽略，不影响其它条目', () => {
    expect(ignored('a.md', ['['])).toBe(false);
    expect(ignored('a.md', ['[', 'a\\.md$'])).toBe(true);
  });
});

describe('索引忽略 — 白名单（例外）', () => {
  it('白名单命中 → 即使黑名单也命中，仍然收录', () => {
    expect(ignored('draft/keep.md', ['draft'], ['keep\\.md$'])).toBe(false);
    expect(ignored('draft/other.md', ['draft'], ['keep\\.md$'])).toBe(true);
  });
});

describe('索引忽略 — 目录剪枝', () => {
  it('黑名单目录整棵剪掉（节省扫描）', () => {
    const rules = compileIndexIgnore({ blacklist: ['node_modules'], whitelist: [] });
    expect(isIndexDirPruned('node_modules', rules)).toBe(true);
    expect(isIndexDirPruned('a/node_modules', rules)).toBe(true);
    expect(isIndexDirPruned('src', rules)).toBe(false);
  });

  it('配了白名单就不剪目录（例外可能藏在被剪掉的子树里）', () => {
    const rules = compileIndexIgnore({ blacklist: ['node_modules'], whitelist: ['keep.md'] });
    expect(isIndexDirPruned('node_modules', rules)).toBe(false);
    // 但文件级判定仍然生效：白名单只救命中的那个文件
    expect(isIndexIgnored('node_modules/pkg/keep.md', rules)).toBe(false);
    expect(isIndexIgnored('node_modules/pkg/other.md', rules)).toBe(true);
  });
});

describe('索引忽略 — 绝对路径（库外挂载）', () => {
  it('反斜杠归一后按路径段匹配', () => {
    const rules = compileIndexIgnore({ blacklist: ['node_modules'], whitelist: [] });
    expect(isIndexIgnoredPath('E:\\code\\proj\\node_modules\\x.md', rules)).toBe(true);
    expect(isIndexIgnoredPath('E:\\code\\proj\\src\\x.md', rules)).toBe(false);
  });

  it('锚定正则可以只忽略某个根目录下的内容', () => {
    const rules = compileIndexIgnore({ blacklist: ['^E:/code/test/'], whitelist: [] });
    expect(isIndexIgnoredPath('E:\\code\\test\\a.md', rules)).toBe(true);
    expect(isIndexIgnoredPath('E:\\code\\prod\\a.md', rules)).toBe(false);
  });
});

describe('旧设置迁移', () => {
  it('目录条目 → 锚定正则；单层目录名按路径段命中（任意层级）', () => {
    const patterns = legacyFolderListToPatterns('backups, projects/notes');
    expect(patterns).toEqual(['^backups(/|$)', '^projects/notes(/|$)']);
    const rules = compileIndexIgnore({ blacklist: patterns, whitelist: [] });
    expect(isIndexIgnored('backups/a.md', rules)).toBe(true);
    expect(isIndexIgnored('backups', rules)).toBe(true);
    // 新名单按路径段匹配：同名目录在任意层级都命中（比旧的「库根前缀」略宽）
    expect(isIndexIgnored('x/backups/a.md', rules)).toBe(true);
    expect(isIndexIgnored('projects/notes/a.md', rules)).toBe(true);
    expect(isIndexIgnored('projects/notes2/a.md', rules)).toBe(false);
  });

  it('空串/多余分隔符安全', () => {
    expect(legacyFolderListToPatterns('')).toEqual([]);
    expect(legacyFolderListToPatterns(' /a/ , , b ')).toEqual(['^a(/|$)', '^b(/|$)']);
  });
});

describe('配置清洗', () => {
  it('非数组/非字符串/空白条目被丢弃', () => {
    expect(normalizeIgnoreConfig(undefined)).toEqual({ blacklist: [], whitelist: [] });
    expect(normalizeIgnoreConfig({ blacklist: [' a ', 3, '', null], whitelist: 'x' })).toEqual({
      blacklist: ['a'],
      whitelist: [],
    });
  });
});
