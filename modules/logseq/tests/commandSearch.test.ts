/* 批次 34：命令搜索评分（思源 command/search.ts 1:1 移植）。
 * 纯函数测试：归一/驼峰拆分/token 全命中/分层评分/去空格变体/同分稳定序。 */
import { describe, expect, it } from 'vitest';
import {
  normalizeCommandSearchText,
  searchCommands,
  type SearchableCommand,
} from '../src/features/commandSearch';

describe('normalizeCommandSearchText', () => {
  it('驼峰拆分 + 分隔符转空格 + 小写', () => {
    expect(normalizeCommandSearchText('insertCodeBlock')).toBe('insert code block');
    expect(normalizeCommandSearchText('block-ref')).toBe('block ref');
    expect(normalizeCommandSearchText('a.b/c_d')).toBe('a b c d');
    expect(normalizeCommandSearchText('  多  空格 ')).toBe('多 空格');
  });
});

describe('searchCommands', () => {
  const cmds: SearchableCommand[] = [
    { label: 'Bold', group: 'Format', detail: 'wrap **', id: 'format.bold' },
    { label: 'Insert Code Block', group: 'Insert', detail: '```', id: 'insert.codeBlock' },
    { label: 'Bullet list', group: 'Paragraph', id: 'para.bullet' },
  ];
  const labels = (items: SearchableCommand[]) => items.map((c) => c.label);

  it('token 全命中：多 token 各自命中某字段', () => {
    // 'code block'：Code Block 命中 label；Bold 的 detail 含 'block' 但无 'code' → 淘汰
    expect(labels(searchCommands(cmds, 'code block'))).toEqual(['Insert Code Block']);
  });

  it('精确 > 前缀 > 包含 分层评分', () => {
    const items: SearchableCommand[] = [
      { label: 'Code' },          // 包含（'codex' 前缀命中它自己——精确者胜）
      { label: 'Codex' },         // 前缀 'code' → 但精确 label 'Code' 的 normalize='code' === query → 300
      { label: 'Decode' },        // 包含 'code' → 100
    ];
    expect(labels(searchCommands(items, 'code'))).toEqual(['Code', 'Codex', 'Decode']);
  });

  it('去空格变体：紧凑输入命中多词字段', () => {
    expect(labels(searchCommands(cmds, 'codeblock'))).toEqual(['Insert Code Block']);
    // 原始 includes 做不到这一点（'codeblock' 不在 'insert code block' 里）
  });

  it('驼峰输入命中驼峰源', () => {
    expect(labels(searchCommands(cmds, 'cb'))).toEqual([]); // 无 token 全命中
    expect(labels(searchCommands(cmds, 'format bold'))).toEqual(['Bold']);
  });

  it('同分保原始序', () => {
    const same: SearchableCommand[] = [{ label: 'Alpha' }, { label: 'Alphabet' }];
    // 'alphabet'：token 全命中守卫——'alpha' 字段不含 'alphabet'，Alpha 淘汰
    expect(labels(searchCommands(same, 'alphabet'))).toEqual(['Alphabet']);
    // 同 100 分按原始序
    const both: SearchableCommand[] = [{ label: 'Xa' }, { label: 'Ya' }];
    expect(labels(searchCommands(both, 'a'))).toEqual(['Xa', 'Ya']);
    // 'alp'：两者同为前缀 200 分 → 同分保原始序（Alpha 先）
    expect(labels(searchCommands(same, 'alp'))).toEqual(['Alpha', 'Alphabet']);
  });

  it('无命中返回空', () => {
    expect(searchCommands(cmds, 'zzz')).toEqual([]);
  });
});
