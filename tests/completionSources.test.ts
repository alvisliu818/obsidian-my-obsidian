/**
 * Completion source behavior for [[wiki links]], #tags, ((block refs)) and
 * /slash commands (embed editor).
 *
 * The critical invariant under test: each source returns `from` AFTER its
 * trigger characters ([[ / ![[ / # / (( / /). CM6 filters the returned
 * options against the text between `from` and the cursor, so a `from` that
 * includes the trigger would filter every option away and no popup would
 * ever appear (the v0.2.2–v0.2.4 regression).
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext, type Completion, type CompletionResult } from '@codemirror/autocomplete';
import { blockRefSource, tagSource, wikiLinkSource } from '../src/features/links';
import { slashMenuSource } from '../src/features/slashMenu';
import type { BlockEditorView } from '../src/view/BlockEditorView';
import type { CompletionSource } from '@codemirror/autocomplete';

function ctxFor(doc: string, pos = doc.length): CompletionContext {
  return new CompletionContext(EditorState.create({ doc }), pos, false);
}

interface MockFile {
  basename: string;
  path: string;
}
const mdFile = (path: string): MockFile => ({
  basename: path.replace(/\.md$/, '').split('/').pop()!,
  path,
});

const mockHost = {
  app: {
    vault: {
      getMarkdownFiles: (): MockFile[] => [mdFile('Alpha.md'), mdFile('Notes/Deep Page.md')],
    },
  },
  plugin: {
    blockIndex: {
      allTags: () => ['todo', 'project/x'],
      withIds: () => [{ text: 'some block text', blockId: 'uuid-1234', path: 'Alpha.md' }],
    },
  },
} as unknown as BlockEditorView;

/** CompletionSource may be async by type; all four sources here are sync. */
const sync = (s: CompletionSource) => (ctx: CompletionContext) => s(ctx) as CompletionResult | null;
const wiki = sync(wikiLinkSource(mockHost));
const tag = sync(tagSource(mockHost));
const blockRef = sync(blockRefSource(mockHost));
const slash = sync(slashMenuSource(mockHost, false));
const slashEmbed = sync(slashMenuSource(mockHost, true));

interface CapturedDispatch {
  changes?: { from: number; to?: number; insert?: string };
}
const applyOf = (c: Completion) => c.apply as (v: unknown, comp: Completion, from: number, to: number) => void;
const fakeView = (captured: CapturedDispatch[]) =>
  ({ dispatch: (spec: CapturedDispatch) => captured.push(spec) });

describe('wikiLinkSource', () => {
  it('returns from AFTER the [[ trigger (not at its start)', () => {
    const res = wiki(ctxFor('[[al'));
    expect(res).not.toBeNull();
    expect(res!.from).toBe(2);
  });

  it('filters pages by the typed fragment', () => {
    const res = wiki(ctxFor('[[al'));
    expect(res!.options.map((o) => o.label)).toEqual(['Alpha']);
  });

  it('lists all pages on an empty query', () => {
    const res = wiki(ctxFor('[['));
    expect(res!.options.map((o) => o.label).sort()).toEqual(['Alpha', 'Deep Page']);
  });

  it('apply keeps the typed [[ and closes the link', () => {
    const captured: CapturedDispatch[] = [];
    const res = wiki(ctxFor('[[al'))!;
    applyOf(res!.options[0])(fakeView(captured), res!.options[0], res!.from, 4);
    expect(captured[0].changes).toEqual({ from: 2, to: 4, insert: 'Alpha]] ' });
  });

  it('supports the ![[ page-embed trigger with from after ![[', () => {
    const res = wiki(ctxFor('![[Dee'));
    expect(res).not.toBeNull();
    expect(res!.from).toBe(3);
    const captured: CapturedDispatch[] = [];
    applyOf(res!.options[0])(fakeView(captured), res!.options[0], res!.from, 6);
    expect(captured[0].changes).toEqual({ from: 3, to: 6, insert: 'Deep Page]] ' });
  });

  it('returns null without a [[ trigger', () => {
    expect(wiki(ctxFor('hello'))).toBeNull();
    expect(wiki(ctxFor('[x'))).toBeNull();
    expect(wiki(ctxFor('[[a]b'))).toBeNull();
  });

  it('validFor matches name fragments only (no brackets)', () => {
    const res = wiki(ctxFor('[[al'))!;
    const validFor = res!.validFor as RegExp;
    expect(validFor.test('al')).toBe(true);
    expect(validFor.test('a[')).toBe(false);
    expect(validFor.test('Page|alias')).toBe(false);
  });
});

