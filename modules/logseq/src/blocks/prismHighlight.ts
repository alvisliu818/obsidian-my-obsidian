/**
 * Prism-based syntax highlighting for the code-block EDITOR.
 *
 * The reading view renders code through Obsidian's MarkdownRenderer, which
 * runs Prism and emits `.token.<type>` spans colored by the rules in
 * styles.css. Highlighting the editor with CodeMirror's own language stack
 * (StreamLanguage/lezer) always diverges: different tokenizer, different token
 * classification (function-call names, builtins, operators…). Instead we run
 * the SAME Prism grammars over the editor document and map the token stream
 * to CM6 mark decorations carrying the SAME `.token <type>` classes — the
 * styles.css rules then color both states identically, one palette, zero
 * mapping drift.
 */

import Prism from 'prismjs';
// Grammar components — each import registers itself into Prism.languages.
// Order matters where a grammar extends another (cpp after c, etc.).
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-scala';
import 'prismjs/components/prism-dart';
import 'prismjs/components/prism-markdown';
import { ViewPlugin, Decoration, type DecorationSet, type EditorView, type ViewUpdate } from 'cm-bundle:@codemirror/view';
import type { Extension } from 'cm-bundle:@codemirror/state';

/** fence alias -> key in Prism.languages */
const LANG_ALIASES: Record<string, string> = {
  py: 'python',
  cython: 'python',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  mysql: 'sql',
  postgresql: 'sql',
  shell: 'bash',
  sh: 'bash',
  zsh: 'bash',
  rs: 'rust',
  yml: 'yaml',
  'c++': 'cpp',
  cs: 'csharp',
  md: 'markdown',
};

/** The Prism grammar for a fence language (null = plain text). */
export function prismGrammarFor(lang: string): Prism.Grammar | null {
  const key = LANG_ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  const g = (Prism.languages as unknown as Record<string, Prism.Grammar | undefined>)[key];
  return g ?? null;
}

export interface FlatToken {
  from: number;
  to: number;
  /** Space-separated Prism classes WITHOUT the leading "token" (e.g. "function"). */
  type: string;
}

/**
 * Flatten Prism's nested token stream into absolute-position ranges. Nested
 * tokens produce an outer range plus inner ones — like Prism's nested spans.
 */
export function flattenTokens(tokens: (string | Prism.Token)[], base: number, out: FlatToken[], parentType?: string): void {
  for (const tk of tokens) {
    if (typeof tk === 'string') {
      base += tk.length;
      continue;
    }
    const type = parentType ? `${parentType} ${tk.type}` : tk.type;
    const start = base;
    const end = base + tk.length;
    out.push({ from: start, to: end, type });
    if (Array.isArray(tk.content)) {
      flattenTokens(tk.content, start, out, type);
    } else if (tk.content instanceof Prism.Token) {
      flattenTokens([tk.content], start, out, type);
    }
    base = end;
  }
}

/**
 * Same fix-up the reading view applies (renderTree.enhanceCodeTokens):
 * Prism leaves call names as plain text; an identifier directly followed by
 * a `(` punctuation token becomes `.token.function` there — mirror it here so
 * both states agree. Plain text = the gaps between token ranges.
 */
export function enhanceCallNames(flat: FlatToken[], text: string): FlatToken[] {
  const extra: FlatToken[] = [];
  let cursor = 0; // end of the previous token = start of the current plain gap
  for (let i = 0; i <= flat.length; i++) {
    const tok = flat[i];
    const gapEnd = tok ? tok.from : text.length;
    if (i > 0 && flat[i - 1] && flat[i - 1].to === gapEnd) {
      // zero-width gap — nothing between the previous token and this one
    } else if (tok && tok.type.split(' ').includes('punctuation') && text.slice(tok.from, tok.from + 1) === '(') {
      const gap = text.slice(cursor, gapEnd);
      const m = /([A-Za-z_$][\w$]*)\s*$/.exec(gap);
      if (m) {
        const idStart = cursor + m.index;
        extra.push({ from: idStart, to: idStart + m[1].length, type: 'function' });
      }
    }
    if (tok) cursor = tok.to;
  }
  return extra;
}

function highlightDeco(view: EditorView, grammar: Prism.Grammar): DecorationSet {
  const text = view.state.doc.toString();
  const tokens = Prism.tokenize(text, grammar);
  const flat: FlatToken[] = [];
  flattenTokens(tokens, 0, flat);
  const all = [...flat, ...enhanceCallNames(flat, text)].sort((a, b) => a.from - b.from || b.to - a.to);
  const deco = all.map((t) => Decoration.mark({ class: `token ${t.type}` }).range(t.from, t.to));
  return Decoration.set(deco, true);
}

/** CM6 extension: Prism highlighting with `.token <type>` classes (reading-view parity). */
export function prismHighlightExtension(grammar: Prism.Grammar): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = highlightDeco(view, grammar);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = highlightDeco(u.view, grammar);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
