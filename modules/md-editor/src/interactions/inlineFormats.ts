/**
 * Syntax-tree inline format interrogation (batch 28).
 *
 * SiYuan counterpart: protyle/toolbar/inlineFormat.ts `getRangeInlineFormats`
 * — the "intersection over every visible text segment the range touches"
 * algorithm. SiYuan walks DOM text nodes and intersects each segment's
 * ancestor `data-type` sets; we walk the Lezer markdown tree and intersect
 * each segment's covering node types. This replaces the hug-approximation
 * (`**x**` used to light up italic as well) with the tree-resolved truth —
 * the same way native Obsidian resolves toggle hits via its syntax tree.
 *
 * Tree shapes consumed (probe-verified):
 *   **x** / __x__ → StrongEmphasis > EmphasisMark ×2   (x is nodeless text)
 *   *x*  / _x_   → Emphasis > EmphasisMark ×2
 *   ~~x~~        → Strikethrough > StrikethroughMark ×2
 *   `x`          → InlineCode > CodeMark ×2
 *   ==x==        → Highlight > HighlightMark ×2        (obsidianInlineSyntax)
 *   %%x%%        → ObsidianComment > ObsidianCommentMark ×2
 *   $x$          → DollarInlineMath > Dollar+LaTeX+Dollar (mathSyntax)
 */
import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

/** Tree node name → canonical markdown mark. */
export const INLINE_NODE_MARKS: Record<string, string> = {
  StrongEmphasis: '**',
  Emphasis: '*',
  Strikethrough: '~~',
  InlineCode: '`',
  Highlight: '==',
  ObsidianComment: '%%',
  DollarInlineMath: '$',
};

/** All canonical marks, stable display order. */
export const INLINE_FORMAT_MARKS = ['**', '*', '~~', '==', '%%', '`', '$'] as const;

/** `__`→`**`, `_`→`*` (alt spellings map onto the same tree node type). */
export function normalizeMark(mark: string): string {
  if (mark === '__') return '**';
  if (mark === '_') return '*';
  return mark;
}

interface FormatNode {
  from: number;
  to: number;
  mark: string;
}

/** Collect inline format nodes intersecting [from, to). */
function collectFormatNodes(state: EditorState, from: number, to: number): FormatNode[] {
  const out: FormatNode[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      const mark = INLINE_NODE_MARKS[node.name];
      if (mark) out.push({ from: node.from, to: node.to, mark });
      return undefined;
    },
  });
  return out;
}

/**
 * SiYuan getRangeInlineFormats: intersect the mark sets of every visible text
 * segment the range [from, to) touches. A segment's set = marks of the format
 * nodes covering it (bare text inside StrongEmphasis is covered by the
 * StrongEmphasis node even though it is nodeless itself).
 *
 * Returns undefined when the range touches no non-empty segment at all
 * (SiYuan's "nothing interrogated" signal, distinct from "no common mark").
 */
export function inlineFormatsIn(state: EditorState, from: number, to: number): string[] | undefined {
  if (to <= from) return undefined;
  const nodes = collectFormatNodes(state, from, to);
  // Segment boundaries: range edges + every intersecting node edge clipped in.
  const bounds = new Set<number>([from, to]);
  for (const n of nodes) {
    if (n.from > from && n.from < to) bounds.add(n.from);
    if (n.to > from && n.to < to) bounds.add(n.to);
  }
  const sorted = [...bounds].sort((a, b) => a - b);
  let acc: string[] | undefined;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b <= a) continue;
    // SiYuan: segments with empty visible text do not participate; whitespace
    // does (only ZWSP-runs were skipped there — we have no ZWSP markers).
    if (state.sliceDoc(a, b).length === 0) continue;
    const covering = new Set<string>();
    for (const n of nodes) {
      if (n.from <= a && b <= n.to) covering.add(n.mark);
    }
    // Segments covered by nothing (plain text) yield an empty set → empty
    // intersection, matching SiYuan (a plain segment kills all common marks).
    acc =
      acc === undefined
        ? INLINE_FORMAT_MARKS.filter((m) => covering.has(m))
        : acc.filter((m) => covering.has(m));
    if (acc.length === 0) return [];
  }
  return acc;
}

/**
 * SiYuan getRangesInlineFormats: intersection across several ranges. Ranges
 * that interrogate nothing (undefined) are skipped; if no range interrogates
 * anything the result is [].
 */
export function inlineFormatsAcross(
  state: EditorState,
  ranges: Array<{ from: number; to: number }>,
): string[] {
  let acc: string[] | undefined;
  for (const r of ranges) {
    const current = inlineFormatsIn(state, r.from, r.to);
    if (current) {
      acc = acc === undefined ? current : acc.filter((m) => current.includes(m));
    }
  }
  return acc ?? [];
}

/**
 * All inline format nodes intersecting [from, to) — the clear-formatting
 * sweep set (every format the selection touches loses its markers).
 */
export function formatNodesIntersecting(
  state: EditorState,
  from: number,
  to: number,
): SyntaxNode[] {
  if (to <= from) return [];
  const out: SyntaxNode[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (INLINE_NODE_MARKS[node.name]) out.push(node.node);
      return undefined;
    },
  });
  return out;
}

/**
 * The innermost node of `mark`'s type covering [from, to), for unwrapping.
 *
 * Non-empty range: a format node fully containing the range. Empty range
 * (caret): resolveInner(pos, -1) then walk up — bias -1 keeps the caret
 * inside its format at both edges (`**x|**` and `**|x**` both resolve into
 * the StrongEmphasis, matching SiYuan/native caret semantics).
 */
export function formatNodeAt(
  state: EditorState,
  from: number,
  to: number,
  mark: string,
): SyntaxNode | null {
  const target = normalizeMark(mark);
  if (to > from) {
    let found: SyntaxNode | null = null;
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (INLINE_NODE_MARKS[node.name] !== target) return undefined;
        if (node.from <= from && to <= node.to) {
          // Deepest match wins (same-type nesting does not occur in md, but
          // sibling partial overlaps may both be visited).
          if (!found || (node.from >= found.from && node.to <= found.to)) found = node.node;
        }
        return undefined;
      },
    });
    return found;
  }
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, -1);
  while (node) {
    if (INLINE_NODE_MARKS[node.name] === target) return node;
    node = node.parent;
  }
  return null;
}
