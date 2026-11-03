import {
  editorLivePreviewField,
  finishRenderMath,
  loadMathJax,
  type MarkdownPostProcessorContext,
  Plugin,
  renderMath
} from "obsidian";
import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType
} from "@codemirror/view";
import {
  convertForObsidianRender,
  findMathDelimiters,
  type MathDelimiterMatch
} from "./parser";

const READING_RENDER_MARKER = "data-latex-delimiter-renderer-section";

/**
 * How far back to look when the predicted position overshoots.
 *
 * Predictions only account for stripped backslashes. If the prose in front of
 * a formula also lost emphasis markers, the formula sits EARLIER than
 * predicted. Deliberately small: it must absorb a few markers, not let the
 * search drift back to same-shaped ordinary text further up the section.
 */
const DRIFT_WINDOW = 120;

/** The ASCII punctuation markdown lets a backslash escape (CommonMark). */
const ESCAPABLE = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

/**
 * What markdown leaves of the source: `\X` collapses to `X`.
 *
 * `\(E=mc^2\)` reaches the DOM as `(E=mc^2)`, so a needle built from the raw
 * source would never match. It also keeps bodies honest: `a\,b` — `\,` is a
 * LaTeX spacing command — reaches the DOM as `a,b`.
 */
export function stripMarkdownEscapes(source: string): string {
  let result = "";
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\\" && ESCAPABLE.includes(source[index + 1] ?? "")) {
      result += source[index + 1];
      index++;
      continue;
    }
    result += source[index];
  }
  return result;
}

/**
 * Emphasis markers markdown swallows when it rewrites a body into elements.
 *
 * `\(a_1 + b_2\)` renders as `(a<em>1 + b</em>2)` — the underscores vanish from
 * `textContent` while the letters survive. Stripping them from both sides keeps
 * the needle recognisable. LaTeX subscripts make this the common case, not a
 * corner one.
 */
export function stripEmphasis(source: string): string {
  return source.replace(/[*_~]/g, "");
}

function renderFormula(source: string, display: boolean, blockHost = display): HTMLElement {
  const wrapper = blockHost ? createDiv() : createSpan();
  wrapper.className = blockHost
    ? "latex-delimiter-renderer latex-delimiter-renderer-block"
    : "latex-delimiter-renderer latex-delimiter-renderer-inline";
  wrapper.appendChild(renderMath(source, display));
  return wrapper;
}

type RenderedCharacter = { node: Text; offset: number };

