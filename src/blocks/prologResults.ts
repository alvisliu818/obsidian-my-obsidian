/**
 * DOM for ```prolog query results: the container that hangs under a fenced
 * block and re-renders whenever the block or the block index changes.
 */

import { setIcon } from 'obsidian';
import type { BlockEditorView } from '../view/BlockEditorView';
import type { Block } from '../types';
import { type Term } from '../features/prolog';
import { prologFacts } from '../features/prologFacts';
import { prologSourceOf, runPrologBlock } from '../features/prologQuery';

const RESULTS_CLASS = 'block-prolog-results';
const ERROR_CLASS = 'prolog-error';

interface CacheEntry {
  sig: string;
  version: number;
  el: HTMLElement;
}
const cache = new WeakMap<Block, CacheEntry>();

/** A raw block whose body is a ```prolog fence, and not being edited. */
export function isPrologBlock(b: Block, host: BlockEditorView): boolean {
  if (host.focusedBlock === b) return false;
  return prologSourceOf(b.text) !== null;
}

/** Add / remove / refresh the results container of a prolog block. */
export function syncPrologContainer(
  wrap: HTMLElement,
  b: Block,
  host: BlockEditorView,
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

function renderPrologResults(b: Block, host: BlockEditorView): HTMLElement {
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

  const { program } = prologFacts(idx, version);
  const model = runPrologBlock(program, b.text);

  if (model.error) {
    const row = el.createEl('div', { cls: ERROR_CLASS });
    const icon = row.createEl('span', { cls: 'prolog-error-icon' });
    setIcon(icon, 'alert-triangle');
    row.createEl('span', { text: model.error });
    cache.set(b, { sig, version, el });
    return el;
  }

  // --- header: how many, and how expensive ---
  const head = el.createEl('div', { cls: 'prolog-head' });
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
    el.createEl('div', { cls: 'prolog-empty', text: 'No results' });
    cache.set(b, { sig, version, el });
    return el;
  }

  const table = el.createEl('table', { cls: 'prolog-table' });
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
    el.createEl('div', { cls: 'prolog-more', text: `… showing the first ${model.rows.length}` });
  }

  cache.set(b, { sig, version, el });
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
