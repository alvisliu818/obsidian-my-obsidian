/**
 * Code-block edit mode (Logseq parity): a block whose text is a PURE code
 * fence opens a dedicated code editor instead of the raw-outline editor —
 * no fence markers on screen, Enter inserts newlines INSIDE the code (never
 * splits the outline block), Esc or clicking another block commits and
 * re-wraps the fence. Mixed blocks (text before the fence) keep the regular
 * editor; "Source mode" also keeps the raw view.
 */

// CodeMirror is imported through the `cm-bundle:` prefix (rewritten by an
// esbuild/vite resolver): this module gets its OWN bundled CM6 copy instead of
// Obsidian's shared instance. Obsidian's CM build silently drops decorations
// created by a plugin's syntaxHighlighting(), so code-block highlighting never
// renders through it. The bundled copy is self-contained and only used by the
// dedicated code editor — the outline editor keeps the shared instance for
// third-party registerEditorExtension compatibility.
//
// Syntax coloring runs Prism (same engine as the reading view) through
// prismHighlight.ts: tokens carry the same `.token <type>` classes in both
// states, so the styles.css rules color them identically.
import { EditorView, keymap, drawSelection } from 'cm-bundle:@codemirror/view';
import { EditorState, type Extension } from 'cm-bundle:@codemirror/state';
import { defaultKeymap, history, historyKeymap } from 'cm-bundle:@codemirror/commands';
import { indentUnit } from 'cm-bundle:@codemirror/language';
import { prismGrammarFor, prismHighlightExtension } from './prismHighlight';
import type { Block } from '../types';
import type { BlockEditorView } from '../view/BlockEditorView';

export interface CodeFenceInfo {
  /** Language from the opening fence ('' when absent). */
  lang: string;
  /** The code content between the fences. */
  content: string;
  /** The exact opening fence run (``` / ~~~ / longer). */
  fence: string;
  /** The full opening fence LINE (fence + language) — commit re-wraps with it. */
  openLine: string;
  /** Whether the block text carried a closing fence. */
  closed: boolean;
}

const FENCE_LINE_RE = /^(`{3,}|~{3,})([^\n`]*)$/;

/**
 * Parse a block whose text is a PURE code fence (opening fence → content →
 * closing fence, or unterminated). Returns null for anything else — mixed
 * blocks keep the regular outline editor.
 */
export function parseCodeFence(text: string): CodeFenceInfo | null {
  const lines = text.split('\n');
  const open = FENCE_LINE_RE.exec(lines[0] ?? '');
  if (!open) return null;
  const fence = open[1];
  const lang = open[2].trim();
  let closed = false;
  let end = lines.length;
  for (let i = 1; i < lines.length; i++) {
    if (new RegExp('^' + fence[0] + '{' + fence.length + ',}\\s*$').test(lines[i])) {
      closed = true;
      end = i;
      break;
    }
  }
  return { lang, content: lines.slice(1, closed ? end : lines.length).join('\n'), fence, openLine: lines[0] ?? fence, closed };
}

/**
 * Syntax coloring in BOTH states comes from Prism (the reading view runs it
 * through Obsidian's MarkdownRenderer) — the editor maps the same token
 * classes onto CM6 decorations, so styles.css colors them identically.
 */

/** CM extension for the fence's language (null = plain text). */
function languageFor(lang: string): Extension | null {
  const grammar = prismGrammarFor(lang);
  return grammar ? prismHighlightExtension(grammar) : null;
}

export interface MountedCodeEditor {
  view: EditorView;
  block: Block;
  fence: string;
  openLine: string;
  closed: boolean;
}

/** The block text for the edited code content (fence re-wrapped). */
export function codeFenceText(info: { fence: string; closed: boolean }, content: string): string {
  return info.closed ? `${info.fence}\n${content}\n${info.fence}` : `${info.fence}\n${content}`;
}

/**
 * Mount the dedicated code editor into the focused block's content slot.
 * Enter inserts a newline in the code (the outline keymap does not apply
 * here); Esc commits through host.commitFocusedText().
 */
export function mountCodeEditor(
  content: HTMLElement,
  block: Block,
  info: CodeFenceInfo,
  host: BlockEditorView,
): MountedCodeEditor {
  // Standard DOM APIs (no Obsidian prototype extensions) — keeps this module
  // testable outside Obsidian.
  const wrap = document.createElement('div');
  wrap.className = 'lgp-code-block lgp-code-editing';
  content.appendChild(wrap);
  const bar = document.createElement('div');
  bar.className = 'lgp-code-toolbar';
  wrap.appendChild(bar);
  if (info.lang) {
    const langEl = document.createElement('span');
    langEl.className = 'lgp-code-lang';
    langEl.textContent = info.lang;
    langEl.title = 'Edit as source (change language)';
    // Click the language label → one-shot source mode with the cursor at the
    // end of the fence's language word, so the language can be edited
    // directly (the code content is committed first, never lost).
    langEl.addEventListener('click', (e) => {
      e.stopPropagation();
      host.commitFocusedText();
      host.sourceModeBlock = block;
      host.focusBlock(block, Math.min(info.openLine.length, block.text.length));
    });
    bar.appendChild(langEl);
  }
  const hint = document.createElement('span');
  hint.className = 'lgp-code-edit-hint';
  hint.textContent = 'Esc';
  bar.appendChild(hint);
  const body = document.createElement('div');
  body.className = 'lgp-code-editor-host';
  wrap.appendChild(body);

  const view = new EditorView({
    state: EditorState.create({
      doc: info.content,
      extensions: [
        drawSelection(),
        history(),
        indentUnit.of('  '),
        languageFor(info.lang) ?? [],
        keymap.of([
          {
            key: 'Escape',
            run: () => {
              host.commitFocusedText();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
      ],
    }),
    parent: body,
  });
  view.focus();
  return { view, block, fence: info.fence, openLine: info.openLine, closed: info.closed };
}
