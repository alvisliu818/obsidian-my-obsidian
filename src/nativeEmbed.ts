/**
 * Native-editor embed: in the NATIVE markdown editor, a fenced code block
 * with the `logseq` language renders the block-editor outline in place
 * (the Dataview/mermaid pattern). Everything outside the fence stays fully
 * native; clicking the rendered embed moves the cursor into the fence so the
 * raw source can be edited with the native editor's own features, and the
 * embed re-renders once the cursor leaves.
 *
 * Mounted via `registerEditorExtension`, so it only ever runs in Obsidian's
 * native editors — the outline editor itself is unaffected.
 */
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { EditorState, RangeSetBuilder, StateField, type Extension } from '@codemirror/state';
import { MarkdownRenderer, editorInfoField } from 'obsidian';
import type { SyntaxNode } from '@lezer/common';
import type { Plugin } from 'obsidian';

type LogseqEditorPlugin = Plugin;

class NativeEmbedWidget extends WidgetType {
  constructor(
    readonly content: string,
    readonly plugin: LogseqEditorPlugin,
    readonly path: string,
  ) {
    super();
  }
  eq(o: WidgetType): boolean {
    return o instanceof NativeEmbedWidget && o.content === this.content && o.path === this.path;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'lgp-native-embed';
    // Deferred: a synchronous failure inside the renderer must never break
    // the host editor's DOM build (a throwing toDOM kills the view).
    queueMicrotask(() => {
      try {
        MarkdownRenderer.render(this.plugin.app, this.content, el, this.path, this.plugin).catch(() => {
          el.textContent = this.content;
        });
      } catch (e) {
        el.textContent = this.content;
        console.error('[lgp-native-embed] render failed:', e);
      }
    });
    return el;
  }
  // Clicks pass through to CM: the cursor maps into the fence range, the
  // widget yields to the raw source (selection-intersect below), and the
  // native editor handles the rest.
  ignoreEvent(): boolean {
    return false;
  }
}

/** True when the selection reaches into [from, to] (inclusive ends). */
function touchedBy(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

/** A ```logseq fence-begin line (HyperMD tree in the native editor). */
function isLogseqFenceBegin(state: EditorState, n: SyntaxNode): boolean {
  if (!/HyperMD-codeblock-begin/.test(n.name)) return false;
  return /^ {0,3}(={3,}|-{3,}|`{3,}|~{3,})[ \t]*logseq[ \t]*$/.test(state.doc.lineAt(n.from).text);
}

/** Position after the closing fence line (doc end when unterminated). */
function endOfFence(state: EditorState, begin: SyntaxNode): number {
  let m: SyntaxNode | null = begin;
  while (m.nextSibling) {
    m = m.nextSibling;
    if (/HyperMD-codeblock-end/.test(m.name)) return m.to;
    if (!/hmd-codeblock|HyperMD-codeblock/.test(m.name)) break;
  }
  return state.doc.length;
}

/**
 * Decorations come from a StateField (not a ViewPlugin): the fence widget
 * replaces line breaks, which CM6 only allows for field-provided sets
 * ("Decorations that replace line breaks may not be specified via plugins").
 */
function buildEmbedDecos(state: EditorState, plugin: LogseqEditorPlugin): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const thisPath =
    (state.field(editorInfoField) as { file?: { path?: string } } | null)?.file?.path ?? '';
  const top = syntaxTree(state).topNode;
  let n: SyntaxNode | null = top.firstChild;
  while (n) {
    const next: SyntaxNode | null = n.nextSibling;
    if (isLogseqFenceBegin(state, n)) {
      const endTo = endOfFence(state, n);
      if (!touchedBy(state, n.from, endTo)) {
        const beginLine = state.doc.lineAt(n.from);
        const endLine = state.doc.lineAt(endTo);
        const content =
          beginLine.number === endLine.number ? '' : state.sliceDoc(beginLine.to + 1, endLine.from);
        builder.add(
          n.from,
          endTo,
          Decoration.replace({ widget: new NativeEmbedWidget(content, plugin, thisPath), block: true }),
        );
        let m: SyntaxNode | null = n;
        while (m.nextSibling && /hmd-codeblock|HyperMD-codeblock/.test(m.nextSibling.name)) {
          m = m.nextSibling;
          if (/HyperMD-codeblock-end/.test(m.name)) break;
        }
        n = m ? m.nextSibling : null;
        continue;
      }
    }
    n = next;
  }
  return builder.finish();
}

export function nativeEmbedExtension(plugin: LogseqEditorPlugin): Extension {
  const field = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (_v, tr) => {
      try {
        return buildEmbedDecos(tr.state, plugin);
      } catch (e) {
        console.error('[lgp-native-embed] decorate failed:', e);
        return Decoration.none;
      }
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return field;
}