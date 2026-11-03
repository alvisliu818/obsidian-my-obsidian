/**
 * Operation log: an append-only, exportable trace of every sync/conversion/
 * write operation the plugin performs (successes AND failures).
 *
 * Design:
 * - In-memory ring buffer (bounded) for the "show log" modal.
 * - JSONL persistence under `.logseq-editor/log.jsonl` (debounced appends)
 *   so the trail survives reloads and can be exported for debugging.
 * - Pure helpers are dependency-free and unit-tested under vitest.
 * - Never throws: logging must not break the operation it records.
 */

export type OpStatus = 'ok' | 'error' | 'skipped';

export interface OperationRecord {
  /** Epoch ms. */
  ts: number;
  /** Machine-readable operation id, e.g. 'backup.create', 'blocks.move'. */
  op: string;
  /** Vault-relative file path(s) involved ('' when none). */
  file: string;
  status: OpStatus;
  /** Human-readable detail (error message, counts, reasons...). */
  detail: string;
}

/** Hard cap for the in-memory ring buffer. */
export const MEMORY_LIMIT = 500;
/** Hard cap for one JSONL log file before it is rotated (~256 KB). */
export const FILE_ROTATE_BYTES = 256 * 1024;

/** Clamp a detail string to a sane length so one huge payload can't bloat the log. */
export function clampDetail(detail: string, max = 400): string {
  const s = detail.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Serialize one record as a JSONL line (single line, no raw newlines). */
export function encodeRecord(r: OperationRecord): string {
  return JSON.stringify({ ...r, detail: clampDetail(r.detail) });
}

/** Parse a JSONL line back into a record; null when malformed (tolerated). */
export function decodeRecord(line: string): OperationRecord | null {
  try {
    const o = JSON.parse(line) as Partial<OperationRecord>;
    if (typeof o.ts !== 'number' || typeof o.op !== 'string') return null;
    return {
      ts: o.ts,
      op: o.op,
      file: typeof o.file === 'string' ? o.file : '',
      status: o.status === 'error' || o.status === 'skipped' ? o.status : 'ok',
      detail: typeof o.detail === 'string' ? o.detail : '',
    };
  } catch {
    return null;
  }
}

/** Keep the newest `limit` records (ring-buffer eviction, oldest dropped first). */
export function pushBounded(buf: OperationRecord[], r: OperationRecord, limit = MEMORY_LIMIT): OperationRecord[] {
  buf.push(r);
  return buf.length > limit ? buf.slice(buf.length - limit) : buf;
}

/** Render a record for the modal / export (locale-independent YYYY-MM-DD HH:mm:ss). */
export function formatRecord(r: OperationRecord): string {
  const d = new Date(r.ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const mark = r.status === 'ok' ? '✓' : r.status === 'error' ? '✗' : '·';
  return `${time} ${mark} ${r.op}${r.file ? ` ${r.file}` : ''}${r.detail ? ` — ${r.detail}` : ''}`;
}
