/**
 * Visual Prolog query builder.
 *
 * `{{query ...}}` cannot express "blocks tagged #book whose author also wrote
 * something tagged #film" — that needs variables and joins. Writing the Prolog
 * by hand is fine once you know it, but the vocabulary (which predicates exist,
 * which values are actually in the vault) is the real barrier, so this builds
 * the goal from dropdowns of REAL predicates and REAL values and previews the
 * results live before anything is inserted.
 */

import { Modal, Notice, Setting, setIcon } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import {
  buildQuery,
  newCondition,
  previewQuery,
  specOf,
  type Condition,
} from './prologBuild';
import { PREDICATES, prologFacts, valuesForKind } from './prologFacts';

const PANEL_CLASS = 'prolog-builder';

export class PrologQueryBuilderModal extends Modal {
  private plugin: LogseqEditorPlugin;
  private conds: Condition[] = [newCondition('tag/2')];
  private rowsEl: HTMLElement | null = null;
  private codeEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(plugin: LogseqEditorPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass(PANEL_CLASS);
    this.titleEl.setText('Prolog query builder');

    contentEl.createEl('div', {
      cls: 'prolog-builder-hint',
      text: 'Pick a predicate, then set each argument to a variable (join) or a value (filter). Results update as you go.',
    });

    this.rowsEl = contentEl.createEl('div', { cls: 'prolog-builder-rows' });

    const add = contentEl.createEl('div', { cls: 'prolog-builder-add' });
    const addBtn = add.createEl('button', { cls: 'prolog-builder-add-btn', text: '+ Add condition' });
    addBtn.addEventListener('click', () => {
      const last = this.conds[this.conds.length - 1];
      this.conds.push(newCondition(last?.pi ?? 'tag/2'));
      this.renderRows();
      this.refresh();
    });

    contentEl.createEl('div', { cls: 'prolog-builder-label', text: 'Generated query' });
    this.codeEl = contentEl.createEl('pre', { cls: 'prolog-builder-code' });

    contentEl.createEl('div', { cls: 'prolog-builder-label', text: 'Preview' });
    this.previewEl = contentEl.createEl('div', { cls: 'prolog-builder-preview' });
    this.statusEl = contentEl.createEl('div', { cls: 'prolog-builder-status' });

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText('Insert query').setCta().onClick(() => this.insert()),
      )
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));

    this.renderRows();
    this.refresh();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderRows(): void {
    const host = this.rowsEl;
    if (!host) return;
    host.empty();
    this.conds.forEach((c, i) => host.appendChild(this.renderRow(c, i)));
  }

  private renderRow(c: Condition, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'prolog-builder-row';
    const spec = specOf(c.pi);

    // --- predicate ---
    const sel = row.createEl('select', { cls: 'prolog-builder-pred' });
    for (const p of PREDICATES) {
      const opt = sel.createEl('option', { value: p.pi, text: p.name });
      if (p.pi === c.pi) opt.selected = true;
    }
    sel.title = spec?.doc ?? '';
    sel.addEventListener('change', () => {
      this.conds[index] = newCondition(sel.value);
      this.renderRows();
      this.refresh();
    });

    // --- arguments ---
    const argsEl = row.createEl('div', { cls: 'prolog-builder-args' });
    (spec?.args ?? []).forEach((as, ai) => {
      const arg = c.args[ai] ?? { text: '_', isVar: true };
      const wrap = argsEl.createEl('div', { cls: 'prolog-builder-arg' });
      const input = wrap.createEl('input', {
        cls: 'prolog-builder-input',
        attr: { type: 'text', placeholder: as.label },
      });
      input.value = arg.isVar ? arg.text : arg.text;
      input.addEventListener('input', () => {
        arg.text = input.value;
        this.refresh();
      });
      // Datalist of real values from the vault.
      const idx = this.plugin.blockIndex;
      if (idx && !arg.isVar) {
        const listId = `pl-dl-${index}-${ai}`;
        input.setAttribute('list', listId);
        const dl = wrap.createEl('datalist', { attr: { id: listId } });
        for (const v of valuesForKind(idx, as.kind, 40)) {
          dl.createEl('option', { attr: { value: v } });
        }
      }
      const toggle = wrap.createEl('button', {
        cls: 'prolog-builder-var' + (arg.isVar ? ' is-var' : ''),
        text: arg.isVar ? 'V' : 'abc',
      });
      toggle.title = arg.isVar ? 'Variable (click for a literal value)' : 'Literal value (click for a variable)';
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        arg.isVar = !arg.isVar;
        this.renderRows();
        this.refresh();
      });
      wrap.createEl('span', { cls: 'prolog-builder-arg-label', text: as.label });
    });

    // --- negate / remove ---
    const neg = row.createEl('button', {
      cls: 'prolog-builder-neg' + (c.negate ? ' is-neg' : ''),
      text: 'not',
    });
    neg.title = 'Negate this condition (exclude matches)';
    neg.addEventListener('click', (e) => {
      e.preventDefault();
      c.negate = !c.negate;
      this.renderRows();
      this.refresh();
    });

    const rm = row.createEl('button', { cls: 'prolog-builder-rm', text: '' });
    setIcon(rm, 'x');
    rm.title = 'Remove condition';
    rm.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.conds.length === 1) {
        this.conds = [newCondition('tag/2')];
      } else {
        this.conds.splice(index, 1);
      }
      this.renderRows();
      this.refresh();
    });
    return row;
  }

  /** Re-render the generated code and re-run the preview. */
  private refresh(): void {
    const built = buildQuery(this.conds);
    if (this.codeEl) this.codeEl.textContent = built.source || '—';

    const idx = this.plugin.blockIndex;
    const preview = this.previewEl;
    const status = this.statusEl;
    if (!preview || !status) return;
    preview.empty();
    status.empty();

    if (built.error) {
      status.setText(built.error);
      status.addClass('is-error');
      return;
    }
    status.removeClass('is-error');
    if (!idx) {
      status.setText('Block index unavailable');
      return;
    }

    const { program } = prologFacts(idx, idx.version ?? 0);
    const out = previewQuery(program, built.goal);
    if (out.error) {
      status.setText(out.error);
      status.addClass('is-error');
      return;
    }
    if (out.count === 0) {
      status.setText('No results');
      return;
    }
    status.setText(`${out.count}${out.count >= 12 ? '+' : ''} results`);
    const table = preview.createEl('table', { cls: 'prolog-builder-table' });
    const hr = table.createEl('thead').createEl('tr');
    for (const v of out.vars) hr.createEl('th', { text: v });
    const tb = table.createEl('tbody');
    for (const r of out.rows) {
      const tr = tb.createEl('tr');
      for (const cell of r) tr.createEl('td', { text: cell || '—' });
    }
  }

  private insert(): void {
    const built = buildQuery(this.conds);
    if (built.error || !built.source) {
      new Notice(built.error ?? 'Nothing to insert');
      return;
    }
    const done = this.plugin.insertPrologQuery(built.source);
    this.close();
    if (!done) new Notice('Open a block editor view first');
  }
}
