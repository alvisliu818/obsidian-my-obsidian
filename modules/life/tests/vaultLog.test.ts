// 库记录引擎纯逻辑:diff 语义/重命名配对/调度判定/行锚解析(阶段 C, 2026-11-19;
// 识别改进 2026-11-20;列表倒序与日期筛选 2026-11-21)。
import { describe, expect, it } from 'vitest';
import { diffSigTable, diffWithRenames, changeSummary, parseHHmm, dailyDue, periodDue, sigKey, scanVaultSig, sortVaultLogRecordsDesc, filterVaultLogRecordsByDate, diffLines } from '../src/vaultLog';
import type { VaultLogRecord } from '../src/types';
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

describe('diffWithRenames(重命名/移动配对, 2026-11-20)', () => {
  it('签名一致的 删除↔新增 配成重命名', () => {
    const prev = { 'old/a.md': '1:10', 'keep.md': '2:20' };
    const cur = { 'new/a.md': '1:10', 'keep.md': '2:20' };
    const d = diffWithRenames(prev, cur);
    expect(d.renames).toEqual([{ from: 'old/a.md', to: 'new/a.md' }]);
    expect(d.added).toEqual([]);
    expect(d.deleted).toEqual([]);
    expect(d.modified).toEqual([]);
  });

  it('文件夹移动 = 多对配对', () => {
    const prev = { 'P/x.md': '1:1', 'P/y.md': '2:2' };
    const cur = { 'Q/x.md': '1:1', 'Q/y.md': '2:2' };
    const d = diffWithRenames(prev, cur);
    expect(d.renames).toEqual([
      { from: 'P/x.md', to: 'Q/x.md' },
      { from: 'P/y.md', to: 'Q/y.md' },
    ]);
  });

  it('签名不一致(改名后改内容)不配对,诚实降级 删除+新增', () => {
    const prev = { 'a.md': '1:10' };
    const cur = { 'b.md': '1:99' };
    const d = diffWithRenames(prev, cur);
    expect(d.renames).toEqual([]);
    expect(d.added).toEqual(['b.md']);
    expect(d.deleted).toEqual(['a.md']);
  });

  it('同签名多候选按路径序确定配对', () => {
    const prev = { 'z.md': '1:5', 'a.md': '1:5' };
    const cur = { 'new.md': '1:5' };
    const d = diffWithRenames(prev, cur);
    expect(d.renames).toEqual([{ from: 'a.md', to: 'new.md' }]);
    expect(d.deleted).toEqual(['z.md']);
  });

  it('changeSummary 带重命名计数', () => {
    const d = diffWithRenames({ 'a.md': '1:1' }, { 'b.md': '1:1' });
    expect(changeSummary(d, d.renames.length)).toBe('新增 0 · 修改 0 · 删除 0 · 重命名 1');
    expect(changeSummary(d)).toBe('新增 0 · 修改 0 · 删除 0');
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
    expect(periodDue(noon, 30, noon.getTime() - 3600000)).toBe(true);
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

describe('记录列表倒序与日期筛选(2026-11-21)', () => {
  const mk = (id: string, date: string): VaultLogRecord => ({
    id,
    at: `${date}T12:00:00.000Z`,
    date,
    trigger: 'manual',
    added: [],
    modified: [],
    deleted: [],
    totalFiles: 0,
  });

  it('sortVaultLogRecordsDesc:按 date 从新到旧(存储序若乱也能兜底)', () => {
    const recs = [mk('a', '2026-11-19'), mk('b', '2026-11-21'), mk('c', '2026-11-20')];
    expect(sortVaultLogRecordsDesc(recs).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  describe('diffLines:修改对比行级 diff', () => {
    const d = (before: string, after: string) => diffLines(before, after);
    it('纯新增:行号落在 after 坐标', () => {
      const r = d('a\nc', 'a\nb\nc');
      expect(r.added).toEqual([2]);
      expect(r.modified).toEqual([]);
      expect(r.deleted).toEqual([]);
    });
    it('纯删除:记插入点与文本', () => {
      const r = d('a\nb\nc', 'a\nc');
      expect(r.added).toEqual([]);
      expect(r.modified).toEqual([]);
      expect(r.deleted).toEqual([{ line: 2, text: 'b' }]);
    });
    it('替换块 = 修改(蓝)', () => {
      const r = d('a\nold\nc', 'a\nnew\nc');
      expect(r.added).toEqual([]);
      expect(r.modified).toEqual([2]);
      expect(r.deleted.map((x) => x.text)).toEqual(['old']);
    });
    it('混合:独立新增与替换并存', () => {
      const r = d('a\nold\nkeep\nz', 'a\nnew\nkeep\nz\nextra');
      expect(r.modified).toEqual([2]);
      expect(r.added).toEqual([5]);
      expect(r.deleted.map((x) => x.text)).toEqual(['old']);
    });
    it('公共前后缀裁剪后仍精确(换空行 = 修改)', () => {
      const r = d('head\nx\ntail', 'head\n\ntail');
      expect(r.modified).toEqual([2]);
      expect(r.deleted).toEqual([{ line: 2, text: 'x' }]);
    });
    it('空 → 全新增', () => {
      const r = d('', 'a\nb');
      expect(r.added).toEqual([1, 2]);
    });
    it('rows 含全文:公共前后缀上下文也进对齐序列(分栏要展示全文)', () => {
      const r = d('head\nA\nkeep\ntail', 'head\nB\nkeep\ntail');
      expect(r.rows.length).toBe(5);
      expect(r.rows.filter((x) => x.kind === 'ctx').map((x) => x.text)).toEqual(['head', 'keep', 'tail']);
      expect(r.rows[0]).toMatchObject({ beforeLine: 1, afterLine: 1, text: 'head' });
      expect(r.rows[r.rows.length - 1]).toMatchObject({ beforeLine: 4, afterLine: 4, text: 'tail' });
    });
  });

  it('sortVaultLogRecordsDesc:同日保持传入次序(稳定,不依赖 rec.at 秒级字段)', () => {
    // 传入序即存储序(同日新在前);同日比较为 0 → 稳定排序原样保留
    const recs = [mk('later', '2026-11-20'), mk('earlier', '2026-11-20'), mk('x', '2026-11-19')];
    expect(sortVaultLogRecordsDesc(recs).map((r) => r.id)).toEqual(['later', 'earlier', 'x']);
  });

  it('sortVaultLogRecordsDesc:返回新数组,不改传入序(存储序不动)', () => {
    const recs = [mk('old', '2026-11-01'), mk('new', '2026-11-21')];
    const sorted = sortVaultLogRecordsDesc(recs);
    expect(sorted).not.toBe(recs);
    expect(recs.map((r) => r.id)).toEqual(['old', 'new']);
    expect(sorted.map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('filterVaultLogRecordsByDate:空串 = 不过滤,指定日期只留该天', () => {
    const recs = [mk('a', '2026-11-21'), mk('b', '2026-11-20'), mk('c', '2026-11-21')];
    expect(filterVaultLogRecordsByDate(recs, '')).toBe(recs);
    expect(filterVaultLogRecordsByDate(recs, '2026-11-21').map((r) => r.id)).toEqual(['a', 'c']);
    expect(filterVaultLogRecordsByDate(recs, '2026-11-01')).toEqual([]);
  });
});
