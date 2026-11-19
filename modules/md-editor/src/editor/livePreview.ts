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
import { tableAt, cellSourcePos } from './tableKeymap';
import { syntaxTree } from '@codemirror/language';
import { finishRenderMath, renderMath, type App } from 'obsidian';
import { collectEmojiTokens, emojiReplace } from '../features/emojiShortcodes';
import { findMathDelimiters } from '../../../latex-delimiter-renderer/src/parser';
import { LATEX_DELIMITER_API_KEY, type LatexApi } from '../features/latexSource';
import {
  EditorSelection,
  EditorState,
  Facet,
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

/**
 * Per-editor live-preview switches. 代码注释区(FragmentHost codeComment)的块
 * 文本以 `#` 开头是**注释标记**而非 markdown 标题 —— 编辑态若走标题分支,
 * `lgp-h1` 行装饰把注释渲染成大字标题、光标移开后 `#` 还会被藏掉。宿主在
 * 挂载块编辑器时经 createEditorExtensions 提供本 facet 关掉标题渲染。
 */
export interface LivePreviewConfig {
  heading: boolean;
}

export const livePreviewConfig: Facet<Partial<LivePreviewConfig>, LivePreviewConfig> = Facet.define({
  combine: (vals) => ({
    heading: !vals.some((v) => v.heading === false),
  }),
});

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
      // 表格可视化编辑:单元格几何 → cellSourcePos 源码映射(mousedown 用)
      th.setAttribute('data-cell-row', '0');
      th.setAttribute('data-cell-col', String(i));
      if (aligns[i]) th.style.textAlign = aligns[i];
    });
    const tbody = table.createEl('tbody');
    for (let r = 2; r < rows.length; r++) {
      const tr = tbody.createEl('tr');
      // 渲染行号 = 逻辑行:0=表头,1=分隔行(不渲染),r-1=正文行
      const cellRow = r - 1;
      rows[r].forEach((cell, i) => {
        const td = tr.createEl('td');
        td.textContent = cell;
        td.setAttribute('data-cell-row', String(cellRow));
        td.setAttribute('data-cell-col', String(i));
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
const boldMark = Decoration.mark({ class: 'cm-strong' });
const italicMark = Decoration.mark({ class: 'lgp-italic' });
const strikeMark = Decoration.mark({ class: 'lgp-strike' });
const highlightMark = Decoration.mark({ class: 'lgp-highlight' });
const inlineCodeMark = Decoration.mark({ class: 'lgp-inline-code' });
const headingLine = [1, 2, 3, 4, 5, 6].map((n) => ({
  n,
  deco: Decoration.line({ class: `lgp-h${n}` }),
}));
const hrLine = Decoration.line({ class: 'lgp-hr-line' });

/** Inline marker pairs: [regex, mark length, content mark class?]. */
const PAIRS: Array<{ kind: string; re: RegExp; len: number; mark?: Decoration }> = [
  // CODE FIRST: code spans claim their range before the emphasis pairs, so
  // `__closure__` never false-triggers the __bold__ rule (CommonMark: code
  // spans win; emphasis inside them is literal).
  { kind: 'code', re: /`([^`\n]+)`/g, len: 1, mark: inlineCodeMark },
  { kind: 'bold', re: /\*\*(?=[^\s*])((?:[^*]|[\s\S]*?[^\s*])?)\*\*/g, len: 2, mark: boldMark },
  { kind: 'boldAlt', re: /__(?=[^\s_])[\s\S]*?[^\s_]__/g, len: 2, mark: boldMark },
  { kind: 'highlight', re: /==(?=[^\s=])[\s\S]*?[^\s=]==/g, len: 2, mark: highlightMark },
  { kind: 'strike', re: /~~(?=[^\s~])[\s\S]*?[^\s~]~~/g, len: 2, mark: strikeMark },
  { kind: 'comment', re: /%%([\s\S]*?)%%/g, len: 2, mark: commentMark },
  { kind: 'italic', re: /\*(?=[^\s*])(?:[^*\n]*[^\s*])?\*/g, len: 1, mark: italicMark },
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
  // Ranges already claimed by a processed construct. Code spans claim first;
  // emphasis may fully CONTAIN a claimed code span (CommonMark nesting), but
  // a partial overlap — e.g. __bold__ markers inside backticks — is dropped.
  const covered: Array<{ from: number; to: number; code: boolean }> = [];
  const overlaps = (from: number, to: number, isCode = false): boolean =>
    covered.some(
      (c) =>
        from < c.to &&
        to > c.from &&
        !(c.code && !isCode && from <= c.from && to >= c.to),
    );

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
        covered.push({ from, to, code: p.kind === 'code' }); // claim even when touched (blocks sub-matches)
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
      covered.push({ from, to, code: false });
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

  // --- emoji shortcodes (GitHub 风格 `:star2:` → 🌟) ---
  // 排他规则:行内 code 的 claim 绝对排斥(代码里 `:x:` 是字面);非 code
  // claim(加粗/wikilink)允许完全包含——`**:star2:**` 里照样出 emoji,
  // 与 GitHub 一致。部分重叠(emoji 撞上 wikilink alias 藏匿区)交给
  // buildFor 的重叠丢弃兜底。光标落在 token 上(含起点)回原样可编辑。
  for (const t of collectEmojiTokens(doc, covered)) {
    if (inBlock(t.from, t.to)) continue;
    specs.push({ from: t.from, to: t.to, kind: 'emoji', deco: emojiReplace(t.emoji) });
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
    // 代码注释区(codeComment 宿主)关闭此分支:`#` 是注释标记,按字面渲染。
    if (state.facet(livePreviewConfig).heading) {
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

/** Shared by the `$…$` widgets below. (`\(…\)` is owned by latex-delimiter-renderer.) */
export class MathPreviewWidget extends WidgetType {
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

// ---------------------------------------------------------------------------
// 斜杠 LaTeX（\(…\) / \[…\]）的编辑态渲染（用户 2026-11-20）。
//
// 此前斜杠 LaTeX 只活在 latex-delimiter-renderer 的两条路（原生 Live
// Preview + 阅读模式）与本模块的静态渲染面（latexSource 转发）——块编辑器
// 的**编辑态**（本 CM6 编辑器）里 `\(\sqrt{2}\)` 一直是生文本。这里补齐：
// 编辑态也按位置精确渲染，光标进入区间退回生文本（与 $…$ 组件同款规则，
// latex-suite 的补全/预览拥有区间内编辑权）。
//
// 数据源 = latex-delimiter-renderer 的 parser.findMathDelimiters（纯函数，
// 处理转义），与静态转发面共用同一实现（复用而非复刻）。开关同款半关：
// 模块没在跑（app 上没有它的 API）时本扩展不产装饰。
//
// 范围限定：逐可见行扫描——内联 `\(...\)` 天然不跨行；跨行 `\[…\]` 编辑态
// 不渲染（静态面已覆盖），避免 CM6 replace 装饰跨行的渲染坑。
// ---------------------------------------------------------------------------

export interface SlashMathMatch {
  from: number;
  to: number;
  body: string;
  display: boolean;
}

/**
 * 纯收集器（可单测）：在可见范围内扫 `\(…\)` / `\[…\]`，按光标规则与跳过
 * 区（代码块/行内代码/$ 数学区）过滤。skipZones 由调用方从 syntaxTree 收集。
 */
export function collectSlashMath(
  docText: string,
  visibleRanges: ReadonlyArray<{ from: number; to: number }>,
  selectionRanges: ReadonlyArray<{ from: number; to: number }>,
  skipZones: ReadonlyArray<{ from: number; to: number }>,
  enabled: boolean,
): SlashMathMatch[] {
  if (!enabled) return [];
  const matches: SlashMathMatch[] = [];
  for (const range of visibleRanges) {
    const lineText = docText.slice(range.from, range.to);
    for (const m of findMathDelimiters(lineText, range.from)) {
      if (m.source.includes('\n')) continue; // 跨行 \[…\] 编辑态不渲染
      // 光标规则：选区与区间重叠 → 生文本（latex-suite 拥有区间内编辑）
      if (selectionRanges.some((r) => r.from <= m.to && r.to >= m.from)) continue;
      // 跳过区（代码/行内代码/$ 数学区）：任一端落在区内即跳过
      const fromIn = skipZones.some((s) => m.from >= s.from && m.from < s.to);
      const toIn = skipZones.some((s) => m.to > s.from && m.to <= s.to);
      if (fromIn || toIn) continue;
      if (!m.source.trim()) continue;
      matches.push({ from: m.from, to: m.to, body: m.source, display: m.display });
    }
  }
  return matches;
}

/** 斜杠 LaTeX 编辑态渲染扩展（挂块编辑器与嵌入行两套列表）。 */
export function slashMathExtension(app: App): Extension {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet = Decoration.none;
      compute(view: EditorView): void {
        // 半关开关：latex-delimiter-renderer 没在跑 → 不产装饰
        const api = (app as unknown as Record<string, LatexApi | undefined>)[LATEX_DELIMITER_API_KEY];
        const enabled = typeof api?.convertForObsidianRender === 'function';
        // 跳过区：代码块 / 行内代码 / $ 数学区（可见范围内从语法树收集）
        const skipZones: Array<{ from: number; to: number }> = [];
        for (const range of view.visibleRanges) {
          syntaxTree(view.state).iterate({
            from: range.from,
            to: range.to,
            enter: (a) => {
              if (
                a.name === 'FencedCode'
                || a.name === 'CodeBlock'
                || a.name === 'InlineCode'
                || a.name.startsWith('Dollar')
              ) {
                skipZones.push({ from: a.from, to: a.to });
                return false;
              }
              return undefined;
            },
          });
        }
        const sel = view.state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
        const matches = collectSlashMath(
          view.state.doc.toString(),
          view.visibleRanges,
          sel,
          skipZones,
          enabled,
        );
        const builder = new RangeSetBuilder<Decoration>();
        for (const m of matches) {
          builder.add(m.from, m.to, Decoration.replace({ widget: new MathPreviewWidget(m.body, m.display) }));
        }
        this.decorations = builder.finish();
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.compute(u.view);
      }
    },
    { decorations: (v: { decorations: DecorationSet }) => v.decorations },
  );
}

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
        // 单元格精确命中:点击点向上找 td/th,取其在表内的 row/col
        let row = -1;
        let col = -1;
        const cellEl = target.closest('td, th') as HTMLElement | null;
        if (cellEl) {
          row = Number(cellEl.getAttribute('data-cell-row') ?? '-1');
          col = Number(cellEl.getAttribute('data-cell-col') ?? '-1');
          if (row < 0 || col < 0) {
            const tr = cellEl.closest('tr');
            const table = cellEl.closest('table');
            if (tr && table) {
              row = Array.from(table.querySelectorAll('tr')).indexOf(tr);
              col = Array.from(tr.querySelectorAll('td, th')).indexOf(cellEl);
            }
          }
        }
        // 文档坐标 → 所在表格块 → cellSourcePos(单元格内容起点)
        let pos: number;
        try {
          pos = view.posAtDOM(cellEl ?? target);
        } catch {
          pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY }) ?? 0;
        }
        pos = Math.min(Math.max(0, pos), view.state.doc.length);
        const tb = tableAt(view.state, pos);
        if (tb && row >= 0 && col >= 0) {
          const anchor = cellSourcePos(view.state, tb, row, col);
          if (anchor >= 0) {
            view.dispatch({ selection: EditorSelection.cursor(anchor), scrollIntoView: true });
            return true;
          }
        }
        view.dispatch({ selection: EditorSelection.cursor(pos) });
        return true;
      },
    }),
  ),
];
