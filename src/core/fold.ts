/**
 * Block folding: pure rules shared by the parser, the serializer and the view.
 *
 * WHY A RAW BLOCK CANNOT OWN PROPERTIES (measured, see notes/testing.md):
 * `serializeBlock` used to answer a verbatim block with `return b.text`, so
 * anything in `props` was dropped on the next save, and a `key:: value` line
 * INSIDE a fence is read back as code. Folding state is therefore written the
 * way a list block already writes it — as an indented property line directly
 * BELOW the block:
 *
 *     ```python
 *     x = 1
 *     ```
 *     collapsed:: true
 *
 * Two levels, so one flag name covers both gestures:
 *   `collapsed:: true` — folded, summarised to one line
 *   `collapsed:: full` — folded all the way to a terse marker
 *
 * Markdown stays the only source of truth: the flag is a plain property, so it
 * survives a save/reload round trip and is queryable through the existing
 * SQLite `props` index. The "hide folding properties from the view" setting
 * only affects RENDERING — the property is still written and still read.
 */

import type { Block } from '../types';

/** Property key holding the fold state, normalized for comparison. */
const COLLAPSED = 'collapsed';

/** Lowercase + strip dashes: `collapsed`, `Collapsed` and `Collapsed-` are one key. */
export function normFoldKey(k: string): string {
  return k.toLowerCase().replace(/-/g, '');
}

/** How a block is currently folded. */
export type FoldLevel = 'none' | 'summary' | 'full';

/** Read a block's fold level from its props. Unknown/absent = not folded. */
export function foldLevelOf(props: Record<string, string> | undefined): FoldLevel {
  if (!props) return 'none';
  for (const [k, v] of Object.entries(props)) {
    if (normFoldKey(k) !== COLLAPSED) continue;
    if (v === 'true') return 'summary';
    if (v === 'full') return 'full';
    return 'none';
  }
  return 'none';
}

/** The value to write for a level, or null when the block should just be unfolded. */
export function foldValueFor(level: FoldLevel): string | null {
  if (level === 'summary') return 'true';
  if (level === 'full') return 'full';
  return null;
}

/** Toggle from a click: unfolded -> summary -> full -> unfolded. */
export function nextFoldLevel(current: FoldLevel, alt: boolean): FoldLevel {
  if (alt) {
    // Alt is the "fold all the way" gesture: from anything but fully folded,
    // go straight to full; from full, unfold.
    return current === 'full' ? 'none' : 'full';
  }
  if (current === 'none') return 'summary';
  if (current === 'summary') return 'full';
  return 'none';
}

/**
 * Whether a block's own body is worth folding — i.e. folding hides something.
 *
 * Deliberately about CONTENT, not about block kind: a heading, a fenced code
 * block, a table, a quote or a multi-line paragraph all span more than one
 * rendered line, and all of them can be folded. A block whose text is a single
 * line with no children has nothing to hide, so it gets no caret.
 *
 * A media-only block (`![](a.png)` on its own, a wiki embed, a video embed)
 * counts as foldable even though its text is one line: the rendered image is
 * large, and folding it is exactly what the user asks for.
 */
export function isFoldableBody(b: Block): boolean {
  if (b.children.length > 0) return true;
  if (b.text.split('\n').length > 1) return true;
  return isMediaOnlyBlock(b.text);
}

const MEDIA_ONLY_RE =
  /^(?:\s*(?:!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]*\]\]|<img[^>]*>|<video[^>]*>(?:.*?<\/video>)?)\s*)+$/i;

/** True when a block's text is nothing but images / videos (so it renders as media only). */
export function isMediaOnlyBlock(text: string): boolean {
  const t = text.trim();
  if (t === '') return false;
  return MEDIA_ONLY_RE.test(t);
}

/** What a folded block is summarised as, for the one-line placeholder. */
export function foldSummary(b: Block): string {
  const first = b.text.split('\n')[0].trim();
  if (isMediaOnlyBlock(b.text)) {
    // `![](a.png)` -> `a.png`, so the placeholder names the file.
    const m = /!\[[^\]]*\]\(([^)\s]+)/.exec(b.text) || /!\[\[([^\]]+)\]\]/.exec(b.text);
    const src = m ? m[1] : '';
    const kind = /\.(mp4|webm|ogv|mov|m4v)$/i.test(src) ? '视频' : '图片';
    return src ? `${kind} · ${src}` : kind;
  }
  return first || '空块';
}
