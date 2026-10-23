import { SuggestModal, TFile } from "obsidian";
import { compileQuery, type CompiledQuery } from "../../index-core/src/query";
import { getItemContent, search, type SearchHit } from "../../index-core/src/searcher";
import type { UnifiedSearchPlugin } from "./main";

/** 原文里定位 token 出现的区间（大小写不敏感），供高亮 */
function findRanges(text: string, tokens: string[]): [number, number][] {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const tok of tokens) {
    if (!tok) continue;
    const t = tok.toLowerCase();
    let from = 0;
    for (let guard = 0; guard < 200; guard++) {
      const idx = lower.indexOf(t, from);
      if (idx === -1) break;
      ranges.push([idx, idx + t.length]);
      from = idx + t.length;
    }
  }
  return ranges;
}

/** 取首个命中附近的窗口作摘要，并把 token 命中标成 <mark>（DOM 拼装，无 XSS 面） */
function buildSnippet(el: HTMLElement, content: string, tokens: string[]): void {
  let start = 0;
  if (tokens.length) {
    const lower = content.toLowerCase();
    let first = -1;
    for (const tok of tokens) {
      const idx = tok ? lower.indexOf(tok.toLowerCase()) : -1;
      if (idx !== -1 && (first === -1 || idx < first)) first = idx;
    }
    start = first === -1 ? 0 : Math.max(0, first - 60);
  }
  const window = content.slice(start, start + 240).replace(/\s+/g, " ").trim();
  const ranges = findRanges(window, tokens).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r] as [number, number]);
  }
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) el.createSpan({ text: window.slice(cursor, s) });
    el.createEl("mark", { text: window.slice(s, e) });
    cursor = e;
  }
  if (cursor < window.length) el.createSpan({ text: window.slice(cursor) });
}

export class UnifiedSearchModal extends SuggestModal<SearchHit> {
  private lastCompiled: CompiledQuery | null = null;

  constructor(private readonly plugin: UnifiedSearchPlugin) {
    super(plugin.app);
    this.setPlaceholder("统一索引搜索（空格 AND，\"短语\"，-排除，title:/tag:/path:/ext:，uni*）");
  }

  getSuggestions(query: string): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    try {
      const compiled = compileQuery(q, this.plugin.getTokenizerOpts());
      if (compiled.isEmpty) return [];
      this.lastCompiled = compiled;
      return search(this.plugin.getService(), compiled, { limit: 50 });
    } catch (e) {
      console.error("[unified-search] 搜索失败", e);
      return [];
    }
  }

  renderSuggestion(hit: SearchHit, el: HTMLElement): void {
    const head = el.createDiv({ cls: "unified-search-head" });
    head.createSpan({ cls: "unified-search-title", text: hit.title });
    head.createSpan({ cls: "unified-search-ext", text: hit.ext });
    el.createDiv({ cls: "unified-search-path", text: hit.path });
    const tokens = this.lastCompiled?.tokens ?? [];
    const content = getItemContent(this.plugin.getService(), hit.rowid);
    if (content) buildSnippet(el.createDiv({ cls: "unified-search-snippet" }), content, tokens);
  }

  onChooseSuggestion(hit: SearchHit): void {
    if (hit.domain === "ext") {
      // 库外文件：绝对路径，系统默认应用打开（deep 集成挂载树是 M2 的事）
      const shell = (
        (window as unknown as { require?: (m: string) => unknown }).require?.("electron") as
          | { shell?: { openPath(p: string): Promise<string> } }
          | undefined
      )?.shell;
      if (shell) void shell.openPath(hit.path);
      return;
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(hit.path);
    if (file instanceof TFile) {
      void this.plugin.app.workspace.getLeaf("tab").openFile(file);
    }
  }
}
