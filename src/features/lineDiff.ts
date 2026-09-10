/**
 * LCS-based line diff (pure, no Obsidian imports — unit-testable).
 * Used by the external-change conflict modal.
 */

export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

export interface DiffRow {
  kind: 'same' | 'add' | 'del' | 'gap';
  text: string;
  /** Collapsed unchanged-line count (gap rows only, 1 otherwise). */
  count: number;
}

/**
 * Line diff via LCS. Past the line cap the diff degrades to a wholesale
 * delete+add pair to bound memory (O(n·m) DP table).
 */
export function lineDiff(a: string, b: string, cap = 1500): DiffLine[] {
  const A = a.split('\n');
  const B = b.split('\n');
  if (A.length > cap || B.length > cap) {
    const out: DiffLine[] = A.map((text) => ({ type: 'del' as const, text }));
    for (const text of B) out.push({ type: 'add' as const, text });
    return out;
  }
  const n = A.length;
  const m = B.length;
  // dp[i][j] = LCS length of A[i..] vs B[j..]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = A[i] === B[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ type: 'same', text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: A[i] });
      i++;
    } else {
      out.push({ type: 'add', text: B[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: A[i++] });
  while (j < m) out.push({ type: 'add', text: B[j++] });
  return out;
}

/**
 * Collapse runs of unchanged lines longer than 2*context+1 into gap rows so
 * the diff view only shows neighborhoods of actual changes.
 */
export function collapseDiff(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.type !== 'same') {
      for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
        keep[k] = true;
      }
    }
  });
  const rows: DiffRow[] = [];
  let gap = 0;
  const flushGap = (): void => {
    if (gap > 0) {
      rows.push({ kind: 'gap', text: '', count: gap });
      gap = 0;
    }
  };
  for (let idx = 0; idx < lines.length; idx++) {
    if (keep[idx]) {
      flushGap();
      rows.push({ kind: lines[idx].type, text: lines[idx].text, count: 1 });
    } else {
      gap++;
    }
  }
  flushGap();
  return rows;
}
