import { describe, expect, it } from 'vitest';
import { buildBlockGraph, missingId } from '../src/features/graphModel';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function blocks() {
  return [
    { text: `see ((${ID_B}))`, path: 'pages/source.md', blockId: ID_A },
    { text: 'target block', path: 'pages/target.md', blockId: ID_B },
    { text: `points nowhere ((33333333-3333-4333-8333-333333333333))`, path: 'pages/source.md', blockId: '' },
    { text: 'no refs here', path: 'pages/other.md', blockId: '' },
  ];
}

describe('buildBlockGraph', () => {
  it('aggregates cross-page references into page nodes and edges', () => {
    const g = buildBlockGraph(blocks());
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain('pages/source.md');
    expect(ids).toContain('pages/target.md');
    expect(ids).not.toContain('pages/other.md'); // untouched pages are left out

    const edge = g.edges.find((e) => e.from === 'pages/source.md' && e.to === 'pages/target.md');
    expect(edge?.count).toBe(1);
  });

  it('same-page references do not create edges', () => {
    const g = buildBlockGraph([
      { text: `self ((${ID_B}))`, path: 'a.md', blockId: ID_A },
      { text: 'b', path: 'a.md', blockId: ID_B },
    ]);
    expect(g.edges).toHaveLength(0);
    expect(g.nodes).toHaveLength(0);
  });

  it('dangling references become missing nodes', () => {
    const g = buildBlockGraph(blocks());
    const miss = g.nodes.find((n) => n.missing);
    expect(miss?.id).toBe(missingId('33333333-3333-4333-8333-333333333333'));
    const edge = g.edges.find((e) => e.to.startsWith('missing:'));
    expect(edge?.count).toBe(1);
  });

  it('multiple refs between the same pages merge into one edge', () => {
    const g = buildBlockGraph([
      { text: `one ((${ID_B}))`, path: 'a.md', blockId: ID_A },
      { text: `two ((${ID_B}))`, path: 'a2.md', blockId: '' },
      { text: 'b', path: 'b.md', blockId: ID_B },
    ]);
    expect(g.edges).toHaveLength(2); // a→b and a2→b
    const g2 = buildBlockGraph([
      { text: `one ((${ID_B})) two ((${ID_B}))`, path: 'a.md', blockId: ID_A },
      { text: 'b', path: 'b.md', blockId: ID_B },
    ]);
    expect(g2.edges[0].count).toBe(2); // both refs in one block merge
  });

  it('node weight counts references and labels are basenames', () => {
    const g = buildBlockGraph(blocks());
    const src = g.nodes.find((n) => n.id === 'pages/source.md');
    expect(src?.label).toBe('source');
    expect(src?.weight).toBe(2); // 1 real ref + 1 dangling
  });

  it('empty vault yields an empty graph', () => {
    expect(buildBlockGraph([])).toEqual({ nodes: [], edges: [] });
  });
});
