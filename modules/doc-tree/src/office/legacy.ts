/**
 * Fallback engine for the legacy binary formats (.doc / .xls / .ppt).
 *
 * These are not ZIP/OOXML — parsing them properly means reimplementing the OLE
 * compound-file format, which is far outside what a preview should cost. So the
 * view shows what it can honestly say about the file and hands the real work to
 * the operating system.
 */

import { escapeHTML, type OfficeEngine, type OfficeToolbarAction } from './types';

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export interface LegacyOptions {
  fileName: string;
  /** Size in bytes. */
  size: number;
  /** Kind label, e.g. '旧版文档'. */
  kindLabel: string;
  /** Open the file with the OS default application. */
  onOpenExternal(): void;
}

export function createLegacyEngine(o: LegacyOptions): OfficeEngine {
  const root = document.createElement('div');
  root.className = 'lg-office lg-office--legacy';

  const card = document.createElement('div');
  card.className = 'lg-office__legacy-card';
  card.innerHTML = `
    <div class="lg-office__legacy-icon">📄</div>
    <div class="lg-office__legacy-name">${escapeHTML(o.fileName)}</div>
    <div class="lg-office__legacy-meta">${escapeHTML(o.kindLabel)} · ${escapeHTML(formatSize(o.size))}</div>
    <div class="lg-office__legacy-hint">这是旧版二进制格式，无法在 Obsidian 内预览。请用外部应用打开它。</div>
  `;
  root.appendChild(card);

  const openBtn = document.createElement('button');
  openBtn.className = 'lg-office__legacy-open';
  openBtn.textContent = '用外部应用打开';
  openBtn.addEventListener('click', () => o.onOpenExternal());
  card.appendChild(openBtn);

  const toolbarActions: OfficeToolbarAction[] = [
    { label: '用外部应用打开', onClick: () => o.onOpenExternal() },
  ];

  return {
    root,
    editable: false,
    dispose: () => {
      card.innerHTML = '';
    },
    toolbarActions,
  };
}
