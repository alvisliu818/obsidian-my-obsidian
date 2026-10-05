/**
 * Block views end-to-end over REAL markdown: the `view::` property and the
 * children it renders must survive the project's actual parse → model → view
 * pipeline, and round-trip back to the same file (a view is a RENDERING of
 * ordinary indented markdown, never a storage change).
 */

import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';
import { blockId, type Block } from '../src/types';
import { linkParents } from '../src/core/treeOps';
import { buildBlockView, type ViewChild } from '../src/features/blockViews';

function parse(md: string): Block[] {
  const roots = parseDocument(md).blocks;
  linkParents(roots);
  return roots;
}

const toChild = (b: Block): ViewChild => ({
  text: b.text.split('\n')[0]?.trim() ?? '',
  marker: b.marker,
  props: b.props,
  hasChildren: b.children.length > 0,
});

/** The view model a real parsed parent block produces. */
function modelFor(md: string) {
  const parent = parse(md)[0];
  return buildBlockView(parent.props, parent.children.map(toChild));
}

describe('block views over real markdown', () => {
  it('a parent with view:: table turns its children into rows', () => {
    const m = modelFor(
      ['- Books', '  view:: table', '  - Dune', '    author:: Herbert', '  - Solaris', '    author:: Lem', ''].join('\n'),
    )!;
    expect(m.kind).toBe('table');
    expect(m.columns).toEqual(['author']);
    expect(m.records.map((r) => r.title)).toEqual(['Dune', 'Solaris']);
    expect(m.records[0].values.author).toBe('Herbert');
  });

  it('the same source renders as cards or tabs by changing only the property', () => {
    const body = ['- Books', '  - Dune', '    author:: Herbert', ''];
    expect(modelFor(['- Books', '  view:: cards', ...body.slice(1)].join('\n'))!.kind).toBe('cards');
    expect(modelFor(['- Books', '  view:: tabs', ...body.slice(1)].join('\n'))!.kind).toBe('tabs');
  });

  it('a parent WITHOUT view:: produces no model — the list still renders', () => {
    expect(modelFor(['- Books', '  - Dune', '    author:: Herbert', ''].join('\n'))).toBeNull();
  });

  it('a nested child contributes ONE record, not an expansion', () => {
    const m = modelFor(
      ['- Books', '  view:: table', '  - Dune', '    - Part one', '    - Part two', ''].join('\n'),
    )!;
    expect(m.records).toHaveLength(1);
    expect(m.records[0].title).toBe('Dune');
    expect(m.records[0].child.hasChildren).toBe(true);
  });

  it('marker-only children are viewable (a TODO list as a table)', () => {
    const m = modelFor(
      ['- Tasks', '  view:: table', '  - TODO write docs', '  - DONE ship', ''].join('\n'),
    )!;
    expect(m.records.map((r) => r.child.marker)).toEqual(['TODO', 'DONE']);
  });

  it('view-columns picks a subset and its own order', () => {
    const m = modelFor(
      [
        '- Books',
        '  view:: table',
        '  view-columns:: year, author',
        '  - Dune',
        '    author:: Herbert',
        '    year:: 1965',
        '',
      ].join('\n'),
    )!;
    expect(m.columns).toEqual(['year', 'author']);
  });

  it('view:: is NOT rendered as a data column of its own', () => {
    const m = modelFor(
      ['- Books', '  view:: table', '  view-columns:: author', '  - Dune', '    author:: Herbert', ''].join('\n'),
    )!;
    expect(m.columns).toEqual(['author']);
  });

  it('an unknown view name degrades to a table instead of rendering nothing', () => {
    const m = modelFor(['- Books', '  view:: kanban', '  - Dune', ''].join('\n'))!;
    expect(m.kind).toBe('table');
  });

  it('ROUND-TRIP: a view is a rendering, so the file must serialize unchanged', () => {
    const md = ['- Books', '  view:: table', '  - Dune', '    author:: Herbert', '  - Solaris', '    author:: Lem', ''].join('\n');
    // The serializer is compact AND tab-indented (documented project behavior),
    // so the round-trip target is the normalized form, not the input verbatim.
    const T = '\t';
    const expected = ['- Books', `${T}view:: table`, `${T}- Dune`, `${T}${T}author:: Herbert`, `${T}- Solaris`, `${T}${T}author:: Lem`].join('\n');
    expect(serializeDocument(parseDocument(md))).toBe(expected);
    // Re-parsing that output yields the same model — the view survives a save.
    const again = parse(expected)[0];
    const m = buildBlockView(again.props, again.children.map(toChild))!;
    expect(m.kind).toBe('table');
    expect(m.records.map((r) => r.title)).toEqual(['Dune', 'Solaris']);
  });

  it('removing the view property returns the block to a plain list', () => {
    const plain = ['- Books', '  - Dune', '    author:: Herbert', ''].join('\n');
    expect(modelFor(plain)).toBeNull();
  });

  it('a view on the PAGE-props block is config, and page props have no children', () => {
    // Page props are the first block and never have children. `view::` there is
    // still recognized as config (not a data column), and with no children the
    // model is empty — which the renderer shows as an explicit empty state.
    const roots = parse(['view:: table', 'title:: Books', ''].join('\n'));
    expect(roots[0].props['view']).toBe('table');
    const m = buildBlockView(roots[0].props, roots[0].children.map(toChild))!;
    expect(m.kind).toBe('table');
    // Columns come from the CHILDREN, so a childless block has none — and
    // `view` itself never leaks in as one.
    expect(m.columns).toEqual([]);
    expect(m.records).toEqual([]);
  });

  it('block ids are unaffected by adding a view', () => {
    const withView = parse(['- Books', '  view:: table', '  - Dune', ''].join('\n'));
    expect(blockId(withView[0])).toBe('');
  });
});