function renderedCharacters(element: HTMLElement): {
  text: string;
  characters: RenderedCharacter[];
} {
  let text = "";
  const characters: RenderedCharacter[] = [];

  function visit(node: Node): void {
    if (node.instanceOf(Text)) {
      for (let offset = 0; offset < node.data.length; offset++) {
        text += node.data[offset];
        characters.push({ node, offset });
      }
      return;
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  }

  visit(element);
  return { text, characters };
}

/**
 * This element's slice of the document.
 *
 * `getSectionInfo().text` is the WHOLE file; `lineStart`/`lineEnd` carve out
 * the part this element came from. Slicing also makes offsets section-relative,
 * which is what lets a formula be positioned instead of merely searched for.
 */
export function sectionTextOf(section: {
  text: string;
  lineStart: number;
  lineEnd: number;
}): string {
  return section.text.split("\n").slice(section.lineStart, section.lineEnd + 1).join("\n");
}

/** The formula as it looks once rendered: `\(a\,b\)` → `(a,b)`. */
export function visibleForm(match: MathDelimiterMatch): string {
  return stripMarkdownEscapes(
    (match.display ? "\\[" : "\\(") + match.source + (match.display ? "\\]" : "\\)")
  );
}

/**
 * Where a formula actually is, allowing markdown to have rewritten things.
 *
 * Three tries, cheapest and safest first:
 *
 *  1. exact match at/after the predicted `at` — nearly every real formula;
 *  2. the same, backed up by `DRIFT_WINDOW` — for emphasis in front of it;
 *  3. normalised match (see `stripEmphasis`) — for emphasis inside the body.
 *
 * Every step is bounded, so a miss degrades to "not rendered" rather than to
 * "the wrong text turned into math". The length is returned separately because
 * a normalised match can be SHORTER than the needle.
 */
export function locateVisible(
  text: string,
  needle: string,
  from: number,
  at: number
): { from: number; to: number } | null {
  const anchor = Math.max(from, at);
  const exact = text.indexOf(needle, anchor);
  if (exact !== -1) return { from: exact, to: exact + needle.length };

  const back = Math.max(from, at - DRIFT_WINDOW);
  if (back < anchor) {
    const retry = text.indexOf(needle, back);
    if (retry !== -1) return { from: retry, to: retry + needle.length };
  }

  const start = text.indexOf(needle[0], anchor);
  if (start === -1) return null;
  const want = stripEmphasis(needle.slice(1, -1));
  const limit = Math.min(text.length, start + 1 + needle.length + DRIFT_WINDOW);
  for (let close = start + 1; close < limit; close++) {
    if (text[close] !== needle[needle.length - 1]) continue;
    if (stripEmphasis(text.slice(start + 1, close)) === want) {
      return { from: start, to: close + 1 };
    }
  }
  return null;
}

async function renderReadingView(
  element: HTMLElement,
  context: MarkdownPostProcessorContext
): Promise<void> {
  if (element.closest(`[${READING_RENDER_MARKER}]`)) return;

  const section = context.getSectionInfo(element);
  if (!section) return;
  const sectionText = sectionTextOf(section);
  const matches = findMathDelimiters(sectionText);
  if (matches.length === 0) return;

  const rendered = renderedCharacters(element);
  const replacements: Array<{
    from: number;
    to: number;
    match: MathDelimiterMatch;
  }> = [];

  // `floor` keeps replacements ordered and disjoint, so a second formula can
  // never be matched back onto text the first one already consumed.
  let floor = 0;
  for (const match of matches) {
    const needle = visibleForm(match);
    const at = stripMarkdownEscapes(sectionText.slice(0, match.from)).length;
    const located = locateVisible(rendered.text, needle, floor, at);
    if (!located) continue;
    replacements.push({ from: located.from, to: located.to, match });
    floor = located.to;
  }

  if (replacements.length === 0) return;

  element.setAttribute(READING_RENDER_MARKER, "");
  replacements.sort((left, right) => right.from - left.from);
  for (const replacement of replacements) {
    const first = rendered.characters[replacement.from];
    const last = rendered.characters[replacement.to - 1];
    if (!first || !last) continue;

    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    range.deleteContents();
    range.insertNode(
      renderFormula(
        replacement.match.source,
        replacement.match.display,
        replacement.match.display
      )
    );
  }
  await finishRenderMath();
}

function rangeTouchesSelection(state: EditorState, match: MathDelimiterMatch): boolean {
  return state.selection.ranges.some((range) => {
    if (range.empty) {
      return range.from > match.from && range.from < match.to;
    }
    return range.from < match.to && range.to > match.from;
  });
}

function isInsideInlineCode(state: EditorState, position: number): boolean {
  const line = state.doc.lineAt(position);
  const before = line.text.slice(0, position - line.from);
  const ticks = before.match(/`+/g) ?? [];
  return ticks.length % 2 === 1;
}

function fencedCodeRanges(text: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  const fence = /^(?: {0,3})(`{3,}|~{3,}).*$/gm;
  let open: { character: string; length: number; from: number } | null = null;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(text)) !== null) {
    const marker = match[1];
    if (!open) {
      open = { character: marker[0], length: marker.length, from: match.index };
    } else if (marker[0] === open.character && marker.length >= open.length) {
      ranges.push({ from: open.from, to: fence.lastIndex });
      open = null;
    }
  }
  if (open) ranges.push({ from: open.from, to: text.length });
  return ranges;
}

function overlapsRange(
  match: MathDelimiterMatch,
  ranges: Array<{ from: number; to: number }>
): boolean {
  return ranges.some((range) => match.from < range.to && match.to > range.from);
}

class MathWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly display: boolean,
    private readonly block: boolean,
    private readonly revealPosition: number
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return (
      this.source === other.source &&
      this.display === other.display &&
      this.block === other.block &&
      this.revealPosition === other.revealPosition
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const element = renderFormula(this.source, this.display, this.block);
    element.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        selection: { anchor: this.revealPosition },
        scrollIntoView: true
      });
      view.focus();
    });
    void finishRenderMath();
    return element;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === "mousedown";
  }
}

class LiteralMarkerWidget extends WidgetType {
  constructor(private readonly marker: string) {
    super();
  }

  eq(other: LiteralMarkerWidget): boolean {
    return this.marker === other.marker;
  }

