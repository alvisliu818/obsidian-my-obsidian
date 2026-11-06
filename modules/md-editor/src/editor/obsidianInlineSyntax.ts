/**
 * Obsidian-style inline syntax the stock @lezer/markdown grammar lacks:
 * `==highlight==` and `%%comment%%` (batch 28, sister of mathSyntax.ts).
 *
 * Grammar (mirror of the probe-verified shapes):
 *   `==x==`  → Highlight[HighlightMark, HighlightMark]
 *   `%%x%%`  → ObsidianComment[ObsidianCommentMark, ObsidianCommentMark]
 *
 * The bare text between the marks stays nodeless, exactly like Emphasis
 * content — inlineFormats.ts relies on that uniform shape. These nodes are
 * pure syntax-tree citizens: no HighlightStyle is attached, so live preview
 * rendering is unchanged (previously they parsed as plain text).
 *
 * The node name is ObsidianComment (not Comment) to avoid colliding with the
 * HTML block comment node names in downstream consumers.
 */
import type { MarkdownExtension } from '@lezer/markdown';

const EQ = 61;
const PERCENT = 37;
const NEWLINE = 10;

function doubleMarkInline(ch: number, name: string): MarkdownExtension {
  return {
    defineNodes: [{ name: `${name}Mark` }, { name }],
    parseInline: [
      {
        name,
        parse(cx, next, pos) {
          if (next !== ch || cx.char(pos + 1) !== ch) return -1;
          const openEnd = pos + 2;
          let close = -1;
          for (let i = openEnd; i < cx.end; i++) {
            if (cx.char(i) === NEWLINE) break; // inline syntax stays on one line
            if (cx.char(i) === ch && cx.char(i + 1) === ch) {
              close = i;
              break;
            }
          }
          if (close < 0 || close - openEnd < 1) return -1; // no closer / empty
          cx.addElement(
            cx.elt(name, pos, close + 2, [
              cx.elt(`${name}Mark`, pos, openEnd),
              cx.elt(`${name}Mark`, close, close + 2),
            ]),
          );
          return close + 2;
        },
      },
    ],
  };
}

/** `==x==` → Highlight, `%%x%%` → ObsidianComment. */
export function obsidianInlineSyntax(): MarkdownExtension {
  return [doubleMarkInline(EQ, 'Highlight'), doubleMarkInline(PERCENT, 'ObsidianComment')];
}
