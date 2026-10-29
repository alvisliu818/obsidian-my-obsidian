/**
 * TraceTime parity: the TraceTime plugin ("Show when each block of a note was
 * last edited") only decorates native editors — its CM6 overlay is built on a
 * whole-file document and its layout-change cleanup evicts files that are not
 * open in a native markdown view, so the block editor never shows anything.
 *
 * This module reads TraceTime's own tracker (per-file block index + recorded
 * minutes) and matches the outline's blocks onto its index entries, so the
 * same timestamps render at the block rows' right edge using the plugin's own
 * `.tracetime-label` styles and its relative/absolute formatting. Inert when
 * TraceTime is not installed or disabled.
 */
import type { App } from 'obsidian';
import type { Block } from '../types';
import { serializeBlock } from '../core/serializer';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface TraceTimeEntry {
  from: number;
  to: number;
  modifiedAt: number;
}

export interface TraceTimeState {
  index: { blocks: TraceTimeEntry[] };
  text: string;
}

export interface TraceTimeSettings {
  tracker: {
    getState: (path: string) => TraceTimeState | undefined;
    ensureFile: (path: string) => void;
  } | null;
  settings: Record<string, any>;
}

/** The installed TraceTime plugin (null when absent or disabled). */
export function traceTimePluginOf(app: App): TraceTimeSettings | null {
  // App.plugins exists at runtime but is absent from the public typings.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pluginApi = (app as any).plugins;
  const p = pluginApi?.plugins?.['tracetime'];
  if (!p || !pluginApi?.enabledPlugins?.has('tracetime') || !p.tracker) return null;
  return p as TraceTimeSettings;
}

/** TraceTime's own block normalization: collapse inner whitespace, trim, drop empty lines. */
function normalizedLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.replace(/\s+/g, ' ').trim();
    if (t.length > 0) out.push(t);
  }
  return out;
}

export interface TraceTimeIndex {
  /** index entries with their normalized lines, in document order */
  entries: { entry: TraceTimeEntry; lines: string[] }[];
  /** every normalized line → entry indices (TraceTime merges sibling list
      items without blank lines into ONE entry, so a block may start mid-entry) */
  byLine: Map<string, number[]>;
}

/** Rebuild the lookup structures from a tracker state (cheap: line slicing only). */
export function buildTraceTimeIndex(st: { index: { blocks: TraceTimeEntry[] }; text: string }): TraceTimeIndex | null {
  const blocks = st?.index?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0 || typeof st?.text !== 'string') return null;
  const entries = blocks
    .map((entry) => ({ entry, lines: normalizedLines(st.text.slice(entry.from, entry.to)) }))
    .filter((e) => e.lines.length > 0);
  const byLine = new Map<string, number[]>();
  entries.forEach((e, i) => {
    for (const line of e.lines) {
      const list = byLine.get(line) ?? [];
      list.push(i);
      byLine.set(line, list);
    }
  });
  return { entries, byLine };
}

/**
 * The recorded time of the TraceTime block containing `b`: the outline block's
 * serialized lines (indentation is erased by the shared normalization, so any
 * block matches regardless of depth) must appear as a consecutive run of the
 * entry's lines — TraceTime merges sibling list items that have no blank line
 * between them into ONE block, and they all share its timestamp.
 */
export function traceTimeModifiedAt(index: TraceTimeIndex, b: Block): number | null {
  const ours = normalizedLines(serializeBlock(b, 0));
  if (ours.length === 0) return null;
  const candidates = index.byLine.get(ours[0]) ?? [];
  let fallback: number | null = null;
  for (const ci of candidates) {
    const lines = index.entries[ci].lines;
    let hit = false;
    for (let k = 0; k + ours.length <= lines.length; k++) {
      let ok = true;
      for (let j = 0; j < ours.length; j++) {
        if (lines[k + j] !== ours[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    if (lines.length === ours.length) return index.entries[ci].entry.modifiedAt; // exact block match wins
    if (fallback === null) fallback = index.entries[ci].entry.modifiedAt; // our block inside a merged block
  }
  return fallback;
}

/** TraceTime's own relative/absolute label (ported from its format.ts). */
export function formatTraceTimestamp(minutes: number, settings: Record<string, any>, now = new Date()): string {
  const d = new Date(minutes * 60_000);
  const diffMin = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60_000));
  if (settings.justNowMinutes > 0 && diffMin < settings.justNowMinutes) return '刚刚';
  if (settings.minutesAgoLimit > 0 && diffMin < settings.minutesAgoLimit) return `${diffMin} 分钟前`;
  const diffHours = Math.floor(diffMin / 60);
  if (settings.hoursAgoLimit > 0 && diffHours >= 1 && diffHours < settings.hoursAgoLimit) return `${diffHours} 小时前`;
  const daySerial = (x: Date): number => Math.floor(new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() / 86_400_000);
  const dayDiff = daySerial(now) - daySerial(d);
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  if (settings.todayTimeOnly && dayDiff === 0) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (settings.yesterdayWithTime && dayDiff === 1) return `昨天 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (settings.daysAgoLimit > 0 && dayDiff >= 1 && dayDiff <= settings.daysAgoLimit) return `${dayDiff} 天前`;
  if (settings.thisYearShort && d.getFullYear() === now.getFullYear()) return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const format: string = settings.dateFormat || 'YYYY-MM-DD HH:mm';
  const tokens: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: pad2(d.getFullYear() % 100),
    MM: pad2(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    DD: pad2(d.getDate()),
    D: String(d.getDate()),
    HH: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    W: String(Math.ceil(d.getDate() / 7)),
  };
  return format.replace(/YYYY|YY|MM|M|DD|D|HH|mm|W/g, (t) => tokens[t] ?? t);
}
