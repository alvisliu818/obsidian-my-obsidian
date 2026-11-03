/**
 * Operation log pure helpers: encode/decode round-trip, ring buffer eviction,
 * detail clamping, formatting.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeRecord,
  decodeRecord,
  pushBounded,
  clampDetail,
  formatRecord,
  MEMORY_LIMIT,
  type OperationRecord,
} from '../src/core/operationLog';

const rec = (over: Partial<OperationRecord> = {}): OperationRecord => ({
  ts: 1758447600000,
  op: 'test.op',
  file: 'a/b.md',
  status: 'ok',
  detail: 'fine',
  ...over,
});

describe('operationLog', () => {
  it('encode/decode round-trips a record', () => {
    const line = encodeRecord(rec());
    expect(line).not.toContain('\n');
    const back = decodeRecord(line);
    expect(back).toEqual(rec());
  });

  it('decode tolerates malformed lines', () => {
    expect(decodeRecord('not json')).toBeNull();
    expect(decodeRecord('{"op":"x"}')).toBeNull(); // missing ts
    expect(decodeRecord('{"ts":1}')).toBeNull(); // missing op
  });

  it('decode coerces bad enum/field types instead of crashing', () => {
    const r = decodeRecord('{"ts":5,"op":"x","status":"weird","file":42,"detail":7}');
    expect(r).toEqual({ ts: 5, op: 'x', file: '', status: 'ok', detail: '' });
  });

  it('clampDetail squashes whitespace and caps length', () => {
    expect(clampDetail('a\n  b\t c')).toBe('a b c');
    const long = clampDetail('x'.repeat(1000), 100);
    expect(long.length).toBe(100);
    expect(long.endsWith('…')).toBe(true);
  });

  it('pushBounded keeps the newest records and evicts the oldest', () => {
    let buf: OperationRecord[] = [];
    for (let i = 0; i < MEMORY_LIMIT + 10; i++) {
      buf = pushBounded(buf, rec({ op: `op${i}` }));
    }
    expect(buf.length).toBe(MEMORY_LIMIT);
    expect(buf[0].op).toBe(`op${10}`);
    expect(buf[buf.length - 1].op).toBe(`op${MEMORY_LIMIT + 9}`);
  });

  it('formatRecord is locale-independent and marks status', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5);
    const s = formatRecord(rec({ ts: d.getTime(), status: 'error' }));
    expect(s).toContain('2026-01-02 03:04:05');
    expect(s).toContain('✗');
    expect(s).toContain('test.op');
    expect(s).toContain('a/b.md');
  });
});
