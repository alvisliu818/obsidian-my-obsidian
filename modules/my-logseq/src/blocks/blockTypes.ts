/**
 * SiYuan-style block types.
 *
 * SiYuan models every piece of content as a typed, addressable block; the
 * type drives what the block looks like and which actions are offered. This
 * plugin stores only markdown, so the type is **derived from the text on every
 * read** — there is no `type::` property to drift out of sync. Rewriting the
 * text (heading level, callout kind, fence language) is therefore the only way
 * to change a block's type, and it is exactly what the file will contain.
 *
 * Detection rules are ordered: the most specific structural syntax wins
 * (fenced code beats `>` beats `#`), because a block text may legitimately
 * contain several at once (a callout is also a quote).
 *
 * Pure logic — no obsidian import, so it stays unit-testable under vitest.
 */

import type { Block, Marker } from '../types';

/** Every block kind the outliner can render or convert to. */
export type BlockType =
  | 'paragraph'
  | 'heading'
  | 'task'
  | 'quote'
  | 'callout'
  | 'code'
  | 'math'
  | 'table'
  | 'divider'
  | 'image'
  | 'video'
  | 'audio'
  | 'embed'
  | 'html'
  | 'list'
  | 'ordered'
  | 'footnote'
  | 'props';

/** The block types a normal outline row can be turned into. */
export type ConvertTarget = Exclude<BlockType, 'props'>;

export interface BlockTypeMeta {
  id: BlockType;
  /** English label (project convention: UI strings are English). */
  label: string;
  /** Lucide icon name (Obsidian's icon set). */
  icon: string;
  group: 'Basic' | 'Structure' | 'Media' | 'Advanced';
  /** One-line description shown in menus. */
  hint: string;
  /** Slash-menu skeleton; the caret lands at `caret`. */
  template?: string;
  caret?: number;
}

export const BLOCK_TYPES: readonly BlockTypeMeta[] = [
  {
    id: 'paragraph',
    label: 'Paragraph',
    icon: 'pilcrow',
    group: 'Basic',
    hint: 'plain text block',
  },
  {
    id: 'heading',
    label: 'Heading',
    icon: 'heading',
    group: 'Basic',
    hint: 'section title, level 1-6',
  },
  {
    id: 'task',
    label: 'Task',
    icon: 'list-todo',
    group: 'Basic',
    hint: 'TODO / DOING / DONE marker',
  },
  {
    id: 'quote',
    label: 'Quote',
    icon: 'quote',
    group: 'Basic',
    hint: 'blockquote',
  },
  {
    id: 'callout',
    label: 'Callout',
    icon: 'message-square',
    group: 'Basic',
    hint: 'highlighted admonition',
    template: '> [!note] ',
    caret: 9,
  },
  {
    id: 'code',
    label: 'Code',
    icon: 'code',
    group: 'Structure',
    hint: 'fenced code with language',
    template: '```\n\n```',
    caret: 4,
  },
  {
    id: 'math',
    label: 'Math',
    icon: 'sigma',
    group: 'Structure',
    hint: 'display formula',
    template: '$$\n\n$$',
    caret: 3,
  },
  {
    id: 'table',
    label: 'Table',
    icon: 'table',
    group: 'Structure',
    hint: 'pipe table',
    template: '| A | B |\n| --- | --- |\n| 1 | 2 |',
    caret: 2,
  },
  {
    id: 'list',
    label: 'Bullet list',
    icon: 'list',
    group: 'Structure',
    hint: 'markdown bullet list',
  },
  {
    id: 'ordered',
    label: 'Numbered list',
    icon: 'list-ordered',
    group: 'Structure',
    hint: 'markdown ordered list',
  },
  {
    id: 'divider',
    label: 'Divider',
    icon: 'minus',
    group: 'Structure',
    hint: 'horizontal rule',
    template: '---',
    caret: 3,
  },
  {
    id: 'footnote',
    label: 'Footnote',
    icon: 'superscript',
    group: 'Structure',
    hint: 'reference definition',
    template: '[^1]: ',
    caret: 6,
  },
  {
    id: 'image',
    label: 'Image',
    icon: 'image',
    group: 'Media',
    hint: 'embedded picture',
  },
  {
    id: 'video',
    label: 'Video',
    icon: 'video',
    group: 'Media',
    hint: 'embedded video file',
  },
  {
    id: 'audio',
    label: 'Audio',
    icon: 'music',
    group: 'Media',
    hint: 'embedded audio file',
  },
  {
    id: 'embed',
    label: 'Embed',
    icon: 'frame',
    group: 'Media',
    hint: 'page, PDF or web embed',
  },
  {
    id: 'html',
    label: 'HTML',
    icon: 'code-xml',
    group: 'Advanced',
    hint: 'raw HTML block',
  },
  {
    id: 'props',
    label: 'Properties',
    icon: 'sliders-horizontal',
    group: 'Advanced',
    hint: 'page property block',
  },
];

