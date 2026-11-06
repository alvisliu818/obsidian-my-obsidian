/**
 * Block-reference graph model (pure, unit-testable).
 * Scans block texts for ((block-id)) references and aggregates them into a
 * page-level graph: nodes = pages containing references or referenced blocks,
 * edges = page → page reference flows, plus dangling references as "missing".
 */

export interface GraphInputBlock {
  text: string;
  path: string;
  blockId: string;
}

export interface GraphNode {
  id: string; // page path
  label: string; // basename
  /** Number of references originating from or landing in this page. */
  weight: number;
  missing?: boolean;
}

export interface GraphEdge {
  from: string; // page path
  to: string; // page path (…/missing:<id> for dangling refs)
  count: number;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const REF_RE = /\(\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)\)/g;

export const missingId = (id: string): string => `missing:${id}`;

/** Build the page-level reference graph from indexed blocks. */
export function buildBlockGraph(blocks: GraphInputBlock[]): GraphModel {
  const byId = new Map<string, GraphInputBlock>();
  for (const b of blocks) {
    if (b.blockId) byId.set(b.blockId, b);
  }

  const nodeWeight = new Map<string, number>();
  const edgeCount = new Map<string, number>();
  const bumpNode = (path: string, by = 1): void => {
    nodeWeight.set(path, (nodeWeight.get(path) ?? 0) + by);
  };
  const bumpEdge = (from: string, to: string): void => {
    const k = `${from}\u0000${to}`;
    edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
  };

  for (const b of blocks) {
    REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REF_RE.exec(b.text)) !== null) {
      const target = byId.get(m[1]);
      if (target) {
        if (target.path === b.path) continue; // same-page refs stay off the page graph
        bumpNode(b.path);
        bumpNode(target.path);
        bumpEdge(b.path, target.path);
      } else {
        const miss = missingId(m[1]);
        bumpNode(b.path);
        bumpNode(miss, 0); // ensure the missing node exists
        bumpEdge(b.path, miss);
      }
    }
  }

  const nodes: GraphNode[] = [...nodeWeight.entries()].map(([path, weight]) => {
    if (path.startsWith('missing:')) {
      return { id: path, label: path.slice(8, 18) + '…', weight: 1, missing: true };
    }
    const label = path.split('/').pop() ?? path;
    return { id: path, label: label.replace(/\.md$/, ''), weight: Math.max(1, weight) };
  });
  const edges: GraphEdge[] = [...edgeCount.entries()].map(([k, count]) => {
    const [from, to] = k.split('\u0000');
    return { from, to, count };
  });
  return { nodes, edges };
}
