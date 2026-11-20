/**
 * DOM for ```prolog query results: the container that hangs under a fenced
 * block and re-renders whenever the block or the block index changes.
 */

import { setIcon } from 'obsidian';
import type { BlockRenderHost } from '../blocks/renderHost';
import type { Block } from '../types';
import { type Term } from '../features/prolog';
import { prologFacts } from '../features/prologFacts';
import { prologSourceOf, runPrologBlock } from '../features/prologQuery';
import { deferQueryRender } from './queryBudget';

const RESULTS_CLASS = 'block-prolog-results';
const ERROR_CLASS = 'prolog-error';

interface CacheEntry {
  sig: string;
  version: number;
  el: HTMLElement;
}
const cache = new WeakMap<Block, CacheEntry>();

/** A raw block whose body is a ```prolog fence, and not being edited. */
export function isPrologBlock(b: Block, host: BlockRenderHost): boolean {
  if (host.focusedBlock === b) return false;
  return prologSourceOf(b.text) !== null;
}

/** Add / remove / refresh the results container of a prolog block. */
export function syncPrologContainer(
  wrap: HTMLElement,
  b: Block,
  host: BlockRenderHost,
): void {
  const active = isPrologBlock(b, host);
  wrap.classList.toggle('block-has-prolog', active);
  const old = wrap.querySelector(`:scope > .${RESULTS_CLASS}`);
  if (!active) {
    old?.remove();
    return;
  }
  const el = renderPrologResults(b, host);
  if (old) old.replaceWith(el);
  else wrap.appendChild(el);
}

function renderPrologResults(b: Block, host: BlockRenderHost): HTMLElement {
  // 门面 allBlocks = 内核 withIds 全量 id 块集(2026-11-21)——fact 构建完整,
  // 无需部分数据降级。
  const idx = host.plugin.blockIndex;
  const version = idx?.version ?? 0;
  const sig = b.text;
  const hit = cache.get(b);
  if (hit && hit.sig === sig && hit.version === version) return hit.el;

  const el = document.createElement('div');
  el.className = RESULTS_CLASS;

  if (!idx) {
    el.createEl('div', { cls: ERROR_CLASS, text: 'Block index unavailable' });
    cache.set(b, { sig, version, el });
    return el;
  }

  // 查询体异步执行(og 查询阈值,queryBudget.deferQueryRender):占位立即
  // 返回进渲染帧,重查询不再把渲染帧按住几百毫秒。
  el.createEl('div', { cls: 'prolog-empty', text: '查询执行中…' });
  cache.set(b, { sig, version, el });
  deferQueryRender(host, el, () => {
    const filled = document.createElement('div');
    filled.className = RESULTS_CLASS;
    const { program } = prologFacts(idx, version);
    const model = runPrologBlock(program, b.text);

    if (model.error) {
      const row = filled.createEl('div', { cls: ERROR_CLASS });
      const icon = row.createEl('span', { cls: 'prolog-error-icon' });
      setIcon(icon, 'alert-triangle');
      row.createEl('span', { text: model.error });
      return filled;
    }

    // --- header: how many, and how expensive ---
    const head = filled.createEl('div', { cls: 'prolog-head' });
    if (model.propositional) {
      head.createEl('span', {
        cls: 'prolog-count',
        text: model.rows.length > 0 ? 'Yes' : 'No',
      });
    } else {
      const total = model.truncated ? `${model.rows.length}+` : String(model.rows.length);
      head.createEl('span', { cls: 'prolog-count', text: `${total} ${model.rows.length === 1 ? 'result' : 'results'}` });
    }
    head.createEl('span', {
      cls: 'prolog-meta',
      text: `${model.steps} steps · ${model.ms} ms`,
    });

    if (model.rows.length === 0) {
      filled.createEl('div', { cls: 'prolog-empty', text: 'No results' });
      return filled;
    }

    const table = filled.createEl('table', { cls: 'prolog-table' });
    const headRow = table.createEl('thead').createEl('tr');
    for (const v of model.vars) headRow.createEl('th', { text: v });
    const tbody = table.createEl('tbody');
    for (const row of model.rows) {
      const tr = tbody.createEl('tr');
      row.cells.forEach((cell, i) => {
        const td = tr.createEl('td', { text: cell || '—' });
        const id = blockIdOf(row.terms[i], idx);
        if (id) {
          td.classList.add('is-block-ref');
          td.addEventListener('click', (e) => {
            e.stopPropagation();
            void host.plugin.openBlockRef(id);
          });
        }
      });
    }
    if (model.truncated) {
      filled.createEl('div', { cls: 'prolog-more', text: `… showing the first ${model.rows.length}` });
    }
    return filled;
  }, (filled) => cache.set(b, { sig, version, el: filled }));
  return el;
}

/** True when the value names a block that exists — then the cell is clickable. */
function blockIdOf(t: Term, idx: { get(id: string): unknown }): string | null {
  if (t.k !== 'atom') return null;
  const id = t.name;
  if (!UUID_RE.test(id)) return null;
  return idx.get(id) ? id : null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
