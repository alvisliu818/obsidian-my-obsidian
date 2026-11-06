/**
 * Vault-wide content search panel.
 *
 * Ported from `siyuan-editor/src/components/search-panel.ts`. Obsidian's own
 * search is good at *finding* and weak at *reading around the hit* — it shows
 * one line with no line number you can act on, and it will not walk a folder
 * you excluded from the index. This panel keeps the knobs (regex / case /
 * whole word / folder / extension / size cap) visible and makes every hit a
 * jump-to-line target.
 *
 * It reads through `vault.cachedRead`, so it never touches disk directly and
 * never writes anything.
 */

import {
  ItemView,
  MarkdownView,
  Notice,
  TFile,
  debounce,
  type WorkspaceLeaf,
} from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { DEFAULT_CONTENT_SEARCH, type ContentSearchOptions } from '../types';

export const VIEW_TYPE_CONTENT_SEARCH = 'logseq-content-search';

/** Files examined before giving up (a vault can hold tens of thousands). */
const MAX_FILES = 5000;
/** Hits collected before giving up. */
const MAX_HITS = 2000;

/** Text extensions used when the user leaves the field empty. */
const FALLBACK_EXTS = ['md', 'txt', 'markdown', 'csv', 'json', 'js', 'ts', 'py', 'html', 'css'];

