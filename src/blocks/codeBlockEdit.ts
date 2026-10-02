/**
 * Code-block edit mode (Logseq parity): a block whose text ends in a code
 * fence opens a dedicated code editor — no fence markers on screen, Enter
 * inserts newlines INSIDE the code (never splits the outline block), Esc or
 * clicking another block commits and re-wraps the fence. Mixed blocks
 * (image/prose lines BEFORE the fence) keep their prefix rendered statically
 * while the fence gets the editor; prose after the closing fence keeps the
 * regular editor. "Source mode" also keeps the raw view.
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
  /** Lines BEFORE the opening fence (mixed blocks: image/prose + fence). */
  prefix: string;
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
 * Parse a block whose text ends in a code fence: [prefix lines +] opening
 * fence → content → closing fence (or unterminated). The prefix (an image,
 * prose) stays rendered statically while the fence gets the dedicated code
 * editor. Returns null when the text has no fence line, or when non-blank
 * content follows the closing fence — the generic outline editor must keep
 * those blocks so no text is ever dropped on commit.
 */
export function parseCodeFence(text: string): CodeFenceInfo | null {
  const lines = text.split('\n');
  // The opening fence may sit at any line — mixed blocks carry a prefix.
  let openIdx = -1;
  let open: RegExpExecArray | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_LINE_RE.exec(lines[i]);
    if (m) {
      openIdx = i;
      open = m;
      break;
    }
  }
  if (openIdx < 0 || !open) return null;
  const fence = open[1];
  const lang = open[2].trim();
  let closed = false;
  let end = lines.length;
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (new RegExp('^' + fence[0] + '{' + fence.length + ',}\\s*$').test(lines[i])) {
      // A code block ENDS at its closing fence. Non-blank content after it
      // (a second fence, trailing prose) means this block has a tail the code
      // editor cannot represent: mounting it would commit only up to the
      // FIRST closing fence and silently drop the rest.
      if (lines.slice(i + 1).some((l) => l.trim() !== '')) return null;
      closed = true;
      end = i;
      break;
    }
  }
  return {
    prefix: lines.slice(0, openIdx).join('\n'),
    lang,
    content: lines.slice(openIdx + 1, closed ? end : lines.length).join('\n'),
    fence,
    openLine: lines[openIdx],
    closed,
  };
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
  /** The prefix lines kept rendered statically (mixed blocks; '' for pure). */
  prefix: string;
  fence: string;
  openLine: string;
  closed: boolean;
  /** The editing wrap that replaced the static code element (mixed blocks). */
  editingWrap: HTMLElement | null;
  /** The static code element to restore on commit (mixed blocks). */
  restoreEl: HTMLElement | null;
}

export interface CodeMountOpts {
  /**
   * Replace this static element (the rendered code block inside the cached
   * static render) instead of appending the editor to `content` — the mixed
   * block keeps its rendered prefix (image/prose) untouched on screen.
   */
  replaceEl?: HTMLElement;
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
  opts: CodeMountOpts = {},
): MountedCodeEditor {
  // Standard DOM APIs (no Obsidian prototype extensions) — keeps this module
  // testable outside Obsidian.
  const wrap = document.createElement('div');
  wrap.className = 'lgp-code-block lgp-code-editing';
  if (opts.replaceEl) opts.replaceEl.replaceWith(wrap);
  else content.appendChild(wrap);
  const bar = document.createElement('div');
  bar.className = 'lgp-code-toolbar';
  wrap.appendChild(bar);
  // Mixed blocks ALWAYS show the label: it is their only path into source
  // mode (the prefix is not editable through the code editor itself).
  if (info.lang || info.prefix) {
    const langEl = document.createElement('span');
    langEl.className = 'lgp-code-lang';
    langEl.textContent = info.lang || 'text';
    langEl.title = 'Edit as source (change language)';
    // Click the language label → one-shot source mode with the cursor at the
    // end of the fence's language word, so the language can be edited
    // directly (the code content is committed first, never lost).
    langEl.addEventListener('click', (e) => {
      e.stopPropagation();
      host.commitFocusedText();
      host.sourceModeBlock = block;
      // Mixed blocks: the opening fence is NOT line 0 — offset past the prefix.
      const openPos = (info.prefix ? info.prefix.length + 1 : 0) + info.openLine.length;
      host.focusBlock(block, Math.min(openPos, block.text.length));
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
  // Debug handle for e2e verification (same convention as the outline editor).
  (view.dom as HTMLElement & { __lgView?: EditorView }).__lgView = view;
  view.focus();
  return {
    view,
    block,
    prefix: info.prefix,
    fence: info.fence,
    openLine: info.openLine,
    closed: info.closed,
    editingWrap: opts.replaceEl ? wrap : null,
    restoreEl: opts.replaceEl ?? null,
  };
}
