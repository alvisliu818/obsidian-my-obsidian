import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { handleBacktick, handleWrapChar } from '../src/interactions/keymap';
import type { BlockEditorView } from '../src/view/BlockEditorView';

/** Minimal stand-in: handleWrapChar only touches state.selection/doc + dispatch. */
function makeView(docText: string, anchor: number, head: number) {
  const state = EditorState.create({
    doc: docText,
    selection: EditorSelection.single(anchor, head),
  });
  let spec: unknown = null;
  const view = {
    state,
    dispatch: (s: unknown) => {
      spec = s;
    },
  };
  const host = { focusedBlock: { kind: 'list', text: docText } };
  return {
    view: view as unknown as Parameters<typeof handleBacktick>[0],
    host: host as unknown as BlockEditorView,
    spec: () => spec as { changes: { from: number; to: number; insert: string }; selection: { anchor: number; head: number } } | null,
  };
}

describe('handleBacktick: selection wraps in inline code', () => {
  it('wraps the selected text and keeps it selected', () => {
    // 因为(2) list1[0](8) → selection 2..10
    const { view, host, spec } = makeView('因为list1[0] 是不可变类型元素', 2, 10);
    expect(handleBacktick(view, host)).toBe(true);
    const s = spec()!;
    expect(s.changes.insert).toBe('`list1[0]`');
    expect(s.changes.from).toBe(2);
    expect(s.changes.to).toBe(10);
    expect(s.selection).toEqual({ anchor: 3, head: 11 });
  });

  it('falls through (plain insert) when the selection is empty', () => {
    const { view, host, spec } = makeView('abc', 1, 1);
    expect(handleBacktick(view, host)).toBe(false);
    expect(spec()).toBeNull();
  });
});

describe('handleWrapChar: other markdown/bracket pairs', () => {
  it('wraps with * (repeat chains to bold since the selection is kept)', () => {
    const { view, host, spec } = makeView('因为list1[0] 是不可变类型元素', 2, 10);
    expect(handleWrapChar(view, host, '*', '*')).toBe(true);
    expect(spec()!.changes.insert).toBe('*list1[0]*');
    expect(spec()!.selection).toEqual({ anchor: 3, head: 11 });
  });

  it('wraps with [ → ] (bracket pair, repeat chains to wikilink)', () => {
    const { view, host, spec } = makeView('some text', 5, 9);
    expect(handleWrapChar(view, host, '[', ']')).toBe(true);
    expect(spec()!.changes.insert).toBe('[text]');
    expect(spec()!.selection).toEqual({ anchor: 6, head: 10 });
  });

  it('empty selection falls through for every pair', () => {
    const { view, host, spec } = makeView('abc', 1, 1);
    expect(handleWrapChar(view, host, '*', '*')).toBe(false);
    expect(spec()).toBeNull();
  });
});