interface Hit {
  path: string;
  line: number;
  /** The matched line, trimmed for display. */
  text: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the matcher, or null when the query cannot be used. */
export function buildMatcher(
  query: string,
  o: ContentSearchOptions,
): { re: RegExp; error?: string } | null {
  if (!query) return null;
  let src = o.regex ? query : escapeRe(query);
  if (o.wholeWord && !o.regex) src = `\\b${src}\\b`;
  let re: RegExp;
  try {
    re = new RegExp(src, o.caseSensitive ? 'g' : 'gi');
  } catch (e) {
    return { re: /(?!)/, error: e instanceof Error ? e.message : String(e) };
  }
  return { re };
}

/** Wrap every match in the line with <mark>. */
export function highlightLine(line: string, re: RegExp): string {
  const clone = new RegExp(re.source, re.flags);
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = clone.exec(line)) !== null && guard++ < 200) {
    if (m[0].length === 0) {
      clone.lastIndex++;
      continue;
    }
    out += escapeHTML(line.slice(last, m.index));
    out += `<mark>${escapeHTML(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  out += escapeHTML(line.slice(last));
  return out;
}

function escapeHTML(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseExts(raw: string): string[] {
  const list = raw
    .split(/[,，\s]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  return list.length ? list : FALLBACK_EXTS;
}

export class ContentSearchPanelView extends ItemView {
  plugin: LogseqEditorPlugin;
  private queryInput!: HTMLInputElement;
  private folderInput!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  /** Bumped on every new search so stale async work can bail out. */
  private searchSeq = 0;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CONTENT_SEARCH;
  }

  getDisplayText(): string {
    return '文件内容搜索';
  }

  getIcon(): string {
    return 'search';
  }

  private get opts(): ContentSearchOptions {
    return this.plugin.settings.contentSearch ?? DEFAULT_CONTENT_SEARCH;
  }

  private async setOpts(patch: Partial<ContentSearchOptions>): Promise<void> {
    this.plugin.settings.contentSearch = { ...this.opts, ...patch };
    await this.plugin.saveSettings();
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('lg-csearch');

    const head = this.contentEl.createDiv({ cls: 'lg-csearch__head' });
    this.queryInput = head.createEl('input', {
      cls: 'lg-csearch__input',
      type: 'search',
      attr: { placeholder: '搜索文件内容…（回车开始）' },
    });
    this.queryInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.run();
      if (e.key === 'Escape') this.queryInput.value = '';
    });
    // Live search as you type, but never on every keystroke.
    this.queryInput.addEventListener(
      'input',
      debounce(() => void this.run(), 350, true),
    );

    const optsRow = this.contentEl.createDiv({ cls: 'lg-csearch__opts' });
    this.toggleChip(optsRow, '区分大小写', this.opts.caseSensitive, (v) => {
      void this.setOpts({ caseSensitive: v }).then(() => void this.run());
    });
    this.toggleChip(optsRow, '全词匹配', this.opts.wholeWord, (v) => {
      void this.setOpts({ wholeWord: v }).then(() => void this.run());
    });
    this.toggleChip(optsRow, '正则表达式', this.opts.regex, (v) => {
      void this.setOpts({ regex: v }).then(() => void this.run());
    });

    const filterRow = this.contentEl.createDiv({ cls: 'lg-csearch__filters' });
    this.folderInput = this.input(filterRow, '文件夹', this.opts.folder, '例如 journals');
    this.input(filterRow, '扩展名', this.opts.extensions, 'md, txt');

    this.statusEl = this.contentEl.createDiv({ cls: 'lg-csearch__status' });
    this.resultsEl = this.contentEl.createDiv({ cls: 'lg-csearch__results' });
  }

  async onClose(): Promise<void> {
    this.searchSeq++;
  }

  private input(parent: HTMLElement, label: string, value: string, ph: string): HTMLInputElement {
    const wrap = parent.createDiv({ cls: 'lg-csearch__field' });
    wrap.createEl('label', { text: label });
    const el = wrap.createEl('input', { type: 'text', attr: { placeholder: ph } });
    el.value = value;
    el.addEventListener('change', () => {
      if (el === this.folderInput) void this.setOpts({ folder: el.value.trim() }).then(() => void this.run());
      else void this.setOpts({ extensions: el.value.trim() }).then(() => void this.run());
    });
    return el;
  }

  private toggleChip(parent: HTMLElement, label: string, on: boolean, onChange: (v: boolean) => void): void {
    const b = parent.createEl('button', { cls: 'lg-csearch__chip', text: label });
    b.classList.toggle('is-on', on);
    b.addEventListener('click', () => {
      const next = !b.classList.contains('is-on');
      b.classList.toggle('is-on', next);
      onChange(next);
    });
  }

  /** Run the search over the vault. */
  async run(): Promise<void> {
    const q = this.queryInput?.value?.trim() ?? '';
    const mySeq = ++this.searchSeq;
    this.resultsEl.empty();
    if (!q) {
      this.statusEl.textContent = '';
      return;
    }

    const o = this.opts;
    const built = buildMatcher(q, o);
    if (!built) return;
    if (built.error) {
      this.statusEl.textContent = `正则表达式无效：${built.error}`;
      return;
    }
    const re = built.re;

    const exts = new Set(parseExts(o.extensions));
    const folder = o.folder.replace(/^\/+|\/+$/g, '');
    const maxBytes = Math.max(1, o.maxFileKB) * 1024;

    let files = this.app.vault.getFiles().filter((f) => {
      if (folder && !(f.path === folder || f.path.startsWith(folder + '/'))) return false;
      const ext = (f.extension || '').toLowerCase();
      return exts.has(ext);
    });
    if (files.length > MAX_FILES) files = files.slice(0, MAX_FILES);

    this.statusEl.textContent = `正在搜索 ${files.length} 个文件…`;

    const hits: Hit[] = [];
    let scanned = 0;
    let skipped = 0;
    const started = Date.now();

    for (const file of files) {
      if (mySeq !== this.searchSeq) return; // superseded by a newer query
      if (hits.length >= MAX_HITS) break;
      if (file.stat.size > maxBytes) {
        skipped++;
        continue;
      }
      let text: string;
      try {
        text = await this.app.vault.cachedRead(file);
      } catch {
        skipped++;
        continue;
      }
      scanned++;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (!re.test(lines[i])) continue;
        hits.push({ path: file.path, line: i, text: lines[i].trim().slice(0, 400) });
        if (hits.length >= MAX_HITS) break;
      }
      // Yield to the event loop so a big vault does not freeze the UI.
      if (scanned % 40 === 0) {
        await new Promise((r) => setTimeout(r, 0));
        if (mySeq !== this.searchSeq) return;
        this.statusEl.textContent = `正在搜索… 已扫 ${scanned}/${files.length}，命中 ${hits.length}`;
      }
    }

    const ms = Date.now() - started;
    this.statusEl.textContent =
      `命中 ${hits.length} 处 · 扫描 ${scanned} 个文件` +
      (skipped ? ` · 跳过 ${skipped} 个（过大或不可读）` : '') +
      ` · ${ms} ms` +
      (hits.length >= MAX_HITS ? '（已达上限，请缩小范围）' : '');

    this.renderHits(hits, re);
  }

  private renderHits(hits: Hit[], re: RegExp): void {
    this.resultsEl.empty();
    if (hits.length === 0) {
      this.resultsEl.createDiv({ cls: 'lg-csearch__empty', text: '没有匹配结果。' });
      return;
    }
    const byFile = new Map<string, Hit[]>();
    for (const h of hits) {
      const list = byFile.get(h.path);
      if (list) list.push(h);
      else byFile.set(h.path, [h]);
    }

    for (const [path, list] of byFile) {
      const group = this.resultsEl.createDiv({ cls: 'lg-csearch__file' });
      const head = group.createDiv({ cls: 'lg-csearch__filehead' });
      head.createEl('span', { cls: 'lg-csearch__filename', text: path });
      head.createEl('span', { cls: 'lg-csearch__count', text: `${list.length} 处` });
      for (const h of list.slice(0, 50)) {
        const row = group.createDiv({ cls: 'lg-csearch__hit' });
        row.createEl('span', { cls: 'lg-csearch__lineno', text: String(h.line + 1) });
        const body = row.createDiv({ cls: 'lg-csearch__snippet' });
        body.innerHTML = highlightLine(h.text, re);
        row.addEventListener('click', () => void this.jump(h));
      }
      if (list.length > 50) {
        group.createDiv({ cls: 'lg-csearch__more', text: `…还有 ${list.length - 50} 处未显示` });
      }
    }
  }

  /** Open the file and put the caret (or the block) on the matched line. */
  private async jump(h: Hit): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(h.path);
    if (!(file instanceof TFile)) {
      new Notice('文件已不存在。');
      return;
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const view = leaf.view;

    if (view instanceof MarkdownView) {
      const line = Math.min(h.line, view.editor.lineCount() - 1);
      view.editor.setCursor({ line, ch: 0 });
      view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
      return;
    }

    // The block editor is a custom DOM, not a CodeMirror instance, so there is
    // no caret to move. Find the block whose text contains the hit and flash it.
    const container = (view as { contentEl?: HTMLElement }).contentEl;
    if (!container) return;
    const needle = h.text.trim().slice(0, 60);
    const blocks = Array.from(container.querySelectorAll<HTMLElement>('.block-wrap'));
    const target =
      blocks.find((b) => (b.textContent || '').includes(needle)) ??
      blocks[Math.min(h.line, blocks.length - 1)];
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.addClass('lg-csearch__flash');
    window.setTimeout(() => target.removeClass('lg-csearch__flash'), 1600);
  }

  /** Focus the query box (used by the command palette entry). */
  focusQuery(): void {
    this.queryInput?.focus();
    this.queryInput?.select();
  }

  setQuery(q: string): void {
    if (this.queryInput) this.queryInput.value = q;
  }
}
