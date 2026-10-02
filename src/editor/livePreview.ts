/**
 * Live preview (实时预览 — Obsidian's default editing mode) for the focused
 * block editor. Markdown syntax the caret is NOT touching renders: delimiter
 * marks hide (`**`, `` ` ``, `#`, `|` …), wikilinks show without brackets,
 * headings take their sized form, `---` becomes a divider, and a table run
 * is replaced by a real rendered <table> (cells, alignment, header emphasis).
 * Move the caret into a construct and its raw
 * syntax returns — the native live-preview behavior. Decoration-only: the
 * document text, block model and saved file are never touched.
 *
 * Obsidian's own live preview is an internal CM extension set bound to its
 * internal editor component and cannot be mounted on an outside view, so
 * this is a from-scratch port of the visible behavior. Live preview is
 * ALWAYS on in the block editors; raw source is a per-block choice via the
 * block context menu ("Source mode"), which mounts the editor without this
 * extension for that one edit session.
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { finishRenderMath, renderMath } from 'obsidian';
import {
  EditorSelection,
  EditorState,
  Prec,
  RangeSetBuilder,
  StateField,
  type Extension,
} from '@codemirror/state';

/** One emitted decoration before RangeSet assembly. */
export interface LiveSpec {
  from: number;
  to: number;
  kind: string;
  deco: Decoration;
  /** Line decorations must sort before point decorations at the same pos. */
  lineFirst?: boolean;
}

const hide = Decoration.replace({});

class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'lgp-hr';
    return el;
  }
}

/**
 * A rendered <table> replacing the raw pipe rows while the caret is away —
 * the same live-preview behavior as the native editor. `eq` compares the
 * source text so any edit to the rows swaps the DOM.
 */
class TableWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(o: WidgetType): boolean {
    return o instanceof TableWidget && o.text === this.text;
  }
  // Let clicks through the rendered table reach the editor's handlers — the
  // default (true) would starve our mousedown handler entirely.
  ignoreEvent(): boolean {
    return false;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'lgp-table';
    const table = wrap.createEl('table');
    const rows = this.text.split('\n').map(splitCells);
    const aligns = rows.length > 1 ? rows[1].map(alignOf) : [];
    const trh = table.createEl('thead').createEl('tr');
    rows[0].forEach((cell, i) => {
      const th = trh.createEl('th');
      th.textContent = cell;
      if (aligns[i]) th.style.textAlign = aligns[i];
    });
    const tbody = table.createEl('tbody');
    for (let r = 2; r < rows.length; r++) {
      const tr = tbody.createEl('tr');
      rows[r].forEach((cell, i) => {
        const td = tr.createEl('td');
        td.textContent = cell;
        if (aligns[i]) td.style.textAlign = aligns[i];
      });
    }
    return wrap;
  }
}

/** Split a table row into cells, honoring `\|` escapes. */
function splitCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** GFM alignment from a delimiter cell (`:---` / `:---:` / `---:`). */
function alignOf(cell: string): string {
  const t = cell.trim();
  if (/^:?-+:$/.test(t)) {
    if (t.startsWith(':') && t.endsWith(':')) return 'center';
    if (t.endsWith(':')) return 'right';
    return 'left';
  }
  return '';
}

const hrReplace = Decoration.replace({ widget: new HrWidget() });
const wikilinkMark = Decoration.mark({ class: 'lgp-wikilink' });
const commentMark = Decoration.mark({ class: 'lgp-comment' });
const headingLine = [1, 2, 3, 4, 5, 6].map((n) => ({
  n,
  deco: Decoration.line({ class: `lgp-h${n}` }),
}));
const hrLine = Decoration.line({ class: 'lgp-hr-line' });

