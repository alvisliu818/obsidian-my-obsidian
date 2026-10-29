import { describe, expect, it } from 'vitest';
import { DEFAULT_CARD_STATE, isDue, review, stateFromProps, stateToProps } from '../src/features/srs';

const NOW = new Date(2026, 8, 9); // 2026-09-09
const dayStr = (offset: number): string => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

describe('isDue', () => {
  it('new card is due', () => {
    expect(isDue(DEFAULT_CARD_STATE, NOW)).toBe(true);
  });

  it('practiced card due after interval elapses', () => {
    const s = { ...DEFAULT_CARD_STATE, interval: 3, lastPracticed: dayStr(-3) };
    expect(isDue(s, NOW)).toBe(true); // 3 days elapsed >= 3
    const s2 = { ...DEFAULT_CARD_STATE, interval: 3, lastPracticed: dayStr(-1) };
    expect(isDue(s2, NOW)).toBe(false);
  });

  it('interval 0 → always due', () => {
    const s = { ...DEFAULT_CARD_STATE, interval: 0, lastPracticed: dayStr(0) };
    expect(isDue(s, NOW)).toBe(true);
  });

  it('garbage date → due (safe default)', () => {
    const s = { ...DEFAULT_CARD_STATE, interval: 99, lastPracticed: 'nonsense' };
    expect(isDue(s, NOW)).toBe(true);
  });
});

describe('review', () => {
  it('again resets the card', () => {
    const s = { repetition: 5, easiness: 2.5, interval: 20, lastPracticed: dayStr(-20) };
    const n = review(s, 'again', NOW);
    expect(n.repetition).toBe(0);
    expect(n.interval).toBe(0);
    expect(n.lastPracticed).toBe('2026-09-09');
    expect(isDue(n, NOW)).toBe(true);
  });

  it('good on new card: interval 1', () => {
    const n = review(DEFAULT_CARD_STATE, 'good', NOW);
    expect(n.repetition).toBe(1);
    expect(n.interval).toBe(1);
  });

  it('good growth follows easiness', () => {
    let s = review(DEFAULT_CARD_STATE, 'good', NOW); // rep1 int1
    s = review(s, 'good', NOW); // rep2 int2
    s = review(s, 'good', NOW); // rep3 int = 2*2.5 = 5
    expect(s.repetition).toBe(3);
    expect(s.interval).toBe(5);
  });

  it('easy gets longer intervals and raises easiness', () => {
    const n = review(DEFAULT_CARD_STATE, 'easy', NOW);
    expect(n.easiness).toBe(2.65);
    expect(n.interval).toBe(2); // rep 0 < 2 → 0 + 2
    let s = n;
    s = review(s, 'easy', NOW); // rep 1 < 2 → 1 + 2 = 3, ease 2.8
    expect(s.interval).toBe(3);
    s = review(s, 'easy', NOW); // rep 2 ≥ 2 → round(3 * 2.95 * 1.3) = round(11.505) = 12
    expect(s.easiness).toBe(2.95);
    expect(s.interval).toBe(12);
  });

  it('hard lowers easiness but never below 1.3', () => {
    let s = { ...DEFAULT_CARD_STATE, easiness: 1.35, interval: 10, repetition: 4 };
    for (let i = 0; i < 5; i++) s = review(s, 'hard', NOW);
    expect(s.easiness).toBe(1.3);
    expect(s.interval).toBeGreaterThan(0);
  });

  it('does not mutate the input state', () => {
    const s = { ...DEFAULT_CARD_STATE, interval: 10, repetition: 3 };
    const before = { ...s };
    review(s, 'good', NOW);
    expect(s).toEqual(before);
  });
});

describe('props round-trip', () => {
  it('stateFromProps handles missing keys', () => {
    expect(stateFromProps({})).toEqual(DEFAULT_CARD_STATE);
    expect(stateFromProps({ 'memory-repetition': '3' })).toEqual({
      ...DEFAULT_CARD_STATE,
      repetition: 3,
    });
  });

  it('stateFromProps sanitizes bad numbers', () => {
    expect(stateFromProps({ 'memory-easiness': 'abc' }).easiness).toBe(2.5);
    expect(stateFromProps({ 'memory-repetition': '-5' }).repetition).toBe(0);
  });

  it('stateToProps writes and cleans', () => {
    const props: Record<string, string> = {};
    const s = review(DEFAULT_CARD_STATE, 'good', NOW);
    stateToProps(s, props);
    expect(props).toEqual({
      'memory-repetition': '1',
      'memory-interval': '1',
      'memory-last-practiced-at': '2026-09-09',
    });
    // back to defaults → keys removed
    stateToProps(DEFAULT_CARD_STATE, props);
    expect(props).toEqual({});
  });

  it('full round-trip preserves scheduling', () => {
    let s = DEFAULT_CARD_STATE;
    s = review(s, 'good', NOW);
    s = review(s, 'easy', NOW);
    const props: Record<string, string> = {};
    stateToProps(s, props);
    expect(stateFromProps(props)).toEqual(s);
  });
});
