/**
 * Pure journal-date helpers (no obsidian imports — unit-tested under vitest).
 *
 * Logseq md parity: journals are files named by a date format (default
 * YYYY-MM-DD). Navigation (prev/next day) must parse the date OUT of the
 * current file name, walk N days, and re-emit a file name in the SAME format.
 */

/** Format a Date using Logseq-style tokens (YYYY MM DD HH mm ss + free text). */
export function formatDateTokens(format: string, date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const map: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };
  // Longest tokens first so MM never eats the Milliseconds of YYYY etc.
  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => map[t] ?? t);
}

/** Regex-escape a literal string. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a strict matcher for a journal file name (no extension) in the given
 * format. Returns null when the format contains no full date (needs YYYY+MM+DD).
 */
export function journalNameMatcher(format: string): { re: RegExp; order: string[] } | null {
  const hasY = format.includes('YYYY');
  const hasM = format.includes('MM');
  const hasD = format.includes('DD');
  if (!hasY || !hasM || !hasD) return null;
  const order: string[] = [];
  let pattern = '';
  const tokens = format.match(/YYYY|MM|DD|HH|mm|ss|[^YMDHms]+/g) ?? [];
  for (const t of tokens) {
    if (t === 'YYYY') {
      order.push('Y');
      pattern += '(\\d{4})';
    } else if (t === 'MM') {
      order.push('M');
      pattern += '(\\d{2})';
    } else if (t === 'DD') {
      order.push('D');
      pattern += '(\\d{2})';
    } else if (t === 'HH' || t === 'mm' || t === 'ss') {
      order.push(t);
      pattern += '(\\d{2})';
    } else {
      pattern += escapeRe(t);
    }
  }
  return { re: new RegExp('^' + pattern + '$'), order };
}

/** Parse a journal file name into a Date at midnight; null when it doesn't match. */
export function journalDateOf(name: string, format = 'YYYY-MM-DD'): Date | null {
  const m = journalNameMatcher(format);
  if (!m) return null;
  const hit = m.re.exec(name);
  if (!hit) return null;
  let y = 1970;
  let mo = 0;
  let d = 1;
  for (let i = 0; i < m.order.length; i++) {
    const kind = m.order[i];
    const v = Number(hit[i + 1]);
    if (kind === 'Y') y = v;
    else if (kind === 'M') mo = v - 1;
    else if (kind === 'D') d = v;
  }
  const date = new Date(y, mo, d);
  if (Number.isNaN(date.getTime())) return null;
  // Reject impossible dates like 2026-02-31 (Date rolls over silently).
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) return null;
  return date;
}

/** Shift a Date by N days (calendar-safe across month/year boundaries). */
export function addDays(date: Date, days: number): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * True when the file name looks like a journal in the given format.
 * The default format also accepts compact `YYYYMMDD` (Logseq's alt naming).
 */
export function looksLikeJournal(name: string, format = 'YYYY-MM-DD'): boolean {
  return journalDateOf(name, format) !== null || journalDateOf(name, 'YYYYMMDD') !== null;
}
