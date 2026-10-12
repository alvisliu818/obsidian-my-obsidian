/**
 * Block type conversion.
 *
 * Converting means rewriting the markdown: strip whatever structural syntax
 * the block currently carries, then wrap the remaining content in the target
 * type's syntax. Nothing else changes — properties, children and the block id
 * are the caller's business, and a conversion that keeps `kind: 'list'` keeps
 * all of them.
 *
 * Two conversions produce a **verbatim** block (`raw` kind: tables, dividers,
 * lists, footnotes). Those serialize as-is, so the block loses its own
 * `id::` property and cannot hold children — `isVerbatimType()` lets the UI
 * say so instead of silently dropping links.
 *
 * Pure logic — no obsidian import.
 */

import type { Marker } from '../types';
import {
  calloutFold,
  calloutKind,
  codeLang,
  detectBlockType,
  headingLevel,
  isVerbatimType,
  type BlockType,
  type ConvertTarget,
} from './blockTypes';

export interface BlockShape {
  kind: 'list' | 'raw';
  text: string;
  marker?: Marker;
}

export interface ConvertOptions {
  /** Heading level 1-6 (defaults to the current level, or 1). */
  headingLevel?: number;
  /** Callout kind, e.g. `note` / `warning` (defaults to current, or `note`). */
  callout?: string;
  /** Fenced code language (defaults to current). */
  lang?: string;
  /** Callout fold: `-` collapsed, `+` expanded. */
  fold?: '' | '-' | '+';
}

/** Obsidian's built-in callout kinds. */
export const CALLOUT_KINDS: readonly string[] = [
  'note',
  'abstract',
  'info',
  'tip',
  'success',
  'question',
  'warning',
  'failure',
  'danger',
  'bug',
  'example',
  'quote',
];

/** Block types a block can be converted into (order = menu order). */
export const CONVERT_TARGETS: readonly ConvertTarget[] = [
  'paragraph',
  'heading',
  'task',
  'quote',
  'callout',
  'code',
  'math',
  'table',
  'list',
  'ordered',
  'divider',
  'footnote',
];