const META_BY_ID = new Map<BlockType, BlockTypeMeta>(BLOCK_TYPES.map((m) => [m.id, m]));

export function blockTypeMeta(id: BlockType): BlockTypeMeta {
  return META_BY_ID.get(id) ?? BLOCK_TYPES[0];
}

export function blockTypeLabel(id: BlockType): string {
  return blockTypeMeta(id).label;
}

/** Icon / hint lookups that must never throw on an unknown id. */
export function blockTypeIcon(id: BlockType): string {
  return blockTypeMeta(id).icon;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const CALLOUT_RE = /^>\s*\[!([a-zA-Z][\w-]*)\]([+-]?)\s*(.*)$/;
const QUOTE_RE = /^>\s?/;
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const MATH_OPEN_RE = /^\$\$\s*$/;
const TABLE_ROW_RE = /^\|.*\|\s*$/;
const TABLE_SEP_RE = /^\|(?:\s*:?-{2,}:?\s*\|)+\s*$/;
const DIVIDER_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const ORDERED_RE = /^\d{1,9}[.)]\s+/;
const BULLET_RE = /^[-*+]\s+/;
const FOOTNOTE_RE = /^\[\^[^\]]+\]:\s*/;
const EMBED_MACRO_RE = /^\{\{embed\s/;
const HTML_TAG_RE = /^<\/?([a-zA-Z][\w-]*)\b/;
/** `![[file]]` — a wiki embed (media or page). */
const WIKI_EMBED_RE = /^!\[\[([^\]]+)\]\]\s*$/;
/** `![alt](target)` — a markdown embed. */
const MD_EMBED_RE = /^!\[[^\]]*\]\(([^\s)]+)/;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mpe?g|mkv|ogv|m4v|avi)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus|weba)$/i;

/**
 * The minimum shape detection needs. Structural (not `Block`) so callers can
 * pass plain objects and tests stay free of the full tree.
 */
export interface BlockLike {
  kind?: Block['kind'];
  marker?: Marker;
  text?: string;
  props?: Record<string, string>;
  children?: readonly unknown[];
}

/** First content line of a block (block text may hold soft-wrapped lines). */
function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? '';
}

/** Heading level 1-6, or 0 when the text is not a heading. */
export function headingLevel(text: string): number {
  const m = HEADING_RE.exec(text.trim());
  return m ? m[1].length : 0;
}

/** Callout kind (`note`, `tip`, `warning`...), or '' when not a callout. */
export function calloutKind(text: string): string {
  const m = CALLOUT_RE.exec(text.split('\n', 1)[0]?.trim() ?? '');
  return m ? m[1].toLowerCase() : '';
}

