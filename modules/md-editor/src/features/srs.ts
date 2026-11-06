/**
 * Spaced repetition scheduling (SM-2 variant, Logseq-compatible property names).
 * Pure logic — unit-testable under plain vitest.
 *
 * Card state lives in block properties:
 *   memory-repetition: successful review count
 *   memory-easiness:   SM-2 EF factor (default 2.5, floor 1.3)
 *   memory-interval:   days until next review
 *   memory-last-practiced-at: YYYY-MM-DD of last review
 */

export interface CardState {
  /** 0 = new / forgotten (due immediately). */
  repetition: number;
  easiness: number;
  /** Days since last practice until due. */
  interval: number;
  /** ISO date (YYYY-MM-DD) of the last practice; '' when never practiced. */
  lastPracticed: string;
}

export type Grade = 'again' | 'hard' | 'good' | 'easy';

export const DEFAULT_CARD_STATE: CardState = {
  repetition: 0,
  easiness: 2.5,
  interval: 0,
  lastPracticed: '',
};

export const MIN_EASINESS = 1.3;

const DAY = 24 * 60 * 60 * 1000;

function todayStr(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function daysBetween(a: string, b: Date): number | null {
  const m = a.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const nowDays = Math.floor(Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) / DAY);
  return Math.floor(d / DAY) - nowDays;
}

/** True when the card should be shown today (never practiced → due). */
export function isDue(state: CardState, now: Date = new Date()): boolean {
  if (!state.lastPracticed) return true;
  const elapsed = daysBetween(state.lastPracticed, now);
  if (elapsed === null) return true;
  return -elapsed >= state.interval; // elapsed>=interval
}

/**
 * Apply a review grade; returns the next state (immutable).
 * again resets the card (due immediately); hard/good/easy follow SM-2.
 */
export function review(state: CardState, grade: Grade, now: Date = new Date()): CardState {
  const today = todayStr(now);
  let { repetition, easiness, interval } = state;

  switch (grade) {
    case 'again':
      return { repetition: 0, easiness: Math.max(MIN_EASINESS, easiness - 0.2), interval: 0, lastPracticed: today };
    case 'hard':
      easiness = Math.max(MIN_EASINESS, easiness - 0.15);
      interval = interval <= 0 ? 1 : Math.max(1, Math.round(interval * 1.2));
      repetition += 1;
      break;
    case 'good':
      interval = repetition < 2 ? repetition + 1 : Math.max(1, Math.round(interval * easiness));
      repetition += 1;
      break;
    case 'easy':
      easiness += 0.15;
      interval = repetition < 2 ? repetition + 2 : Math.max(2, Math.round(interval * easiness * 1.3));
      repetition += 1;
      break;
  }
  return {
    repetition,
    easiness: Math.round(easiness * 100) / 100,
    interval,
    lastPracticed: today,
  };
}

/** Read CardState out of block props (missing keys fall back to defaults). */
export function stateFromProps(props: Record<string, string>): CardState {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    repetition: num(props['memory-repetition'], 0),
    easiness: Math.max(MIN_EASINESS, num(props['memory-easiness'], 2.5)),
    interval: num(props['memory-interval'], 0),
    lastPracticed: props['memory-last-practiced-at'] ?? '',
  };
}

/** Write CardState back into a props object (mutates, drops values equal to defaults). */
export function stateToProps(state: CardState, props: Record<string, string>): void {
  const d = DEFAULT_CARD_STATE;
  if (state.repetition !== d.repetition) props['memory-repetition'] = String(state.repetition);
  else delete props['memory-repetition'];
  if (state.easiness !== d.easiness) props['memory-easiness'] = String(Math.round(state.easiness * 100) / 100);
  else delete props['memory-easiness'];
  if (state.interval !== d.interval) props['memory-interval'] = String(state.interval);
  else delete props['memory-interval'];
  if (state.lastPracticed) props['memory-last-practiced-at'] = state.lastPracticed;
  else delete props['memory-last-practiced-at'];
}
