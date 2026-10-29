/**
 * Obsidian-style math syntax for the outline editor's markdown language.
 *
 * latex-suite (and our own consumers) locate math regions by SYNTAX TREE node
 * names produced by Obsidian's internal markdown parser: `DollarInlineMath`,
 * `DollarDisplayMath`, `DollarDisplayBlockMath` with `Dollar` delimiters and a
 * `LaTeX` content child. The stock @codemirror/lang-markdown grammar has no
 * math nodes, so without this extension the plugin's live math preview finds
 * no math regions in the outline editor.
 *
 * Grammar:
 *   `$x$`   → DollarInlineMath[Dollar, LaTeX, Dollar]
 *   `$$x$$` → DollarDisplayMath[Dollar, LaTeX, Dollar]   (single line)
 *   `$$\nx\n$$` → DollarDisplayBlockMath[Dollar, …, Dollar]  (multi line)
 */
import type { MarkdownExtension } from '@lezer/markdown';

const DOLLAR = 36;
const BACKSLASH = 92;
const NEWLINE = 10;

export function mathSyntax(): MarkdownExtension {
  return {
    defineNodes: [
      { name: 'Dollar' },
      { name: 'LaTeX' },
      { name: 'DollarInlineMath' },
      { name: 'DollarDisplayMath' },
      { name: 'DollarDisplayBlockMath', block: true },
      { name: 'DisplayMath' },
    ],
    parseInline: [
      {
        name: 'DollarMath',
        after: 'Escape', // escaped \$ never opens math
        parse(cx, next, pos) {
          if (next !== DOLLAR) return -1;
          const display = cx.char(pos + 1) === DOLLAR;
          const dLen = display ? 2 : 1;
          const openEnd = pos + dLen;
          let close = -1;
          for (let i = openEnd; i < cx.end; i++) {
            const c = cx.char(i);
            if (c === NEWLINE) break; // inline math stays on one line
            if (c === BACKSLASH) {
              i++; // skip escaped char
              continue;
            }
            if (c === DOLLAR && (!display || cx.char(i + 1) === DOLLAR)) {
              close = i;
              break;
            }
          }
          if (close < 0 || close - openEnd < 1) return -1; // no closer / empty
          cx.addElement(
            cx.elt(display ? 'DollarDisplayMath' : 'DollarInlineMath', pos, close + dLen, [
              cx.elt('Dollar', pos, openEnd),
              cx.elt('LaTeX', openEnd, close),
              cx.elt('Dollar', close, close + dLen),
            ]),
          );
          return close + dLen;
        },
      },
    ],
    parseBlock: [
      {
        name: 'DollarMathBlock',
        parse(cx, line) {
          const idx = line.text.indexOf('$$');
          if (idx < 0) return false;
          if (/[^ \t]/.test(line.text.slice(0, idx))) return false; // $$ must start the line (indent ok)
          if (line.text.slice(idx + 2).includes('$$')) return false; // closed on the same line → inline math
          const openFrom = cx.lineStart + line.pos + idx;
          const marks = [cx.elt('Dollar', openFrom, openFrom + 2)];
          for (;;) {
            if (!cx.nextLine()) break; // unterminated → consume to EOF
            for (const m of line.markers ?? []) marks.push(m);
            const cIdx = line.text.indexOf('$$');
            if (cIdx >= 0) {
              marks.push(cx.elt('Dollar', cx.lineStart + cIdx, cx.lineStart + cIdx + 2));
              cx.nextLine();
              break;
            }
          }
          const to = cx.prevLineEnd();
          if (to <= openFrom) return false; // nothing consumed
          cx.addElement(cx.elt('DollarDisplayBlockMath', openFrom, to, marks));
          return true;
        },
      },
    ],
  };
}