/** Callout fold marker: `[!note]-` collapses by default, `+` expands. */
export function calloutFold(text: string): '-' | '+' | '' {
  const m = CALLOUT_RE.exec(text.split('\n', 1)[0]?.trim() ?? '');
  if (!m) return '';
  return m[2] === '-' || m[2] === '+' ? (m[2] as '-' | '+') : '';
}

/** Fenced code language ('' when none, or when the block is not code). */
export function codeLang(text: string): string {
  const m = FENCE_RE.exec(firstLine(text).trim());
  if (!m) return '';
  return (m[2] ?? '').trim().split(/\s+/)[0] ?? '';
}

/** Media/embed kind of a lone embed line, or '' when the text is not one. */
function mediaKindOf(t: string): BlockType | '' {
  let target = '';
  const w = WIKI_EMBED_RE.exec(t);
  if (w) target = (w[1] ?? '').split('|')[0].trim();
  else {
    const m = MD_EMBED_RE.exec(t);
    if (m) target = (m[1] ?? '').trim();
  }
  if (!t.startsWith('!')) return '';
  if (!target) return 'embed';
  // A wiki link can point at a page or a PDF: those are embeds, not media.
  return mediaTypeOf(target) || 'embed';
}

/**
 * Classify a vault path / embed target by extension. Returns '' for anything
 * that is not an embed candidate (a plain page link is not media either).
 */
export function mediaTypeOf(target: string): BlockType | '' {
  if (IMAGE_EXT.test(target)) return 'image';
  if (VIDEO_EXT.test(target)) return 'video';
  if (AUDIO_EXT.test(target)) return 'audio';
  return '';
}

/**
 * Derive the block's type from its markdown. Never throws, never returns
 * undefined — unknown shapes fall back to `paragraph`.
 */
export function detectBlockType(b: BlockLike): BlockType {
  const text = b.text ?? '';
  const kind = b.kind ?? 'list';
  const props = b.props ?? {};
  const lines = text.split('\n');
  const t = (lines[0] ?? '').trim();

  // The page-properties block: no text of its own, only `key:: value` pairs.
  if (kind === 'list' && text.trim() === '' && Object.keys(props).length > 0) return 'props';

  // A task marker outranks any text syntax (`- TODO # Title` is a task first).
  if (kind === 'list' && (b.marker ?? null)) return 'task';

  if (FENCE_RE.test(t)) return 'code';
  if (MATH_OPEN_RE.test(t)) return 'math';
  if (CALLOUT_RE.test(t)) return 'callout';
  if (QUOTE_RE.test(t)) return 'quote';
  if (HEADING_RE.test(t)) return 'heading';
  // A table needs a delimiter row — a single `|a|b|` line is just text.
  if (TABLE_ROW_RE.test(t) && TABLE_SEP_RE.test((lines[1] ?? '').trim())) return 'table';
  if (DIVIDER_RE.test(t)) return 'divider';
  const media = mediaKindOf(t);
  if (media) return media;
  if (FOOTNOTE_RE.test(t)) return 'footnote';
  if (EMBED_MACRO_RE.test(t)) return 'embed';
  const tag = HTML_TAG_RE.exec(t);
  if (tag) {
    const name = tag[1].toLowerCase();
    if (name === 'iframe') return 'embed';
    if (name === 'video') return 'video';
    if (name === 'audio') return 'audio';
    return 'html';
  }
  if (ORDERED_RE.test(t)) return 'ordered';
  if (BULLET_RE.test(t)) return 'list';
  return 'paragraph';
}

/** Convenience wrapper for a real block (detection ignores runtime fields). */
export function blockTypeOf(b: Block): BlockType {
  return detectBlockType(b);
}

/**
 * Structural types render as their own markdown region and cannot host
 * children or an `id::` property (they serialize verbatim), so converting an
 * outline row into one of them drops the block's own identity. The UI warns
 * instead of failing.
 */
export function isVerbatimType(t: BlockType): boolean {
  return t === 'table' || t === 'divider' || t === 'list' || t === 'ordered' || t === 'footnote';
}
