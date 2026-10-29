/**
 * "<" command menu (Logseq md parity): typing `<` at word start opens the
 * HTML-snippet / entity menu, rendered through the SAME CM6 autocompletion
 * pipeline as the slash menu. Insertions are plain markdown-safe snippets;
 * the menu disappears when the text no longer matches (IME-safe: CM6 only
 * triggers on committed text, and a bare `<` in prose without further typing
 * still offers the menu but never mutates anything by itself).
 */

import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';

interface AngleCommand extends Completion {
  group: string;
}

const ANGLE_COMMANDS: AngleCommand[] = [
  {
    label: '<div',
    group: 'HTML',
    detail: 'html block container',
    type: 'text',
    apply: '<div>\n\n</div>',
  },
  {
    label: '<span',
    group: 'HTML',
    detail: 'inline container',
    type: 'text',
    apply: '<span></span>',
  },
  {
    label: '<br',
    group: 'HTML',
    detail: 'line break',
    type: 'text',
    apply: '<br>',
  },
  {
    label: '<mark',
    group: 'HTML',
    detail: 'highlight (Obsidian ==mark== alternative)',
    type: 'text',
    apply: '<mark></mark>',
  },
  {
    label: '<u',
    group: 'HTML',
    detail: 'underline',
    type: 'text',
    apply: '<u></u>',
  },
  {
    label: '<sub',
    group: 'HTML',
    detail: 'subscript',
    type: 'text',
    apply: '<sub></sub>',
  },
  {
    label: '<sup',
    group: 'HTML',
    detail: 'superscript',
    type: 'text',
    apply: '<sup></sup>',
  },
  {
    label: '<kbd',
    group: 'HTML',
    detail: 'keyboard key styling',
    type: 'text',
    apply: '<kbd></kbd>',
  },
  {
    label: '<center',
    group: 'HTML',
    detail: 'centered content',
    type: 'text',
    apply: '<center>\n\n</center>',
  },
  {
    label: '<font color',
    group: 'HTML',
    detail: 'colored text',
    type: 'text',
    apply: '<font color="#1a4fa0"></font>',
  },
  {
    label: '<details',
    group: 'HTML',
    detail: 'collapsible section',
    type: 'text',
    apply: '<details>\n<summary>title</summary>\n\n</details>',
  },
  {
    label: '&nbsp;',
    group: 'Entities',
    detail: 'non-breaking space',
    type: 'text',
    apply: '&nbsp;',
  },
  {
    label: '&lt;',
    group: 'Entities',
    detail: 'literal < character',
    type: 'text',
    apply: '&lt;',
  },
  {
    label: '&gt;',
    group: 'Entities',
    detail: 'literal > character',
    type: 'text',
    apply: '&gt;',
  },
  {
    label: '&amp;',
    group: 'Entities',
    detail: 'literal & character',
    type: 'text',
    apply: '&amp;',
  },
  {
    label: '&copy;',
    group: 'Entities',
    detail: '© symbol',
    type: 'text',
    apply: '&copy;',
  },
];

/**
 * Trigger rule: `<` right after start-of-line or whitespace, optionally
 * followed by the query being typed. A bare `<` in the MIDDLE of a word
 * (e.g. `a<b`) or inside an existing tag never triggers — this keeps
 * prose like `x < y` and pasted HTML clean. CM6 completion only fires on
 * committed text, so IME composition is naturally safe.
 */
export function angleMenuSource(): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.matchBefore(/(?:^|\s)<[\w&-]*$/);
    if (!before) return null;
    const ltIdx = before.text.lastIndexOf('<');
    const query = before.text.slice(ltIdx + 1).toLowerCase();
    const from = before.from + ltIdx;
    const options: Completion[] = [];
    for (const c of ANGLE_COMMANDS) {
      const label = c.label.toLowerCase().replace(/^</, '');
      if (query && !label.startsWith(query) && !label.includes(query)) continue;
      options.push({ ...c });
    }
    if (options.length === 0) return null;
    return { from, options, validFor: /(?:^|\s)<[\w&-]*$/ };
  };
}

/** Replace range util shared with the slash menu (kept local to avoid cycles). */
export function angleReplace(view: EditorView, from: number, to: number, insert: string): void {
  view.dispatch({ changes: { from, to, insert } });
}