  toDOM(): HTMLElement {
    const element = createSpan();
    element.className = "latex-delimiter-renderer-source-marker";
    element.textContent = this.marker;
    return element;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function markdownFormattingMarkersInMath(
  state: EditorState,
  match: MathDelimiterMatch
): Array<{ to: number; text: string }> {
  const markers: Array<{ to: number; text: string }> = [];

  syntaxTree(state).iterate({
    from: match.from,
    to: match.to,
    enter(node) {
      if (
        (node.name.includes("formatting-em") ||
          node.name.includes("formatting-strong")) &&
        node.from >= match.from &&
        node.to <= match.to
      ) {
        markers.push({
          to: node.to,
          text: state.doc.sliceString(node.from, node.to)
        });
      }
      return true;
    }
  });

  return markers;
}

function emphasisSpillsFromMath(
  state: EditorState,
  match: MathDelimiterMatch
): Array<{ from: number; to: number }> {
  const spills: Array<{ from: number; to: number }> = [];
  const textAfterMatch = state.doc.sliceString(match.to);
  const paragraphBreak = /\n[\t ]*\n/.exec(textAfterMatch);
  const paragraphEnd = paragraphBreak
    ? match.to + paragraphBreak.index
    : state.doc.length;
  const emphasisMarkers: number[] = [];
  const strongMarkers: number[] = [];

  syntaxTree(state).iterate({
    from: match.from,
    to: paragraphEnd,
    enter(node) {
      if (node.name.includes("formatting-em")) emphasisMarkers.push(node.from);
      if (node.name.includes("formatting-strong")) strongMarkers.push(node.from);
      return true;
    }
  });

  for (const markers of [emphasisMarkers, strongMarkers]) {
    const markersInsideMath = markers.filter((position) => position < match.to);
    if (markersInsideMath.length % 2 === 0) continue;

    const closingMarker = markers.find((position) => position >= match.to);
    const spillEnd = closingMarker ?? paragraphEnd;
    if (spillEnd > match.to) spills.push({ from: match.to, to: spillEnd });
  }

  return spills;
}

function buildLivePreviewDecorations(state: EditorState): DecorationSet {
  if (!state.field(editorLivePreviewField, false)) return Decoration.none;

  const text = state.doc.toString();
  const codeRanges = fencedCodeRanges(text);
  const ranges: ReturnType<Decoration["range"]>[] = [];

  for (const match of findMathDelimiters(text)) {
    if (
      overlapsRange(match, codeRanges) ||
      isInsideInlineCode(state, match.from)
    ) {
      continue;
    }

    for (const spill of emphasisSpillsFromMath(state, match)) {
      ranges.push(
        Decoration.mark({ class: "latex-delimiter-renderer-emphasis-spill" }).range(
          spill.from,
          spill.to
        )
      );
    }

    if (rangeTouchesSelection(state, match)) {
      ranges.push(
        Decoration.mark({ class: "latex-delimiter-renderer-source" }).range(
          match.from,
          match.to
        )
      );
      for (const marker of markdownFormattingMarkersInMath(state, match)) {
        ranges.push(
          Decoration.widget({
            widget: new LiteralMarkerWidget(marker.text),
            side: -1
          }).range(marker.to)
        );
      }
      continue;
    }

    const startLine = state.doc.lineAt(match.from);
    const endLine = state.doc.lineAt(match.to);
    const crossesLines = startLine.number !== endLine.number;
    const isWholeLineBlock =
      match.display && match.from === startLine.from && match.to === endLine.to;

    if (crossesLines && !isWholeLineBlock) continue;

    ranges.push(
      Decoration.replace({
        widget: new MathWidget(
          match.source,
          match.display,
          isWholeLineBlock,
          match.from + 2
        ),
        block: isWholeLineBlock
      }).range(match.from, match.to)
    );
  }
  return Decoration.set(ranges, true);
}

const livePreviewExtension = StateField.define<DecorationSet>({
  create: buildLivePreviewDecorations,
  update(decorations, transaction) {
    const livePreviewChanged =
      transaction.startState.field(editorLivePreviewField, false) !==
      transaction.state.field(editorLivePreviewField, false);
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
    if (transaction.docChanged || livePreviewChanged || selectionChanged) {
      return buildLivePreviewDecorations(transaction.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

/**
 * What other co-bundled modules can ask for.
 *
 * Reading View and Live Preview are covered by the two registrations above, but
 * the Logseq module renders several surfaces from markdown it owns ITSELF —
 * static blocks, embeds, flashcards, a code block's prefix, out-of-vault files.
 * Those call `MarkdownRenderer.render` into a plain container, where
 * `getSectionInfo` is unavailable (it needs the reading view's section map), so
 * the post processor cannot reach them. They convert the source instead.
 *
 * Publishing rather than importing keeps the dependency one-way and lets the
 * toggle in the host settings switch ALL surfaces off at once.
 */
const API_KEY = "latex-delimiter-renderer";

export interface LatexDelimiterApi {
  convertForObsidianRender: (markdown: string) => string;
}

export default class LatexDelimiterRenderer extends Plugin {
  async onload(): Promise<void> {
    await loadMathJax();

    this.registerMarkdownPostProcessor(renderReadingView);
    this.registerEditorExtension(livePreviewExtension);

    const api: LatexDelimiterApi = { convertForObsidianRender };
    (this.app as unknown as Record<string, unknown>)[API_KEY] = api;
    this.register(() => {
      delete (this.app as unknown as Record<string, unknown>)[API_KEY];
    });

    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.updateOptions();
    });
  }
}