/** Inline marker pairs: [regex, mark length, content mark class?]. */
const PAIRS: Array<{ kind: string; re: RegExp; len: number; mark?: Decoration }> = [
  { kind: 'bold', re: /\*\*(?=[^\s*])((?:[^*]|[\s\S]*?[^\s*])?)\*\*/g, len: 2 },
  { kind: 'boldAlt', re: /__(?=[^\s_])[\s\S]*?[^\s_]__/g, len: 2 },
  { kind: 'highlight', re: /==(?=[^\s=])[\s\S]*?[^\s=]==/g, len: 2 },
  { kind: 'strike', re: /~~(?=[^\s~])[\s\S]*?[^\s~]~~/g, len: 2 },
  { kind: 'comment', re: /%%([\s\S]*?)%%/g, len: 2, mark: commentMark },
  { kind: 'code', re: /`([^`\n]+)`/g, len: 1 },
  { kind: 'italic', re: /\*(?=[^\s*])(?:[^*\n]*[^\s*])?\*/g, len: 1 },
];

const WIKILINK_RE = /(?<!!)\[\[([^\[\]\n]+)\]\]/g;
const HEADING_RE = /^(#{1,6})(\s+)/;
const HR_LINE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Collect live-preview decorations for the given state. Pure — unit-tested
 * without a DOM. A construct renders unless the selection reaches into it:
 * any overlap with its interior, or a collapsed caret at its START (the
 * widget-click / "enter from above" position). A caret sitting exactly at a
 * construct's END counts as being AFTER it — clicking into a block (caret at
 * doc end) must not flip the trailing table/bold back to raw.
 */
export function collectLivePreview(state: EditorState): LiveSpec[] {
  const sel = state.selection.ranges;
  /** Any overlap with the open interval (from, to). */
  const inInterior = (from: number, to: number): boolean =>
    sel.some((r) => r.to > from && r.from < to);
  /** Interior overlap, or the caret parked exactly at `from`. */
  const inBlock = (from: number, to: number): boolean =>
    inInterior(from, to) || sel.some((r) => r.from === from && r.to === from);
  /** Any overlap with the closed interval [from, to] — line constructs. */
  const onLine = (from: number, to: number): boolean =>
    sel.some((r) => r.from <= to && r.to >= from);

  const doc = state.doc;
  const specs: LiveSpec[] = [];
  // Ranges already claimed by a longer construct (bold before italic, code
  // spans before the regex pass).
  const covered: Array<[number, number]> = [];
  const overlaps = (from: number, to: number): boolean =>
    covered.some(([a, b]) => from < b && to > a);

  // --- inline marker pairs ---
  for (let ln = 1; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    for (const p of PAIRS) {
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.re.exec(line.text))) {
        const from = line.from + m.index;
        const to = from + m[0].length;
        if (to - from <= p.len * 2) continue; // empty content
        if (overlaps(from, to)) continue;
        covered.push([from, to]); // claim even when touched (blocks sub-matches)
        if (inInterior(from, to)) continue;
        specs.push({ from, to: from + p.len, kind: p.kind, deco: hide });
        specs.push({ from: to - p.len, to, kind: p.kind, deco: hide });
        if (p.mark && to - p.len > from + p.len) {
          specs.push({ from: from + p.len, to: to - p.len, kind: p.kind + ':mark', deco: p.mark });
        }
      }
    }
  }

  // --- wikilinks (not ![[embeds]] — those keep their raw form) ---
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    WIKILINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(line.text))) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      if (overlaps(from, to)) continue;
      covered.push([from, to]);
      if (inInterior(from, to)) continue;
      specs.push({ from, to: from + 2, kind: 'wikilink', deco: hide });
      specs.push({ from: to - 2, to, kind: 'wikilink', deco: hide });
      const innerFrom = from + 2;
      const pipe = m[1].indexOf('|');
      let visFrom = innerFrom;
      if (pipe >= 0) {
        visFrom = innerFrom + pipe + 1;
        // `page|alias` — show only the alias.
        specs.push({ from: innerFrom, to: visFrom, kind: 'wikilink:alias', deco: hide });
      }
      if (visFrom < to - 2) {
        specs.push({ from: visFrom, to: to - 2, kind: 'wikilink:mark', deco: wikilinkMark });
      }
    }
  }

  // --- per-line constructs (fence-aware: nothing decorates inside fences) ---
  let inFence = false;
  let fenceMarker = '';
  let n = 1;
  while (n <= doc.lines) {
    const line = doc.line(n);
    const fence = FENCE_RE.exec(line.text);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1];
      } else if (line.text.trimStart().startsWith(fenceMarker)) {
        inFence = false;
      }
      n++;
      continue;
    }
    if (inFence) {
      n++;
      continue;
    }

    // Table run: consecutive `|` rows whose second row is the delimiter.
    if (/^\s*\|/.test(line.text)) {
      const run: typeof line[] = [];
      let k = n;
      while (k <= doc.lines && /^\s*\|/.test(doc.line(k).text)) {
        run.push(doc.line(k));
        k++;
      }
      if (run.length >= 2 && TABLE_DELIM_RE.test(run[1].text)) {
        const from = run[0].from;
        const to = run[run.length - 1].to;
        if (!inBlock(from, to)) {
          const text = run.map((l) => l.text).join('\n');
          // Non-block replace: a block widget covering the ENTIRE document
          // (table-only block) degenerates CM's line rendering; an inline
          // widget keeps the host line and renders the table inside it.
          specs.push({
            from,
            to,
            kind: 'table',
            deco: Decoration.replace({ widget: new TableWidget(text) }),
          });
        }
        n = k;
        continue;
      }
    }

    // Heading: hide the `#` prefix unless the caret is on the line.
    const h = HEADING_RE.exec(line.text);
    if (h) {
      if (!onLine(line.from, line.to)) {
        const level = h[1].length;
        specs.push({
          from: line.from,
          to: line.from,
          kind: `heading${level}`,
          deco: headingLine[level - 1].deco,
          lineFirst: true,
        });
        specs.push({ from: line.from, to: line.from + h[0].length, kind: `heading${level}`, deco: hide });
      }
      n++;
      continue;
    }

    // Horizontal rule: divider widget unless the caret is on the line.
    if (HR_LINE_RE.test(line.text) && !onLine(line.from, line.to)) {
      specs.push({ from: line.from, to: line.from, kind: 'hr', deco: hrLine, lineFirst: true });
      specs.push({ from: line.from, to: line.to, kind: 'hr', deco: hrReplace });
    }
    n++;
  }

  return specs;
}

