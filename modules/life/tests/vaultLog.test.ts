// 库记录引擎纯逻辑:diff 语义/调度判定/行锚解析(阶段 C, 2026-11-19)。
import { describe, expect, it } from 'vitest';
import { diffSigTable, parseHHmm, dailyDue, periodDue, sigKey, scanVaultSig } from '../src/vaultLog';
import { parseCodeEmbedInner } from '../../md-editor/src/features/codeEmbed';

describe('diffSigTable(相对上一次快照的变化)', () => {
  it('新增/修改/删除 三类分流', () => {
    const prev = { 'a.md': '1:10', 'b.md': '2:20', 'c.md': '3:30' };
    const cur = { 'a.md': '1:10', 'b.md': '2:99', 'd.md': '4:40' };
    expect(diffSigTable(prev, cur)).toEqual({
      added: ['d.md'],
      modified: ['b.md'],
      deleted: ['c.md'],
    });
  });
  it('空快照 vs 全量 = 全部新增(首条记录语义)', () => {
    const d = diffSigTable({}, { 'a.md': '1:1' });
    expect(d.added).toEqual(['a.md']);
  });
});

describe('调度判定', () => {
  const noon = new Date(2026, 10, 20, 12, 0);
  it('parseHHmm 合法/非法', () => {
    expect(parseHHmm('21:00')).toBe(21 * 60);
    expect(parseHHmm('9:5')).toBe(null);
    expect(parseHHmm('25:00')).toBe(null);
  });
  it('dailyDue:当日已过该分钟且归属日不同才到期', () => {
    expect(dailyDue(noon, '09:00', '')).toBe(true);
    expect(dailyDue(noon, '09:00', '2026-11-20')).toBe(false);
    expect(dailyDue(noon, '13:00', '')).toBe(false);
  });
  it('periodDue:周期关/上次未知 = 不到期', () => {
    expect(periodDue(noon, 30, Date.now() - 3600000)).toBe(true);
    expect(periodDue(noon, 30, 0)).toBe(false);
    expect(periodDue(noon, 0, Date.now() - 3600000)).toBe(false);
  });
});

describe('签名表与形状判定', () => {
  it('sigKey 紧凑签名', () => {
    expect(sigKey(1000, 42)).toBe('1000:42');
  });
  it('scanVaultSig 覆盖 getFiles 全量', () => {
    const vault = { getFiles: () => [{ path: 'a.md', stat: { mtime: 1, size: 2 } }] };
    expect(scanVaultSig(vault)).toEqual({ 'a.md': '1:2' });
  });
  it('parseCodeEmbedInner:target#L 行锚形状(嵌入链接复用)', () => {
    expect(parseCodeEmbedInner('E2E/x.py#L2-L4')).toEqual({ target: 'E2E/x.py', start: 2, end: 4 });
    expect(parseCodeEmbedInner('x.py#L7')).toEqual({ target: 'x.py', start: 7, end: 7 });
    expect(parseCodeEmbedInner('x.py')).toBe(null);
    expect(parseCodeEmbedInner('x.py#L0')).toBe(null);
  });
});
