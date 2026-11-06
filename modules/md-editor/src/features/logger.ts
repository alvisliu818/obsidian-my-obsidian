/**
 * Obsidian-aware half of the operation log: in-memory ring buffer on the
 * plugin + debounced JSONL appends to `.logseq-editor/log.jsonl`.
 * Logging must never throw and must never block the operation it records.
 */

import { normalizePath } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import {
  type OperationRecord,
  type OpStatus,
  encodeRecord,
  decodeRecord,
  pushBounded,
  MEMORY_LIMIT,
  FILE_ROTATE_BYTES,
} from '../core/operationLog';

const LOG_DIR = '.logseq-editor';
const LOG_FILE = 'log.jsonl';

/** Build a record (clamps + fills defaults). */
export function makeRecord(op: string, file: string, status: OpStatus, detail = ''): OperationRecord {
  return { ts: Date.now(), op, file: file ?? '', status, detail: detail ?? '' };
}

/**
 * Record one operation: memory ring + scheduled disk append.
 * Safe to call from anywhere; never throws.
 */
export function logOp(plugin: LogseqEditorPlugin, op: string, file: string, status: OpStatus, detail = ''): void {
  try {
    const rec = makeRecord(op, file, status, detail);
    plugin.opLog = pushBounded(plugin.opLog ?? [], rec);
    plugin.opLogPending = [...(plugin.opLogPending ?? []), rec];
    scheduleFlush(plugin);
  } catch {
    /* logging must never break the caller */
  }
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced flush (coalesces bursts such as bulk moves / index rebuilds). */
export function scheduleFlush(plugin: LogseqEditorPlugin, delayMs = 1500): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushOpLog(plugin);
  }, delayMs);
}

/** Append pending records to the JSONL file (with size-based rotation). */
export async function flushOpLog(plugin: LogseqEditorPlugin): Promise<void> {
  const pending = plugin.opLogPending ?? [];
  plugin.opLogPending = [];
  if (pending.length === 0 || plugin.settings.opLogEnabled === false) return;
  try {
    const adapter = plugin.app.vault.adapter;
    try {
      await adapter.mkdir(normalizePath(LOG_DIR));
    } catch {
      /* exists */
    }
    const p = normalizePath(`${LOG_DIR}/${LOG_FILE}`);
    // Rotate when the file grew beyond the cap: keep one generation.
    try {
      const stat = await adapter.stat(p);
      if (stat && stat.size > FILE_ROTATE_BYTES) {
        const rot = normalizePath(`${LOG_DIR}/log.1.jsonl`);
        try {
          await adapter.remove(rot);
        } catch {
          /* no previous generation */
        }
        await adapter.rename(p, rot);
      }
    } catch {
      /* stat failed = file missing, nothing to rotate */
    }
    const lines = pending.map(encodeRecord).join('\n') + '\n';
    await adapter.append(normalizePath(p), lines);
  } catch (e) {
    // Last resort: keep the records in memory so they are not silently lost.
    plugin.opLogPending = [...(plugin.opLogPending ?? []), ...pending].slice(-MEMORY_LIMIT);
    try {
      logOpError(plugin, e);
    } catch {
      /* ignore */
    }
  }
}

/** A failed log write is itself logged (memory only, no recursion risk). */
function logOpError(plugin: LogseqEditorPlugin, e: unknown): void {
  plugin.opLog = pushBounded(plugin.opLog ?? [], makeRecord('oplog.flush', '', 'error', String(e)));
}

/** Load the newest records from disk into memory (called once at startup). */
export async function loadOpLog(plugin: LogseqEditorPlugin): Promise<void> {
  try {
    const adapter = plugin.app.vault.adapter;
    const data = await adapter.read(normalizePath(`${LOG_DIR}/${LOG_FILE}`));
    const lines = data.split('\n').filter((l) => l.trim() !== '');
    const tail = lines.slice(-MEMORY_LIMIT);
    const recs = tail.map(decodeRecord).filter((r): r is OperationRecord => r !== null);
    plugin.opLog = recs;
  } catch {
    plugin.opLog = plugin.opLog ?? [];
  }
}

/** Newest-first copy of the in-memory log (for the modal / export). */
export function recentOpLog(plugin: LogseqEditorPlugin): OperationRecord[] {
  return [...(plugin.opLog ?? [])].reverse();
}

/** Export the full in-memory log as a timestamped text file; returns its path. */
export async function exportOpLog(plugin: LogseqEditorPlugin): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const p = normalizePath(`${LOG_DIR}/export-${stamp}.log`);
  const body = (plugin.opLog ?? []).map((r) => {
    const d = new Date(r.ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const mark = r.status === 'ok' ? 'OK  ' : r.status === 'error' ? 'ERR ' : 'SKIP';
    return `${time} ${mark} ${r.op}${r.file ? ` ${r.file}` : ''}${r.detail ? ` — ${r.detail}` : ''}`;
  }).join('\n');
  try {
    await plugin.app.vault.adapter.write(p, body + '\n');
  } catch (e) {
    // Fall back to the backups dir name space; if that fails too, surface it.
    try {
      await plugin.app.vault.create(p, body + '\n');
    } catch {
      throw new Error(`Failed to write log export: ${String(e)}`);
    }
  }
  return p;
}