/**
 * Live-preview extension — pair with the markdown() syntax extension.
 *
 * Decorations come from a StateField, not a ViewPlugin: the table widget
 * replaces line breaks, which CM6 only allows for field-provided sets
 * ("Decorations that replace line breaks may not be specified via plugins").
 * Recomputing per transaction is fine — the edited doc is one block's text.
 */
const buildFor = (state: EditorState): DecorationSet => {
  const specs = collectLivePreview(state);
  if (specs.length === 0) return Decoration.none;
  specs.sort((a, b) => a.from - b.from || (a.lineFirst ? -1 : 1) - (b.lineFirst ? -1 : 1));
  const builder = new RangeSetBuilder<Decoration>();
  // RangeSetBuilder throws on overlaps — pathological constructs (a pipe
  // inside bold markers, …) could produce them; first spec wins.
  let lastTo = -1;
  for (const s of specs) {
    if (s.from < lastTo) continue;
    builder.add(s.from, s.to, s.deco);
    if (s.to > lastTo) lastTo = s.to;
  }
  return builder.finish();
};

const livePreviewField = StateField.define<DecorationSet>({
  create: buildFor,
  update: (_value, tr) => buildFor(tr.state),
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * In-place rendered math for the math regions whose region does NOT contain
 * the caret. Division of labor with latex-suite: while the caret is WITHIN a
 * math region, latex-suite's own preview tooltip renders it (its
 * mathPreviewLivePreviewDisplay setting covers $$..$$ in live preview); once
 * the caret is elsewhere, this widget renders the region in place so the
 * outline looks like the reading view. The two never duplicate: the tooltip
 * owns the region inclusively, the widget claims it strictly outside.
 */
/** Extract the math body (+ display flag) from a math syntax node. */
function mathBody(state: EditorState, node: { from: number; to: number; name: string }): { body: string; display: boolean } {
  const text = state.sliceDoc(node.from, node.to);
  if (node.name === 'DollarDisplayBlockMath') {
    const lines = text.split('\n');
    const first = lines[0];
    const last = lines[lines.length - 1];
    const head = first.indexOf('$$');
    const tail = last.lastIndexOf('$$');
    const parts = [first.slice(head + 2), ...lines.slice(1, -1), last.slice(0, tail < 0 ? last.length : tail)];
    return { body: parts.filter((p) => p.length > 0).join('\n'), display: true };
  }
  const dLen = node.name === 'DollarDisplayMath' ? 2 : 1;
  return { body: text.slice(dLen, Math.max(dLen, text.length - dLen)), display: node.name === 'DollarDisplayMath' };
}

class MathPreviewWidget extends WidgetType {
  constructor(
    readonly body: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(o: WidgetType): boolean {
    return o instanceof MathPreviewWidget && o.body === this.body && o.display === this.display;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'lgp-math-preview';
    try {
      el.appendChild(renderMath(this.body, this.display));
      void finishRenderMath();
    } catch {
      el.textContent = this.body;
    }
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

export const mathWidgetExtension: Extension = ViewPlugin.fromClass(
  class implements PluginValue {
    decorations: DecorationSet = Decoration.none;
    constructor(view: EditorView) {
      this.compute(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.compute(u.view);
    }
    private compute(view: EditorView): void {
      const sel = view.state.selection.ranges;
      const out: Array<{ from: number; to: number; body: string; display: boolean }> = [];
      syntaxTree(view.state).iterate({
        enter: (a) => {
          if (a.name === 'DollarInlineMath' || a.name === 'DollarDisplayMath' || a.name === 'DollarDisplayBlockMath') {
            // latex-suite's tooltip owns the region inclusively; in-place
            // render only when the caret is strictly outside it.
            const inside = sel.some((r) => r.from <= a.to && r.to >= a.from);
            if (!inside) {
              const { body, display } = mathBody(view.state, { from: a.from, to: a.to, name: a.name });
              if (body.trim()) out.push({ from: a.from, to: a.to, body, display });
            }
            return false;
          }
          if (a.name === 'FencedCode' || a.name === 'CodeBlock') return false;
          return undefined;
        },
      });
      const builder = new RangeSetBuilder<Decoration>();
      for (const n of out) {
        builder.add(n.from, n.to, Decoration.replace({ widget: new MathPreviewWidget(n.body, n.display) }));
      }
      this.decorations = builder.finish();
    }
  },
  { decorations: (v: { decorations: DecorationSet }) => v.decorations },
);

export const livePreviewExtension: Extension = [
  livePreviewField,
  // Clicking a rendered table places the caret at its range start — an
  // endpoint touch, so the raw rows return (native live-preview interaction).
  // Prec.high: CM's own mousedown handler would otherwise run first and
  // return true, skipping this one (runHandlers stops at the first truthy).
  Prec.high(
    EditorView.domEventHandlers({
      mousedown: (ev, view) => {
        const target = ev.target as HTMLElement | null;
        if (!target || !target.closest('.lgp-table')) return false;
        ev.preventDefault();
        let pos: number;
        try {
          pos = view.posAtDOM(target);
        } catch {
          pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY }) ?? 0;
        }
        pos = Math.min(Math.max(0, pos), view.state.doc.length);
        view.dispatch({ selection: EditorSelection.cursor(pos) });
        return true;
      },
    }),
  ),
];
