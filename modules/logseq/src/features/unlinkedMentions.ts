/**
 * Unlinked mentions section (page-bottom, under linked mentions):
 * scans the vault for blocks that MENTION this page's title as plain text
 * (no [[link]]) and offers one-click conversion to a real [[link]].
 * Hits are grouped by source file (same layout as linked mentions); the file
 * header opens the file, clicking a row VIEWS the source (block/page), and
 * the row-end link icon converts the mention to a [[link]].
 * Conversion goes through the guarded write path (backup + operation log),
 * and the mention disappears from the list on the next index refresh.
 */

import { setIcon, TFile } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import type { IndexedBlock } from '../index/blockIndex';

export const UNLINKED_SECTION_CLASS = 'page-unlinked';

const MAX_ITEMS = 50;

/**
 * Render the unlinked-mentions section under the backlinks area.
 * Idempotent; no-ops when the title is too short to match meaningfully.
 */
export function renderUnlinkedMentions(
  containerEl: HTMLElement,
  plugin: LogseqEditorPlugin,
  currentPath: string | undefined,
  title: string,
): void {
  containerEl.querySelector(`:scope > .${UNLINKED_SECTION_CLASS}`)?.remove();
  if (!currentPath) return;
  const q = title.trim().toLowerCase();
  // Meaningful matching only: >= 3 chars so single-letter pages don't spam.
  if (q.length < 3) return;

  const idx = plugin.blockIndex;
  if (!idx) return;

  const hits: Array<{ entry: IndexedBlock; count: number }> = [];
  for (const b of idx.allBlocks()) {
    if (b.path.toLowerCase() === currentPath.toLowerCase()) continue;
    const lower = b.text.toLowerCase();
    if (!lower.includes(q)) continue;
    // Skip blocks that already link the page.
    if (b.links.some((l) => l.toLowerCase() === q)) continue;
    // Count plain occurrences of the title (rough, for the badge).
    const count = lower.split(q).length - 1;
    hits.push({ entry: b, count });
    if (hits.length >= MAX_ITEMS) break;
  }

  const section = containerEl.createEl('div', { cls: UNLINKED_SECTION_CLASS });
  const header = section.createEl('div', { cls: 'page-backlinks-header' });
  header.createEl('span', {
    cls: 'page-unlinked-title',
    text: `${hits.length} unlinked mention${hits.length === 1 ? '' : 's'}`,
  });

  if (hits.length === 0) {
    section.addClass('is-empty');
    return;
  }

  // Group by source file (same layout as the linked-mentions section); the
  // group header opens the file, rows view the source, the row-end link
  // icon converts the mention to a [[link]].
  const groups = new Map<string, Array<{ entry: IndexedBlock; count: number }>>();
  for (const h of hits) {
    const arr = groups.get(h.entry.path) ?? [];
    arr.push(h);
    groups.set(h.entry.path, arr);
  }

  const body = section.createEl('div', { cls: 'page-backlinks-list' });
  for (const [path, items] of groups) {
    const group = body.createEl('div', { cls: 'page-backlinks-group' });
    const pageRow = group.createEl('div', { cls: 'page-backlinks-page' });
    const icon = pageRow.createEl('span', { cls: 'page-backlinks-icon' });
    setIcon(icon, 'file-text');
    pageRow.createEl('span', { text: path });
    pageRow.addEventListener('click', () => {
      void plugin.app.workspace.openLinkText(path, '', false);
    });
    for (const { entry, count } of items) {
      const row = group.createEl('div', { cls: 'page-backlinks-item page-unlinked-item' });
      if (entry.marker) {
        const mk = row.createEl('span', { cls: 'block-marker ' + entry.marker.toLowerCase() });
        mk.setAttribute('aria-label', entry.marker);
      }
      const textEl = row.createEl('span', { cls: 'page-backlinks-item-text' });
      textEl.setText(plainPreview(entry.text, title));
      row.createEl('span', { cls: 'page-unlinked-count', text: `×${count}` });
      // Clicking the row VIEWS the source (same as linked mentions): jump to
      // the block when it has an id, otherwise open its page. Converting is
      // a separate, explicit action on the link icon at the row end.
      row.addEventListener('click', () => {
        if (entry.blockId) void plugin.openBlockRef(entry.blockId);
        else void plugin.app.workspace.openLinkText(entry.path, '', false);
      });
      // Convert affordance icon at the row end.
      const convert = row.createEl('span', { cls: 'page-unlinked-convert', attr: { 'aria-label': 'Convert to [[link]]' } });
      setIcon(convert, 'link');
      convert.addEventListener('click', (e) => {
        e.stopPropagation();
        void convertMention(plugin, entry, title);
      });
    }
  }
}

/** Plain text preview with the mention highlighted by context (±40 chars). */
function plainPreview(text: string, title: string): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  const i = plain.toLowerCase().indexOf(title.toLowerCase());
  if (i < 0) return plain.slice(0, 80);
  const start = Math.max(0, i - 40);
  const end = Math.min(plain.length, i + title.length + 40);
  return (start > 0 ? '…' : '') + plain.slice(start, end) + (end < plain.length ? '…' : '');
}

/**
 * Convert the FIRST plain-text mention of `title` in the source block into a
 * [[link]], through the guarded write path. The block index refresh (fired by
 * the vault modify event) removes it from the list.
 */
async function convertMention(
  plugin: LogseqEditorPlugin,
  entry: IndexedBlock,
  title: string,
): Promise<void> {
  const af = plugin.app.vault.getAbstractFileByPath(entry.path);
  if (!(af instanceof TFile)) return;
  const file: TFile = af;
  try {
    const data = await plugin.app.vault.read(file);
    // Work line-by-line to avoid replacing inside existing [[wiki links]]:
    // skip any line segment already wrapped in [[ ]].
    const lines = data.split('\n');
    let done = false;
    for (let i = 0; i < lines.length && !done; i++) {
      const line = lines[i];
      if (!line.toLowerCase().includes(title.toLowerCase())) continue;
      if (stripWiki(line).toLowerCase().includes(title.toLowerCase())) {
        lines[i] = replaceFirstMention(line, title);
        done = true;
      }
    }
    if (!done) return;
    const newData = lines.join('\n');
    if (newData === data) return;
    await plugin.backups.safeProcess(file, () => newData, 'unlinked.convert');
  } catch {
    // Guarded write already Notified on failure; nothing else to do here.
  }
}

/** Remove [[ ]] wrappers so link-internal text doesn't count as a mention. */
function stripWiki(line: string): string {
  return line.replace(/\[\[([^\]]*)\]\]/g, '$1');
}

/** Replace the first occurrence of `title` that is NOT inside [[ ]] with a link. */
function replaceFirstMention(line: string, title: string): string {
  const lower = line.toLowerCase();
  const t = title.toLowerCase();
  // Walk occurrences; skip any inside [[ ]].
  let from = 0;
  for (;;) {
    const i = lower.indexOf(t, from);
    if (i < 0) return line;
    const open = line.lastIndexOf('[[', i);
    const close = line.lastIndexOf(']]', i);
    if (open < 0 || (close >= 0 && close > open)) {
      // Not inside a wiki link: convert this occurrence.
      return line.slice(0, i) + `[[${title}]]` + line.slice(i + title.length);
    }
    from = i + t.length;
  }
}
