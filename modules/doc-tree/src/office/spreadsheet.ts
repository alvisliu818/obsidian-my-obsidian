/**
 * Spreadsheet engine: renders .xlsx / .xlsm / .csv as a plain HTML grid with a
 * sheet tab bar.
 *
 * Ported in spirit from `siyuan-editor/src/office/spreadsheet.ts`, which drove
 * `x-data-spreadsheet` for full editing. That editor carries its own DOM,
 * styles and ~400 KB of JS, and editing is out of scope here (see
 * `./types.ts`), so this renders the cells read-only instead — which is the
 * part people actually need when a .xlsx lands in their vault.
 */

import * as XLSX from 'xlsx';
import { escapeHTML, type OfficeEngine, type OfficeToolbarAction } from './types';

/** Rows rendered before "show all" is pressed. */
const INITIAL_ROWS = 200;
/** Hard ceiling even after "show all", so a 1M-row sheet cannot freeze Obsidian. */
const MAX_ROWS = 20000;
const MAX_COLS = 64;

interface SheetData {
  name: string;
  rows: string[][];
}

/** Coerce any cell value to display text. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function readSheets(data: ArrayBuffer, isCsv: boolean): SheetData[] {
  const wb = isCsv
    ? XLSX.read(new TextDecoder('utf-8').decode(data), { type: 'string', raw: false })
    : XLSX.read(data, { type: 'array' });
  const out: SheetData[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      blankrows: false,
      defval: '',
      raw: false,
    });
    out.push({
      name,
      rows: grid.map((r) =>
        (Array.isArray(r) ? r : []).slice(0, MAX_COLS).map(cellText),
      ),
    });
  }
  return out;
}

export function createSpreadsheetEngine(data: ArrayBuffer, isCsv = false): OfficeEngine {
  const sheets = readSheets(data, isCsv);
  if (sheets.length === 0) throw new Error('工作簿中没有可读取的工作表');

  const root = document.createElement('div');
  root.className = 'lg-office lg-office--sheet';

  // Tab bar
  const tabs = document.createElement('div');
  tabs.className = 'lg-office__sheet-tabs';
  root.appendChild(tabs);

  const status = document.createElement('div');
  status.className = 'lg-office__sheet-status';
  root.appendChild(status);

  const scroll = document.createElement('div');
  scroll.className = 'lg-office__sheet-scroll';
  const table = document.createElement('table');
  table.className = 'lg-office__sheet-table';
  scroll.appendChild(table);
  root.appendChild(scroll);

  let active = 0;
  let expanded = false;

  function renderTabs(): void {
    tabs.innerHTML = '';
    sheets.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'lg-office__sheet-tab';
      if (i === active) b.classList.add('is-active');
      b.textContent = s.name;
      b.addEventListener('click', () => {
        active = i;
        expanded = false;
        renderTabs();
        renderTable();
      });
      tabs.appendChild(b);
    });
  }

  function renderTable(): void {
    const sheet = sheets[active];
    const total = sheet.rows.length;
    const limit = expanded ? MAX_ROWS : INITIAL_ROWS;
    const shown = sheet.rows.slice(0, limit);

    const rowsHtml = shown
      .map((row, r) => {
        const cells = row.map((c) => `<td>${escapeHTML(c)}</td>`).join('');
        return `<tr><th class="lg-office__rownum">${r + 1}</th>${cells}</tr>`;
      })
      .join('');
    table.innerHTML = `<thead><tr><th class="lg-office__rownum"></th></tr></thead><tbody>${rowsHtml}</tbody>`;

    status.innerHTML = '';
    const info = document.createElement('span');
    info.textContent = `${sheet.name} · ${total} 行 · 已显示 ${shown.length} 行`;
    status.appendChild(info);
    if (total > shown.length) {
      const more = document.createElement('button');
      more.className = 'lg-office__linkbtn';
      more.textContent = expanded ? `显示全部（上限 ${MAX_ROWS}）` : '显示更多';
      more.addEventListener('click', () => {
        expanded = true;
        renderTable();
      });
      status.appendChild(more);
    }
  }

  renderTabs();
  renderTable();

  const toolbarActions: OfficeToolbarAction[] = sheets.map((s) => ({
    label: s.name,
    onClick: () => {
      const i = sheets.indexOf(s);
      if (i >= 0) {
        active = i;
        expanded = false;
        renderTabs();
        renderTable();
      }
    },
  }));

  return {
    root,
    editable: false,
    dispose: () => {
      table.innerHTML = '';
      tabs.innerHTML = '';
    },
    toolbarActions: sheets.length > 1 ? toolbarActions : undefined,
  };
}