const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^(`{3,}|~{3,})\s*$/;
const QUOTE_PREFIX_RE = /^\s*>\s?/;
const HEADING_PREFIX_RE = /^#{1,6}\s+/;
const FOOTNOTE_PREFIX_RE = /^\[\^[^\]]+\]:\s*/;
const ITEM_PREFIX_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const MATH_DELIM_RE = /^\s*\$\$\s*$/;

// ---------------------------------------------------------------------------
// Strip: block text → bare content + the parameters the syntax carried
// ---------------------------------------------------------------------------

export interface BareContent {
  /** Content with every structural prefix removed. */
  text: string;
  /** Fenced code language ('' when the block is not code). */
  lang: string;
  /** Heading level 1-6 (0 when not a heading). */
  level: number;
  /** Callout kind ('' when not a callout). */
  callout: string;
  fold: '' | '-' | '+';
}

/**
 * Remove the current type's syntax. Converting A → B is `strip` then `wrap`,
 * so every pair is well defined (no direct A → B matrix to keep in sync).
 */
export function stripToBare(shape: BlockShape): BareContent {
  const text = shape.text ?? '';
  const type = detectBlockType(shape);
  const lines = text.split('\n');
  const base: BareContent = {
    text,
    lang: codeLang(text),
    level: headingLevel(text),
    callout: calloutKind(text),
    fold: calloutFold(text),
  };

  switch (type) {
    case 'code': {
      const open = FENCE_OPEN_RE.exec((lines[0] ?? '').trim());
      if (!open) return { ...base, text };
      const run = open[1][0];
      let end = lines.length;
      for (let i = 1; i < lines.length; i++) {
        const m = FENCE_CLOSE_RE.exec((lines[i] ?? '').trim());
        if (m && m[1][0] === run) {
          end = i;
          break;
        }
      }
      return { ...base, text: lines.slice(1, end).join('\n') };
    }
    case 'math': {
      const body = lines.slice(1);
      if (body.length > 0 && MATH_DELIM_RE.test(body[body.length - 1] ?? '')) body.pop();
      return { ...base, text: body.join('\n') };
    }
    case 'callout': {
      const dedented = lines.map((l) => l.replace(QUOTE_PREFIX_RE, ''));
      // Drop the `[!kind]` marker itself; the title after it is user text.
      const head = dedented[0] ?? '';
      dedented[0] = head.replace(/^\[!([a-zA-Z][\w-]*)\]([+-]?)\s*/, '');
      return { ...base, text: dedented.join('\n') };
    }
    case 'quote':
      return { ...base, text: lines.map((l) => l.replace(QUOTE_PREFIX_RE, '')).join('\n') };
    case 'heading': {
      const out = [...lines];
      out[0] = (out[0] ?? '').replace(HEADING_PREFIX_RE, '');
      return { ...base, text: out.join('\n') };
    }
    case 'table': {
      const rows: string[] = [];
      for (const raw of lines) {
        const l = raw.trim();
        if (!l.startsWith('|')) continue;
        const cells = l
          .replace(/^\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((c) => c.trim())
          .filter((c) => c !== '');
        // The delimiter row (`| --- |`) is formatting, not content.
        if (cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
        if (cells.length > 0) rows.push(cells.join(' · '));
      }
      return { ...base, text: rows.join('\n') };
    }
    case 'divider':
      return { ...base, text: '' };
    case 'list':
    case 'ordered':
      return { ...base, text: lines.map((l) => l.replace(ITEM_PREFIX_RE, '')).join('\n') };
    case 'footnote': {
      const out = [...lines];
      out[0] = (out[0] ?? '').replace(FOOTNOTE_PREFIX_RE, '');
      return { ...base, text: out.join('\n') };
    }
    case 'props':
      return { ...base, text: '' };
    case 'image':
    case 'video':
    case 'audio':
    case 'embed':
    case 'html':
      // Media/embed/HTML syntax carries no reusable text.
      return { ...base, text: '' };
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------
// Wrap: bare content → target syntax
// ---------------------------------------------------------------------------

function wrapLines(bare: string, prefix: (i: number, line: string) => string): string {
  return bare
    .split('\n')
    .map((l, i) => prefix(i, l))
    .join('\n');
}

/** Convert a block to `to`. Unknown / non-convertible targets return as-is. */
export function convertBlock(
  shape: BlockShape,
  to: BlockType,
  opts: ConvertOptions = {},
): BlockShape {
  const bareInfo = stripToBare(shape);
  const bare = bareInfo.text;
  const lines = bare.split('\n');

  switch (to) {
    case 'paragraph':
      return { kind: 'list', text: bare, marker: null };

    case 'task': {
      const marker: Marker = shape.marker ?? 'TODO';
      return { kind: 'list', text: bare, marker };
    }

    case 'heading': {
      const level = clampLevel(opts.headingLevel ?? (bareInfo.level || 1));
      return { kind: 'list', text: `${'#'.repeat(level)} ${bare}`, marker: null };
    }

    case 'quote':
      return {
        kind: 'list',
        text: wrapLines(bare, (_i, l) => (l.trim() === '' ? '>' : `> ${l}`)),
        marker: null,
      };

    case 'callout': {
      const kindName = (opts.callout ?? (bareInfo.callout || 'note')).toLowerCase();
      const fold = opts.fold ?? bareInfo.fold;
      const head = lines[0] ?? '';
      const rest = lines.slice(1);
      const first = `> [!${kindName}]${fold} ${head}`.trimEnd();
      const body = rest.map((l) => (l.trim() === '' ? '>' : `> ${l}`));
      return { kind: 'list', text: [first, ...body].join('\n'), marker: null };
    }

    case 'code': {
      const lang = opts.lang ?? bareInfo.lang ?? '';
      return { kind: 'list', text: `\`\`\`${lang}\n${bare}\n\`\`\``, marker: null };
    }

    case 'math':
      return { kind: 'list', text: `$$\n${bare}\n$$`, marker: null };

    case 'table': {
      // Single column, one row per line: lossless for any text.
      const rows = lines.length > 0 ? lines : [''];
      return {
        kind: 'raw',
        text: ['| Content |', '| --- |', ...rows.map((r) => `| ${r} |`)].join('\n'),
      };
    }

    case 'list':
      return { kind: 'raw', text: wrapLines(bare, (_i, l) => `- ${l}`) };

    case 'ordered':
      return { kind: 'raw', text: wrapLines(bare, (i, l) => `${i + 1}. ${l}`) };

    case 'divider':
      return { kind: 'raw', text: '---' };

    case 'footnote':
      return { kind: 'raw', text: `[^1]: ${bare}` };

    default:
      // Media / embed / HTML / props are inserted, not converted into.
      return { ...shape };
  }
}

function clampLevel(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(6, Math.max(1, Math.round(n)));
}

// ---------------------------------------------------------------------------
// Targeted rewrites (cheaper and less lossy than a full conversion)
// ---------------------------------------------------------------------------

/** Raise / lower a heading level (6 wraps around to 1). Returns null if not a heading. */
export function cycleHeadingLevel(shape: BlockShape, delta: number): BlockShape | null {
  const level = headingLevel(shape.text);
  if (level === 0) return null;
  const next = ((level - 1 + delta + 6) % 6) + 1;
  const lines = shape.text.split('\n');
  lines[0] = `${'#'.repeat(next)} ${(lines[0] ?? '').replace(HEADING_PREFIX_RE, '')}`;
  return { ...shape, text: lines.join('\n') };
}

/** Set a heading's level explicitly. Returns null if not a heading. */
export function setHeadingLevel(shape: BlockShape, level: number): BlockShape | null {
  if (headingLevel(shape.text) === 0) return null;
  return cycleHeadingLevel(shape, clampLevel(level) - headingLevel(shape.text));
}

/** Change a callout's kind (note → warning ...). Returns null if not a callout. */
export function setCalloutKind(shape: BlockShape, kind: string): BlockShape | null {
  const bare = stripToBare(shape);
  if (!bare.callout) return null;
  return convertBlock(shape, 'callout', { callout: kind });
}

/** Change a fenced code block's language. Returns null if not code. */
export function setCodeLang(shape: BlockShape, lang: string): BlockShape | null {
  const bare = stripToBare(shape);
  if (detectBlockType(shape) !== 'code') return null;
  return convertBlock(shape, 'code', { lang, headingLevel: bare.level });
}

/** True when converting `from` → `to` would change the markdown at all. */
export function isSameType(shape: BlockShape, to: BlockType): boolean {
  return detectBlockType(shape) === to;
}

/** True when the conversion drops the block's own id / children. */
export function conversionLosesIdentity(_from: BlockShape, to: BlockType): boolean {
  return isVerbatimType(to);
}
