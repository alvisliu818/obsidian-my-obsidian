/**
 * `\( … \)` — the LaTeX/MathJax spelling of inline math — in BOTH editors.
 *
 * Obsidian only understands `$…$` / `$$…$$`, so a note written for LaTeX or
 * MathJax shows its delimiters as literal backslashes and parens. Notes that
 * come from LaTeX, from MathJax-based tools, or from a habit formed elsewhere
 * use `\(x^2\)`, and those are the notes this makes render.
 *
 * One implementation covers every surface, because both editors are CM6 and
 * both render through the same two channels:
 *
 * | where                       | how                                          |
 * |---|---|---|
 * | native editor (live preview)| `registerEditorExtension` → this ViewPlugin  |
 * | Logseq outline editor       | same extension — the outline pulls Obsidian's
 *   `workspace.editorExtensions` in, so a registered extension runs there too |
 * | any reading view            | `registerMarkdownPostProcessor`              |
 * | Logseq static blocks        | rendered by `MarkdownRenderer.render`, which
 *   runs the same post processors                                            |
 *
 * The rule is decoration-only: the document text is never rewritten, and while
 * the caret is inside a span the raw `\(…\)` comes back so it stays editable
 * (the same contract the `$…$` widgets follow).
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view';
import { Prec, RangeSetBuilder } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import {
  editorLivePreviewField,
  finishRenderMath,
  renderMath,
  type MarkdownPostProcessorContext,
  type Plugin,
} from 'obsidian';
import { MathPreviewWidget } from '../editor/livePreview';

/**
 * One `\(…\)` span.
 *
 * Newlines are excluded on purpose: inline math is a line-level construct, and
 * a stray unclosed `\( ` would otherwise swallow the rest of the paragraph and
 * render it as one broken formula. The length cap keeps a pathological line
 * from turning into a huge MathJax job.
 */
const PAREN_MATH_RE = /\\\(([^\n]{1,500}?)\\\)/g;

/** Elements whose text is code, math, or otherwise not prose — never touched. */
const SKIP_TAGS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'MATH']);

/**
 * Every `\(…\)` span in `text` — pure, so both the editor widget and the
 * reading-mode rewrite share one definition of "a formula", and so the
 * matching rules can be unit-tested without a document.
 *
 * Empty bodies are dropped (`\()` is not a formula) and spans never overlap.
 */
export function parenMathSpans(text: string): Array<{ from: number; to: number; body: string }> {
  const out: Array<{ from: number; to: number; body: string }> = [];
  PAREN_MATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PAREN_MATH_RE.exec(text)) !== null) {
    // `\\(` is an escaped backslash followed by a literal paren, not a
    // delimiter — the same rule the markdown parser applies to `\$`.
    if (m.index > 0 && text.charCodeAt(m.index - 1) === 92 /* \ */) continue;
    const body = m[1].trim();
    if (!body) continue;
    out.push({ from: m.index, to: m.index + m[0].length, body });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Editing: in-place widget in any CM6 editor
// ---------------------------------------------------------------------------

/** Syntax nodes whose text is code: a `\(…\)` in there is source, not math. */
const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'CodeText', 'CodeMark']);

/** Ranges of the visible text that are code (never decorated). */
function codeRanges(view: EditorView): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  syntaxTree(view.state).iterate({
    enter: (node) => {
      if (!CODE_NODES.has(node.name)) return undefined;
      out.push({ from: node.from, to: node.to });
      return false;
    },
  });
  return out;
}

/**
 * True when live preview is off (source mode).
 *
 * `editorLivePreviewField` is Obsidian's own switch, and reading it with a
 * fallback keeps the extension safe in a view that never installed it (the
 * outline editor reports true; a plain CM6 view simply renders).
 */
function sourceMode(view: EditorView): boolean {
  try {
    return view.state.field(editorLivePreviewField as never, false) === false;
  } catch {
    return false; // no such field — treat as live preview
  }
}

export const parenMathExtension = Prec.high(
  ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet = Decoration.none;

      constructor(view: EditorView) {
        this.compute(view);
      }

      update(u: ViewUpdate): void {
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged) this.compute(u.view);
      }

      private compute(view: EditorView): void {
        // Source mode keeps the raw text, the way Obsidian treats `$…$` there.
        if (sourceMode(view)) {
          this.decorations = Decoration.none;
          return;
        }
        const ranges = view.state.selection.ranges;
        const code = codeRanges(view);
        const builder = new RangeSetBuilder<Decoration>();
        let any = false;
        for (const { from, to } of view.visibleRanges) {
          for (const s of parenMathSpans(view.state.sliceDoc(from, to))) {
            const start = from + s.from;
            const end = from + s.to;
            // Caret strictly inside → leave the source visible (editable).
            if (ranges.some((r) => r.from <= end && r.to >= start)) continue;
            if (code.some((c) => c.from <= end && c.to >= start)) continue;
            builder.add(start, end, Decoration.replace({ widget: new MathPreviewWidget(s.body, false) }));
            any = true;
          }
        }
        this.decorations = any ? builder.finish() : Decoration.none;
      }
    },
    { decorations: (v: { decorations: DecorationSet }) => v.decorations },
  ),
);

// ---------------------------------------------------------------------------
// Reading: rewrite rendered text nodes
// ---------------------------------------------------------------------------

/** Text nodes worth inspecting: outside code, math and already-rendered bits. */
function collectTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p: Node | null = node.parentElement;
      while (p && p !== root) {
        const el = p as HTMLElement;
        if (SKIP_TAGS.has(el.nodeName)) return NodeFilter.FILTER_REJECT;
        if (el.classList?.contains('math') || el.hasAttribute?.('data-math')) {
          return NodeFilter.FILTER_REJECT;
        }
        p = el.parentElement;
      }
      return node.nodeValue?.includes('\\(') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let n = walker.nextNode();
  while (n) {
    out.push(n as Text);
    n = walker.nextNode();
  }
  return out;
}

/** Replace every span in one text node with rendered math. Returns changed? */
function renderTextNode(node: Text): boolean {
  const text = node.nodeValue ?? '';
  const spans = parenMathSpans(text);
  if (spans.length === 0) return false;
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const s of spans) {
    if (s.from > last) frag.append(text.slice(last, s.from));
    try {
      frag.append(renderMath(s.body, false));
    } catch {
      // A formula MathJax refuses is still text — show it raw rather than
      // dropping the user's content on the floor.
      frag.append(text.slice(s.from, s.to));
    }
    last = s.to;
  }
  if (last < text.length) frag.append(text.slice(last));
  node.replaceWith(frag);
  return true;
}

/**
 * Install both halves. Called once from `onload`.
 *
 * The post processor runs LAST-ish but never assumes it owns the DOM: it only
 * touches text nodes that still contain a literal `\(`, so a plugin that
 * already rendered math (or a `$…$` region) is left alone.
 */
export function registerParenMath(plugin: Plugin): void {
  plugin.registerEditorExtension(parenMathExtension);
  plugin.registerMarkdownPostProcessor((el: HTMLElement, _ctx: MarkdownPostProcessorContext) => {
    if (!el.textContent?.includes('\\(')) return;
    let changed = false;
    for (const node of collectTextNodes(el)) {
      if (renderTextNode(node)) changed = true;
    }
    if (changed) void finishRenderMath();
  });
}
