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
 *
 * Mirrors SiYuan's own rule, read from `setFold` in
 * app/src/protyle/util/blockFold.ts: it bails out for a `NodeListItem` with
 * `childElementCount < 4` ("没有子列表或多个块的列表项不进行折叠") and for a
 * `NodeThematicBreak`. A markdown heading is a single line with no children —
 * its content is a SIBLING, not a child — so it is foldable only as a SECTION
 * (see `isFoldableHeading` / `sectionEndIndex`).
 */
export function isFoldableBody(b: Block): boolean {
  if (b.children.length > 0) return true;
  if (b.text.split('\n').length > 1) return true;
  if (isThematicBreak(b.text)) return false; // a divider is one line, never worth folding
  return isMediaOnlyBlock(b.text);
}

/** A `---` / `***` divider line — SiYuan refuses to fold these too. */
export function isThematicBreak(text: string): boolean {
  return /^\s*(?:=+|\*+|_+|~+|\++)\s*$/.test(text.split('\n')[0] ?? '');
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Heading level of a block's first line, or 0 when it is not a heading. */
export function headingLevel(b: Block): number {
  const m = HEADING_RE.exec(b.text.split('\n')[0] ?? '');
  return m ? m[1].length : 0;
}

/**
 * A heading folds the SECTION it introduces: itself plus every following
 * sibling of a deeper level, stopping at the next heading of the same or a
 * shallower level.
 *
 * This is SiYuan's `removeFoldHeading`, which walks `nextElementSibling` while
 * the next node is either not a heading or is a deeper one, and removes it. A
 * markdown heading cannot own the section as children — its content is a
 * sibling — so the section is defined by scanning the visible sequence
 * instead of by tree structure.
 */
export function isFoldableHeading(b: Block): boolean {
  return headingLevel(b) > 0;
}

/**
 * Index just past the last block of the section `heading` opens, in the given
 * visible sequence. Returns the index of the heading itself when it is not a
 * heading or has no section (a heading immediately followed by an equal or
 * shallower one).
 */
export function sectionEndIndex(seq: Block[], headingIndex: number): number {
  const level = headingLevel(seq[headingIndex]);
  if (level === 0) return headingIndex + 1;
  let end = headingIndex + 1;
  for (let i = headingIndex + 1; i < seq.length; i++) {
    const l = headingLevel(seq[i]);
    if (l > 0 && l <= level) break; // same or shallower heading ends the section
    end = i + 1;
  }
  return end;
}

/**
 * True when `b` falls inside a section whose heading is folded.
 *
 * `index` is `b`'s position in the visible sequence (`-1` when unknown, which
 * happens for a block outside it — that block is never hidden). A folded
 * heading hides everything from just after it up to the next same-or-shallower
 * heading; a folded BODY block is not handled here, the renderer replaces its
 * content in place instead.
 */
export function isInsideFoldedSection(_b: Block, index: number, seq: Block[]): boolean {
  if (index < 0) return false;
  for (let i = index - 1; i >= 0; i--) {
    const h = seq[i];
    const level = headingLevel(h);
    // A same-or-shallower heading is the section's own owner; keep walking up
    // only if this one is DEEPER than the block's enclosing section.
    if (level > 0) {
      if (foldLevelOf(h.props) !== 'none' && sectionEndIndex(seq, i) > index) return true;
      if (i === 0) break;
    }
    if (i === 0) break;
  }
  return false;
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