describe('tagSource', () => {
  it('returns from AFTER the # trigger and filters tags', () => {
    const res = tag(ctxFor('#to'));
    expect(res).not.toBeNull();
    expect(res!.from).toBe(1);
    expect(res!.options.map((o) => o.displayLabel)).toEqual(['#todo']);
  });

  it('filters by tag path segments (#proj completes project/x)', () => {
    const res = tag(ctxFor('#proj'));
    expect(res!.options.map((o) => o.displayLabel)).toEqual(['#project/x']);
  });

  it('apply keeps the typed # and appends a space', () => {
    const captured: CapturedDispatch[] = [];
    const res = tag(ctxFor('#to'))!;
    applyOf(res!.options[0])(fakeView(captured), res!.options[0], res!.from, 3);
    expect(captured[0].changes).toEqual({ from: 1, to: 3, insert: 'todo ' });
  });

  it('label (filter target) drops the #; displayLabel keeps it', () => {
    const res = tag(ctxFor('#to'))!;
    expect(res!.options[0].label).toBe('todo');
    expect(res!.options[0].displayLabel).toBe('#todo');
  });

  it('returns null without a # trigger', () => {
    expect(tag(ctxFor('todo'))).toBeNull();
  });
});

describe('blockRefSource', () => {
  it('returns from AFTER the (( trigger', () => {
    const res = blockRef(ctxFor('((som'));
    expect(res).not.toBeNull();
    expect(res!.from).toBe(2);
  });

  it('apply closes the plain block ref with ))', () => {
    const captured: CapturedDispatch[] = [];
    const res = blockRef(ctxFor('((som'))!;
    applyOf(res!.options[0])(fakeView(captured), res!.options[0], res!.from, 5);
    expect(captured[0].changes).toEqual({ from: 2, to: 5, insert: 'uuid-1234))' });
  });

  it('{{embed (( closes with }} instead of ))', () => {
    const captured: CapturedDispatch[] = [];
    const res = blockRef(ctxFor('{{embed ((som'))!;
    expect(res!.from).toBe(10);
    applyOf(res!.options[0])(fakeView(captured), res!.options[0], res!.from, 13);
    expect(captured[0].changes).toEqual({ from: 10, to: 13, insert: 'uuid-1234))}}' });
  });

  it('filters by block text (CM6 fuzzy-filters the label)', () => {
    const res = blockRef(ctxFor(('((som'))!);
    expect(res!.options.length).toBe(1);
    const none = blockRef(ctxFor('((zzz'));
    expect(none).toBeNull();
  });

  it('returns null without a (( trigger', () => {
    expect(blockRef(ctxFor('(x'))).toBeNull();
    expect(blockRef(ctxFor('text'))).toBeNull();
  });
});

describe('slashMenuSource', () => {
  it('returns from AFTER the / trigger', () => {
    const res = slash(ctxFor('/tod'));
    expect(res).not.toBeNull();
    expect(res!.from).toBe(1);
    expect(res!.options.map((o) => o.label)).toContain('TODO');
  });

  it('apply shifts the range back over the / so run() replaces /query', () => {
    const captured: CapturedDispatch[] = [];
    const res = slash(ctxFor('/hea'))!;
    const heading = res!.options.find((o) => o.label === 'Heading 1')!;
    applyOf(heading)(fakeView(captured), heading, res!.from, 4);
    expect(captured[0].changes).toEqual({ from: 0, to: 4, insert: '# ' });
  });

  it('embed editor filters out block-model commands', () => {
    const res = slashEmbed(ctxFor('/'));
    expect(res!.options.some((o) => o.label === 'TODO')).toBe(false);
    expect(res!.options.some((o) => o.label === 'Heading 1')).toBe(true);
  });
});
