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

/** 建议条目：真实命中 或 搜索历史（空查询时展示，选择后回填重搜） */
export type Suggestion = ({ kind: "hit" } & SearchHit) | { kind: "history"; query: string };

/** 滑窗取 token 命中最密的 240 字符窗口起点（M2-4：多命中摘要，替代取首个命中） */
function bestSnippetStart(content: string, tokens: string[], win = 240): number {
  if (!tokens.length) return 0;
  const lower = content.toLowerCase();
  const pos: number[] = [];
  for (const tok of tokens) {
    if (!tok) continue;
    const t = tok.toLowerCase();
    let from = 0;
    for (let guard = 0; guard < 500; guard++) {
      const idx = lower.indexOf(t, from);
      if (idx === -1) break;
      pos.push(idx);
      from = idx + t.length;
    }
  }
  if (!pos.length) return 0;
  pos.sort((a, b) => a - b);
  // 双指针：窗口 [pos[j], pos[j]+win) 内命中点最多者胜
  let bestCount = 0;
  let bestStart = 0;
  let j = 0;
  for (let i = 0; i < pos.length; i++) {
    while (pos[i] - pos[j] >= win) j++;
    if (i - j + 1 > bestCount) {
      bestCount = i - j + 1;
      bestStart = Math.max(0, pos[j] - 30);
    }
  }
  return bestStart;
}

/** 取命中最密窗口作摘要，并把 token 命中标成 <mark>（DOM 拼装，无 XSS 面） */
function buildSnippet(el: HTMLElement, content: string, tokens: string[]): void {
  const start = bestSnippetStart(content, tokens);
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

/** 块级 item 的展示标题：块内容首行去列表/星标标记（M2-2） */
function blockTitleOf(content: string): string | null {
  const first = content.split("\n", 1)[0]?.trim() ?? "";
  const m = /^[-*+][ \t]+|^\*{1,6}[ \t]+/.exec(first);
  const t = (m ? first.slice(m[0].length) : first).trim();
  return t || null;
}

export class UnifiedSearchModal extends SuggestModal<Suggestion> {
  private lastCompiled: CompiledQuery | null = null;
  /** 搜索历史（新在前，去重，≤20 条），localStorage 按 vault 隔离 */
  private history: string[];

  constructor(private readonly plugin: UnifiedSearchPlugin) {
    super(plugin.app);
    this.setPlaceholder(
      "统一索引搜索（空格 AND，\"短语\"，-排除，title:/tag:/path:/ext:/backlink:，uni*）",
    );
    this.history = loadHistory(plugin.app.vault.getName());
  }

  getSuggestions(query: string): Suggestion[] {
    const q = query.trim();
    // 空查询 → 历史（选择后回填输入框重搜，不关闭）
    if (!q) return this.history.map((query) => ({ kind: "history" as const, query }));
    try {
      const compiled = compileQuery(q, this.plugin.getTokenizerOpts());
      if (compiled.isEmpty) return [];
      this.lastCompiled = compiled;
      // 写会话（扫描/flush）中关 LIKE 兜底：部分索引必然落空，兜底只会白扫大库
      return search(this.plugin.getService(), compiled, {
        limit: 50,
        likeThreshold: this.plugin.isWriteSession ? 0 : undefined,
      }).map((hit) => ({
        kind: "hit" as const,
        ...hit,
      }));
    } catch (e) {
      console.error("[unified-search] 搜索失败", e);
      return [];
    }
  }

  renderSuggestion(s: Suggestion, el: HTMLElement): void {
    if (s.kind === "history") {
      const head = el.createDiv({ cls: "unified-search-head" });
      head.createSpan({ cls: "unified-search-title", text: s.query });
      head.createSpan({ cls: "unified-search-ext", text: "历史" });
      return;
    }
    const head = el.createDiv({ cls: "unified-search-head" });
    const tokens = this.lastCompiled?.tokens ?? [];
    const content = getItemContent(this.plugin.getService(), s.rowid);
    // 块级命中（M2-2）：标题用块首行，徽标区分；摘要来自块内容天然更聚焦
    const title = s.blockId ? (blockTitleOf(content) ?? s.title) : s.title;
    head.createSpan({ cls: "unified-search-title", text: title });
    head.createSpan({ cls: "unified-search-ext", text: s.blockId ? `块·${s.ext}` : s.ext });
    el.createDiv({ cls: "unified-search-path", text: s.path });
    if (content) buildSnippet(el.createDiv({ cls: "unified-search-snippet" }), content, tokens);
  }

  onChooseSuggestion(s: Suggestion): void {
    if (s.kind === "history") {
      // 回填查询词并触发重新搜索：SuggestModal 监听 input 事件
      this.inputEl.value = s.query;
      this.inputEl.dispatchEvent(new Event("input"));
      return;
    }
    this.recordHistory(this.inputEl.value.trim());
    if (s.domain === "ext") {
      // 库外文件：绝对路径，系统默认应用打开（deep 集成挂载树是 M2 的事）
      const shell = (
        (window as unknown as { require?: (m: string) => unknown }).require?.("electron") as
          | { shell?: { openPath(p: string): Promise<string> } }
          | undefined
      )?.shell;
      if (shell) void shell.openPath(s.path);
      return;
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(s.path);
    if (file instanceof TFile) {
      if (s.blockId) {
        // 块级命中：带 #^id 锚点打开，Obsidian 定位到块（锚点解析不出时回落开文件）
        void this.plugin.app.workspace.openLinkText(`${s.path}#^${s.blockId}`, "");
      } else {
        void this.plugin.app.workspace.getLeaf("tab").openFile(file);
      }
    }
  }

  private recordHistory(query: string): void {
    if (!query) return;
    this.history = [query, ...this.history.filter((h) => h !== query)].slice(0, 20);
    try {
      localStorage.setItem(historyKey(this.plugin.app.vault.getName()), JSON.stringify(this.history));
    } catch {
      // 存储满等异常不影响搜索
    }
  }
}

function historyKey(vault: string): string {
  return `unified-search-history:${vault}`;
}

function loadHistory(vault: string): string[] {
  try {
    const raw = localStorage.getItem(historyKey(vault));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
