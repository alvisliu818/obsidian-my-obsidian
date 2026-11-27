/**
 * 隐藏 / 例外名单（2026-11-27 用户需求）：纯文本 + 正则黑白名单的判定语义。
 *
 * 纯函数，不碰 obsidian —— 面板三个分支（库内/库外/远端）只是把每个节点喂给
 * isHiddenByRules，规则本身的正确性在这里锁死。
 */
import { describe, expect, it } from 'vitest';
import { compileHideRules, isHiddenByRules } from '../src/features/mountFilter';

const hidden = (rel: string, hide: string[], show: string[] = []): boolean => {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return isHiddenByRules(rel, name, compileHideRules(hide, show));
};

describe('隐藏名单 — 纯文本', () => {
  it('命中文件名', () => {
    expect(hidden('a/draft.md', ['draft.md'])).toBe(true);
    expect(hidden('a/note.md', ['draft.md'])).toBe(false);
  });

  it('命中路径段，不误伤同前缀的文件名（Notes / Notes2）', () => {
    expect(hidden('Notes/a.md', ['Notes'])).toBe(true);
    expect(hidden('x/Notes/a.md', ['Notes'])).toBe(true);
    expect(hidden('Notes2/a.md', ['Notes'])).toBe(false);
  });

  it('目录命中且没有白名单 → 整棵剪掉', () => {
    expect(hidden('node_modules', ['node_modules'], [])).toBe(true);
    expect(hidden('a/node_modules', ['node_modules'], [])).toBe(true);
  });
});

describe('隐藏名单 — 正则', () => {
  it('裸正则（^ 开头）按段命中，整棵子树都隐藏', () => {
    expect(hidden('.git', ['^\\.'], [])).toBe(true);
    // 路径段里出现点开头目录也算命中（.obsidian 下的子项一并隐藏）
    expect(hidden('.obsidian/plugins', ['^\\.'], [])).toBe(true);
    expect(hidden('notes/a.md', ['^\\.'], [])).toBe(false);
  });

  it('/正则/flags 形态，默认大小写不敏感', () => {
    expect(hidden('a/X.TMP', ['/\\.tmp$/'])).toBe(true);
    expect(hidden('a/x.txt', ['/\\.tmp$/'])).toBe(false);
  });

  it('非法正则被忽略，不影响其它条目', () => {
    expect(hidden('a.md', ['['])).toBe(false);
    expect(hidden('a.md', ['[', 'a\\.md$'])).toBe(true);
  });
});

describe('例外名单（白名单）', () => {
  it('白名单命中 → 即使黑名单也命中，仍然显示', () => {
    expect(hidden('draft/keep.md', ['draft'], ['keep\\.md$'])).toBe(false);
  });

  it('规则只看节点自己：父目录被黑名单命中就整棵隐藏，白名单救不了子项', () => {
    expect(hidden('draft', ['draft'], ['keep'])).toBe(true);
    // 想把例外留在树里，就别隐藏目录本身——用文件级黑名单
    expect(hidden('draft/a.tmp', ['\\.tmp$'], ['keep.md'])).toBe(true);
    expect(hidden('draft/keep.md', ['\\.tmp$'], ['keep.md'])).toBe(false);
  });

  it('白名单为空 → 不参与判定（黑名单照常整棵剪）', () => {
    expect(hidden('draft', ['draft'], [])).toBe(true);
  });
});

describe('空名单', () => {
  it('没有黑名单时整条链路不启用', () => {
    const rules = compileHideRules([], ['keep']);
    expect(rules.active).toBe(false);
    expect(isHiddenByRules('a.md', 'a.md', rules)).toBe(false);
  });

  it('空白行/undefined 安全', () => {
    const rules = compileHideRules(undefined, undefined);
    expect(rules.active).toBe(false);
    expect(rules.hide).toHaveLength(0);
    expect(rules.show).toHaveLength(0);
  });
});
