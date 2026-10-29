/**
 * In-page search bar (Ctrl+F / Ctrl+H): browser-style find over the rendered
 * block tree — highlights matches in static content, jumps between them,
 * and supports replace-all (case-insensitive) across the whole document.
 *
 * DOM-first approach: matches are found on rendered text nodes (skipping
 * embeds / query results / the focused CM6 editor), so what you search is
 * exactly what you see.
 */

import { debounce } from 'obsidian';
import type { BlockEditorView } from '../view/BlockEditorView';

const SKIP_INSIDE = '.block-embed, .block-query-results, .cm-editor';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class PageSearchBar {
  private rootEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private replaceEl: HTMLInputElement;
  private countEl: HTMLElement;
  private replaceRowEl: HTMLElement;
  /** Highlight marks in document order (one per match). */
  private marks: HTMLElement[] = [];
  private current = -1;
  private applyDebounced: () => void;

  constructor(private host: BlockEditorView, parent: HTMLElement) {
    this.applyDebounced = debounce(() => this.apply(), 120, false);

    this.rootEl = parent.createEl('div', { cls: 'block-editor-searchbar' });
    this.rootEl.style.display = 'none';

    const row1 = this.rootEl.createEl('div', { cls: 'sb-row' });
    this.inputEl = row1.createEl('input', { cls: 'sb-input', type: 'text', attr: { placeholder: 'Find…' } });
    this.countEl = row1.createEl('span', { cls: 'sb-count' });
    const prev = row1.createEl('div', { cls: 'sb-btn', text: '↑', attr: { 'aria-label': 'Previous match' } });
    const next = row1.createEl('div', { cls: 'sb-btn', text: '↓', attr: { 'aria-label': 'Next match' } });
    const toggle = row1.createEl('div', { cls: 'sb-btn', text: '⇄', attr: { 'aria-label': 'Toggle replace' } });
    const close = row1.createEl('div', { cls: 'sb-btn', text: '×', attr: { 'aria-label': 'Close search' } });

    this.replaceRowEl = this.rootEl.createEl('div', { cls: 'sb-row' });
    this.replaceRowEl.style.display = 'none';
    this.replaceEl = this.replaceRowEl.createEl('input', {
      cls: 'sb-input',
      type: 'text',
      attr: { placeholder: 'Replace with…' },
    });
    const ra = this.replaceRowEl.createEl('button', { cls: 'sb-replace-all', text: 'Replace all' });

    this.inputEl.addEventListener('input', () => this.applyDebounced());
    this.inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.step(ev.shiftKey ? -1 : 1);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.close();
      }
    });
    this.replaceEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        this.close();
      }
    });
    prev.addEventListener('click', () => this.step(-1));
    next.addEventListener('click', () => this.step(1));
    close.addEventListener('click', () => this.close());
    toggle.addEventListener('click', () => {
      const hidden = this.replaceRowEl.style.display === 'none';
      this.replaceRowEl.style.display = hidden ? '' : 'none';
      if (hidden) this.replaceEl.focus();
    });
    ra.addEventListener('click', () => this.replaceAll());
  }

  // ------------------------------------------------------------------
  // Public API (view calls these)
  // ------------------------------------------------------------------

  open(withReplace = false): void {
    this.rootEl.style.display = '';
    this.replaceRowEl.style.display = withReplace ? '' : 'none';
    this.inputEl.focus();
    this.inputEl.select();
    this.apply();
  }

  close(): void {
    this.rootEl.style.display = 'none';
    this.clearHighlights();
    this.countEl.setText('');
  }

  /** Re-run after the view re-rendered (marks were wiped with the DOM). */
  onRerender(): void {
    if (this.rootEl.style.display === 'none') return;
    this.apply(true);
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private apply(keepIndex = false): void {
    this.clearHighlights();
    const q = this.inputEl.value.trim();
    if (!q) {
      this.marks = [];
      this.current = -1;
      this.countEl.setText('');
      return;
    }
    this.marks = this.highlightAll(q);
    const prev = this.current;
    this.current = this.marks.length > 0 ? (keepIndex ? Math.min(prev < 0 ? 0 : prev, this.marks.length - 1) : 0) : -1;
    this.updateCurrent();
  }

  private step(dir: -1 | 1): void {
    if (this.marks.length === 0) return;
    this.current = (this.current + dir + this.marks.length) % this.marks.length;
    this.updateCurrent();
  }

  private updateCurrent(): void {
    this.marks.forEach((m, i) => m.classList.toggle('is-current', i === this.current));
    if (this.current >= 0 && this.marks[this.current]) {
      this.marks[this.current].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    this.countEl.setText(
      this.marks.length === 0 ? '' : `${this.current + 1}/${this.marks.length}`,
    );
  }

  /** Wrap every case-insensitive match in rendered static content with <mark>. */
  private highlightAll(q: string): HTMLElement[] {
    const tree = this.host.contentTreeEl;
    if (!tree) return [];
    const ql = q.toLowerCase();
    const marks: HTMLElement[] = [];
    const statics = Array.from(tree.querySelectorAll('.block-content-static')).filter(
      (el) => !(el.parentElement?.closest('.cm-editor')), // focused block has no static, safety net
    );
    for (const holder of statics) {
      const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.parentElement?.closest(SKIP_INSIDE)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });
      const nodes: Text[] = [];
      let cur = walker.nextNode() as Text | null;
      while (cur) {
        nodes.push(cur);
        cur = walker.nextNode() as Text | null;
      }
      for (const node of nodes) {
        const data = node.data;
        const dl = data.toLowerCase();
        let idx = dl.indexOf(ql);
        if (idx === -1) continue;
        const frag = document.createDocumentFragment();
        let last = 0;
        while (idx !== -1) {
          if (idx > last) frag.appendChild(document.createTextNode(data.slice(last, idx)));
          const mark = document.createElement('mark');
          mark.className = 'search-hit';
          mark.textContent = data.slice(idx, idx + ql.length);
          frag.appendChild(mark);
          marks.push(mark);
          last = idx + ql.length;
          idx = dl.indexOf(ql, last);
        }
        if (last < data.length) frag.appendChild(document.createTextNode(data.slice(last)));
        node.replaceWith(frag);
      }
    }
    return marks;
  }

  private clearHighlights(): void {
    const tree = this.host.contentTreeEl;
    if (!tree) return;
    for (const mark of Array.from(tree.querySelectorAll('mark.search-hit'))) {
      const parent = mark.parentElement;
      if (!parent) continue;
      mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
      parent.normalize();
    }
    this.marks = [];
    this.current = -1;
  }

  /** Replace-all across every block's text (case-insensitive literal). */
  private replaceAll(): void {
    const q = this.inputEl.value;
    const r = this.replaceEl.value;
    if (!q) return;
    const re = new RegExp(escapeRegExp(q), 'gi');
    let touched = 0;
    const walk = (blocks: import('../types').Block[]): void => {
      for (const b of blocks) {
        if (re.test(b.text)) {
          re.lastIndex = 0;
          b.text = b.text.replace(new RegExp(escapeRegExp(q), 'gi'), r);
          touched++;
        }
        walk(b.children);
      }
    };
    this.host.mutate(() => walk(this.host.doc.blocks));
    if (touched > 0) this.apply();
  }
}
