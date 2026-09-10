/**
 * Block reference graph: modal with a self-contained SVG force-directed
 * layout. Nodes = pages (missing ids as dashed), edges = ((block-id))
 * reference flows; node click opens the page. The layout is a tiny
 * spring-electrical simulation (repulsion + edge springs + centering).
 */

import { Modal } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { buildBlockGraph, type GraphModel, type GraphNode } from '../features/graphModel';

interface LaidNode {
  node: GraphNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const W = 760;
const H = 520;
const ITERATIONS = 350;

export class BlockGraphModal extends Modal {
  private nodes: LaidNode[] = [];
  private svg: SVGSVGElement | null = null;

  constructor(private plugin: LogseqEditorPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText('Block reference graph');
    this.contentEl.empty();
    const idx = this.plugin.blockIndex;
    if (!idx) {
      this.contentEl.createEl('p', { text: 'Block index unavailable.' });
      return;
    }
    const model = buildBlockGraph(idx.allBlocks());
    if (model.nodes.length === 0) {
      this.contentEl.createEl('p', {
        cls: 'block-graph-empty',
        text: 'No block references ((id)) found in this vault yet.',
      });
      return;
    }
    this.renderGraph(model);
  }

  private renderGraph(model: GraphModel): void {
    const wrap = this.contentEl.createEl('div', { cls: 'block-graph-wrap' });
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.setAttribute('width', '100%');
    wrap.appendChild(this.svg);

    const currentPath = this.app.workspace.getActiveFile()?.path ?? '';
    this.nodes = model.nodes.map((node, i) => {
      const angle = (i / model.nodes.length) * Math.PI * 2;
      return {
        node,
        x: W / 2 + Math.cos(angle) * (140 + ((i * 37) % 120)),
        y: H / 2 + Math.sin(angle) * (110 + ((i * 53) % 90)),
        vx: 0,
        vy: 0,
      };
    });
    this.layout(model);

    const gEdges = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const gNodes = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.svg.append(gEdges, gNodes);

    const byId = new Map(this.nodes.map((n) => [n.node.id, n]));
    for (const e of model.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(a.x));
      line.setAttribute('y1', String(a.y));
      line.setAttribute('x2', String(b.x));
      line.setAttribute('y2', String(b.y));
      line.setAttribute('class', 'bg-edge' + (e.count > 1 ? ' bg-edge-strong' : ''));
      gEdges.appendChild(line);
    }
    for (const n of this.nodes) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'bg-node');
      if (n.node.id === currentPath) g.classList.add('bg-node-current');
      if (n.node.missing) g.classList.add('bg-node-missing');
      g.setAttribute('transform', `translate(${n.x},${n.y})`);
      g.setAttribute('cursor', n.node.missing ? 'default' : 'pointer');
      const r = 5 + Math.min(7, n.node.weight);
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('r', String(r));
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(r + 4));
      label.setAttribute('y', '4');
      label.setText(n.node.label);
      g.append(circle, label);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.setText(n.node.id + (n.node.missing ? ' (missing)' : ` · ${n.node.weight} refs`));
      g.appendChild(title);
      if (!n.node.missing) {
        g.addEventListener('click', () => {
          this.close();
          void this.app.workspace.openLinkText(n.node.id, '', false);
        });
      }
      gNodes.appendChild(g);
    }

    const legend = wrap.createEl('div', { cls: 'block-graph-legend' });
    legend.createSpan({ text: '● pages with block references · ' });
    legend.createSpan({ text: '◯ missing ids', cls: 'bg-legend-missing' });
  }

  /** Spring-electrical layout: repulsion, edge attraction, center gravity. */
  private layout(model: GraphModel): void {
    const idx = new Map(this.nodes.map((n) => [n.node.id, n]));
    const links: [LaidNode, LaidNode][] = [];
    for (const e of model.edges) {
      const a = idx.get(e.from);
      const b = idx.get(e.to);
      if (a && b) links.push([a, b]);
    }
    const repulse = 26000;
    const spring = 0.012;
    const springLen = 130;
    const gravity = 0.03;
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const damp = 1 - iter / ITERATIONS; // cool down
      for (let i = 0; i < this.nodes.length; i++) {
        const a = this.nodes[i];
        for (let j = i + 1; j < this.nodes.length; j++) {
          const b = this.nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            dx = (i % 2 ? 1 : -1) * 0.5;
            dy = (j % 2 ? 1 : -1) * 0.5;
            d2 = 1;
          }
          const d = Math.sqrt(d2);
          const f = (repulse / d2) * damp;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }
      for (const [a, b] of links) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = (d - springLen) * spring * damp;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
      for (const n of this.nodes) {
        n.vx += (W / 2 - n.x) * gravity * damp;
        n.vy += (H / 2 - n.y) * gravity * damp;
        n.vx *= 0.55;
        n.vy *= 0.55;
        n.x = Math.max(30, Math.min(W - 30, n.x + n.vx));
        n.y = Math.max(24, Math.min(H - 24, n.y + n.vy));
      }
    }
  }
}
