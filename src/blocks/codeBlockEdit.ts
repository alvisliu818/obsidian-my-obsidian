/**
 * Code-block edit mode (Logseq parity): a block whose text is a PURE code
 * fence opens a dedicated code editor instead of the raw-outline editor —
 * no fence markers on screen, Enter inserts newlines INSIDE the code (never
 * splits the outline block), Esc or clicking another block commits and
 * re-wraps the fence. Mixed blocks (text before the fence) keep the regular
 * editor; "Source mode" also keeps the raw view.
 */

import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { indentUnit, StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { python } from '@codemirror/legacy-modes/mode/python';
import { javascript, json as jsonMode, typescript } from '@codemirror/legacy-modes/mode/javascript';
import { c, cpp, java, csharp, kotlin, scala, dart } from '@codemirror/legacy-modes/mode/clike';
import { css as cssMode } from '@codemirror/legacy-modes/mode/css';
import { html as htmlMode, xml as xmlMode } from '@codemirror/legacy-modes/mode/xml';
import { sql as sqlMode } from '@codemirror/legacy-modes/mode/sql';
import { shell as shellMode } from '@codemirror/legacy-modes/mode/shell';
import { go as goMode } from '@codemirror/legacy-modes/mode/go';
import { rust as rustMode } from '@codemirror/legacy-modes/mode/rust';
import { yaml as yamlMode } from '@codemirror/legacy-modes/mode/yaml';
import { markdown as markdownParser } from '@codemirror/lang-markdown';
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
 * Syntax colors from the theme's own code variables (the same palette the
 * reading view maps Prism tokens to) — consistent across both states.
 */
const codeHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--code-keyword, var(--text-accent))' },
  { tag: [t.string, t.special(t.string)], color: 'var(--code-string, var(--text-accent))' },
  { tag: [t.number, t.bool, t.null], color: 'var(--code-atom, var(--code-number, var(--text-accent)))' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--code-comment, var(--text-faint))' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--code-function, var(--code-def, var(--text-accent)))' },
  { tag: t.definition(t.variableName), color: 'var(--code-def, var(--text-accent))' },
  { tag: [t.className, t.typeName], color: 'var(--code-type, var(--text-accent))' },
  { tag: t.operator, color: 'var(--code-operator, var(--text-muted))' },
  { tag: t.punctuation, color: 'var(--code-punctuation, var(--text-muted))' },
  { tag: t.propertyName, color: 'var(--code-property, inherit)' },
  { tag: t.variableName, color: 'var(--code-variable, inherit)' },
  { tag: [t.meta, t.annotation], color: 'var(--code-meta, var(--text-muted))' },
  { tag: [t.tagName], color: 'var(--code-tag, var(--text-accent))' },
  { tag: [t.attributeName], color: 'var(--code-attribute, inherit)' },
]);

/** Fence language -> CM StreamLanguage (legacy modes cover the common set). */
const codeLanguages: Record<string, StreamLanguage<unknown>> = {
  python: StreamLanguage.define(python),
  py: StreamLanguage.define(python),
  cython: StreamLanguage.define(python),
  javascript: StreamLanguage.define(javascript),
  js: StreamLanguage.define(javascript),
  jsx: StreamLanguage.define(javascript),
  mjs: StreamLanguage.define(javascript),
  typescript: StreamLanguage.define(typescript),
  ts: StreamLanguage.define(typescript),
  tsx: StreamLanguage.define(typescript),
  json: StreamLanguage.define(jsonMode),
  css: StreamLanguage.define(cssMode),
  html: StreamLanguage.define(htmlMode),
  htm: StreamLanguage.define(htmlMode),
  xml: StreamLanguage.define(xmlMode),
  svg: StreamLanguage.define(xmlMode),
  sql: StreamLanguage.define(sqlMode({ client: {} })),
  mysql: StreamLanguage.define(sqlMode({ client: {} })),
  postgresql: StreamLanguage.define(sqlMode({ client: {} })),
  shell: StreamLanguage.define(shellMode),
  sh: StreamLanguage.define(shellMode),
  bash: StreamLanguage.define(shellMode),
  zsh: StreamLanguage.define(shellMode),
  go: StreamLanguage.define(goMode),
  rust: StreamLanguage.define(rustMode),
  rs: StreamLanguage.define(rustMode),
  yaml: StreamLanguage.define(yamlMode),
  yml: StreamLanguage.define(yamlMode),
  c: StreamLanguage.define(c),
  cpp: StreamLanguage.define(cpp),
  'c++': StreamLanguage.define(cpp),
  java: StreamLanguage.define(java),
  cs: StreamLanguage.define(csharp),
  csharp: StreamLanguage.define(csharp),
  kotlin: StreamLanguage.define(kotlin),
  scala: StreamLanguage.define(scala),
  dart: StreamLanguage.define(dart),
};

/** CM extension for the fence's language (null = plain text). */
function languageFor(lang: string): Extension | null {
  const key = lang.toLowerCase();
  if (key === 'markdown' || key === 'md') return markdownParser();
  return codeLanguages[key] ?? null;
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
        syntaxHighlighting(codeHighlightStyle),
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
