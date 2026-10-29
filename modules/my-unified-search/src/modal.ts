import { SuggestModal, TFile } from "obsidian";
import { searchExternal, type ExternalHit } from "./providers";
import { buildMatchPlan } from "./matchBuilder";
import type { BlockIndexDaemonClient } from "./daemon/daemonClient";
import type { UnifiedSearchPlugin } from "./main";

/** 只走某个外部源的前缀：`ev:` Everything（文件名）、`at:` AnyTXT（全文） */
const PREFIX_RE = /^(ev|at):\s*(.+)$/s;

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

/** 建议条目：daemon 块命中 / ext 域(挂载库外文件)命中 / 外部源命中 / 搜索历史 */
export type Suggestion =
  | { kind: "hit"; path: string; blockId: string | null; text: string }
  | { kind: "ext"; path: string; text: string }
  | ({ kind: "external" } & ExternalHit)
  | { kind: "history"; query: string };

/** 滑窗取 token 命中最密的 240 字符窗口起点（多命中摘要，替代取首个命中） */
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

/** 块命中展示标题：块内容首行去列表/星标标记 */
function blockTitleOf(content: string): string | null {
  const first = content.split("\n", 1)[0]?.trim() ?? "";
  const m = /^[-*+][ \t]+|^\*{1,6}[ \t]+/.exec(first);
  const t = (m ? first.slice(m[0].length) : first).trim();
  return t || null;
}

export class UnifiedSearchModal extends SuggestModal<Suggestion> {
  /** 最近一次查询的高亮 tokens（渲染摘要用） */
  private lastTokens: string[] = [];
  /** 搜索历史（新在前，去重，≤20 条），localStorage 按 vault 隔离 */
  private history: string[];

  constructor(private readonly plugin: UnifiedSearchPlugin) {
    super(plugin.app);
    this.setPlaceholder(
      "统一索引搜索（空格 AND，\"短语\"，-排除，tag:/path:/ext:/backlink:，daemon FTS）",
    );
    this.history = loadHistory(plugin.app.vault.getName());
  }

  async getSuggestions(query: string): Promise<Suggestion[]> {
    const q = query.trim();
    // 空查询 → 历史（选择后回填输入框重搜，不关闭）
    if (!q) return this.history.map((query) => ({ kind: "history" as const, query }));

    // 前缀语法：`ev:` 只搜 Everything、`at:` 只搜 AnyTXT（跳过本地索引）
    const prefix = PREFIX_RE.exec(q);
    const onlySource = prefix ? (prefix[1] === "ev" ? "everything" : "anytxt") : null;
    const text = prefix ? prefix[2].trim() : q;
    if (!text) return [];

    let local: Suggestion[] = [];
    if (!onlySource) {
      try {
        local = await this.searchDaemon(text);
      } catch (e) {
        console.error("[unified-search] 搜索失败", e);
      }
    }

    // 外部源：并行跑，单个源未开/超时一律空结果，绝不影响本地
    const s = this.plugin.settings;
    const wantEverything = onlySource ? onlySource === "everything" : s.everything.enabled;
    const wantAnyTxt = onlySource ? onlySource === "anytxt" : s.anytxt.enabled;
    let ext: ExternalHit[] = [];
    if (wantEverything || wantAnyTxt) {
      ext = await searchExternal(text, {
        everything: { ...s.everything, enabled: wantEverything },
        anytxt: { ...s.anytxt, enabled: wantAnyTxt },
      });
    }
    const extHits: Suggestion[] = ext.map((hit) => ({ kind: "external" as const, ...hit }));
    // 外部结果里的库内文件也能直接跳转：交给渲染层判断（路径转 vault 相对）
    return [...local, ...extHits];
  }

  /**
   * 本地搜索 = 守护进程 blocks_fts（FTS5 trigram）。
   * daemon-only（2026-10-25 用户指定）：守护进程没起来就没有本地结果，
   * 给一条说明行，不回落任何渲染内索引。
   */
  private async searchDaemon(text: string): Promise<Suggestion[]> {
    const plan = buildMatchPlan(text);
    this.lastTokens = plan.tokens;
    if (!plan.positive.length) return [];
    const daemon = this.plugin.daemon;
    if (!daemon) {
      return [
        {
          kind: "hit",
          path: "",
          blockId: null,
          text: "索引守护进程未运行——在 logseq 模块设置里开启 SQLite 索引并重启 Obsidian。",
        },
      ];
    }
    let hits: { bkey: string; path: string; blockId: string; text: string }[];
    if (plan.positive.some((t) => t.length < 3)) {
      // trigram 的物理限制:<3 字符的 term 无法 MATCH(中文两字词极常见)——
      // 整条查询改走 scan(LIKE 全库扫,主库 ~237ms),多词按 bkey 交集,
      // 排除项客户端过滤。
      let base: Map<string, { bkey: string; path: string; text: string }> | null = null;
      for (const t of plan.positive) {
        const rows = await daemon.scan(t, "", 500);
        const m = new Map(rows.map((r) => [r.bkey, r]));
        if (base === null) base = m;
        else for (const k of [...base.keys()]) if (!m.has(k)) base.delete(k);
        if (base.size === 0) return [];
      }
      hits = [...(base ?? new Map()).values()].map((r) => ({ ...r, blockId: "" }));
      hits = hits.filter((h) => !plan.negative.some((n) => h.text.includes(n)));
    } else {
      hits = await daemon.ftsSearch(plan.match, "", 80);
    }
    if (plan.pathSubs.length) {
      hits = hits.filter((h) => {
        const p = h.path.toLowerCase();
        return plan.pathSubs.every((s) => p.includes(s));
      });
    }
    if (plan.exts.length) {
      hits = hits.filter((h) => {
        const p = h.path.toLowerCase();
        return plan.exts.some((e) => p.endsWith("." + e));
      });
    }
    for (const page of plan.backlinkPages) {
      let sources = new Set<string>();
      try {
        sources = new Set(
          (await (daemon as BlockIndexDaemonClient).backlinksTo(page)).map((r) =>
            r.sourcePath.toLowerCase(),
          ),
        );
      } catch {
        /* backlink 过滤是锦上添花,失败当空集 */
      }
      hits = hits.filter((h) => sources.has(h.path.toLowerCase()));
    }
    const out: Suggestion[] = hits
      .slice(0, 50)
      .map((h) => ({ kind: "hit" as const, path: h.path, blockId: h.blockId || null, text: h.text }));
    // ext 域(挂载库外文件):整文件一行,daemon 侧逐 token 交集;失败静默
    try {
      let extHits = await daemon.extSearch(plan.positive, plan.negative, 30);
      if (plan.pathSubs.length) {
        extHits = extHits.filter((h) => {
          const p = h.path.toLowerCase();
          return plan.pathSubs.every((s) => p.includes(s));
        });
      }
      if (plan.exts.length) {
        extHits = extHits.filter((h) => {
          const p = h.path.toLowerCase();
          return plan.exts.some((e) => p.endsWith("." + e));
        });
      }
      out.push(
        ...extHits.slice(0, 20).map((h) => ({ kind: "ext" as const, path: h.path, text: h.text })),
      );
    } catch {
      /* ext 域可选 */
    }
    return out;
  }

  renderSuggestion(s: Suggestion, el: HTMLElement): void {
    if (s.kind === "external") {
      const head = el.createDiv({ cls: "unified-search-head" });
      head.createSpan({ cls: "unified-search-title", text: s.name });
      head.createSpan({
        cls: "unified-search-ext",
        text: s.source === "everything" ? "Everything" : "AnyTXT",
      });
      el.createDiv({ cls: "unified-search-path", text: s.path });
      const meta = [
        typeof s.size === "number" ? formatSize(s.size) : "",
        typeof s.mtime === "number" ? formatDate(s.mtime) : "",
      ]
        .filter(Boolean)
        .join(" · ");
      if (meta) el.createDiv({ cls: "unified-search-snippet", text: meta });
      if (s.snippet) {
        el.createDiv({ cls: "unified-search-snippet", text: s.snippet });
      }
      return;
    }
    if (s.kind === "ext") {
      // 挂载库外文件:标题=文件名,徽标 ext,摘要来自全文
      const head = el.createDiv({ cls: "unified-search-head" });
      head.createSpan({ cls: "unified-search-title", text: s.path.split("/").pop() ?? s.path });
      head.createSpan({ cls: "unified-search-ext", text: "ext" });
      el.createDiv({ cls: "unified-search-path", text: s.path });
      if (s.text) buildSnippet(el.createDiv({ cls: "unified-search-snippet" }), s.text, this.lastTokens);
      return;
    }
    if (s.kind === "history") {
      const head = el.createDiv({ cls: "unified-search-head" });
      head.createSpan({ cls: "unified-search-title", text: s.query });
      head.createSpan({ cls: "unified-search-ext", text: "历史" });
      return;
    }
    const head = el.createDiv({ cls: "unified-search-head" });
    // 块命中：标题用块首行，徽标区分；摘要来自块内容
    const title = blockTitleOf(s.text) ?? s.path.split("/").pop() ?? "(块)";
    head.createSpan({ cls: "unified-search-title", text: title });
    head.createSpan({ cls: "unified-search-ext", text: s.blockId ? "块·md" : "md" });
    el.createDiv({ cls: "unified-search-path", text: s.path });
    if (s.text) buildSnippet(el.createDiv({ cls: "unified-search-snippet" }), s.text, this.lastTokens);
  }

  onChooseSuggestion(s: Suggestion): void {
    if (s.kind === "history") {
      // 回填查询词并触发重新搜索：SuggestModal 监听 input 事件
      this.inputEl.value = s.query;
      this.inputEl.dispatchEvent(new Event("input"));
      return;
    }
    this.recordHistory(this.inputEl.value.trim());
    // ext 域命中:绝对路径——能映射进 vault 的内部打开,否则系统默认应用
    if (s.kind === "ext") {
      const rel = this.toVaultRelative(s.path);
      const file = rel ? this.plugin.app.vault.getAbstractFileByPath(rel) : null;
      if (file instanceof TFile) {
        this.openFileReuse(file);
        return;
      }
      openExternal(s.path);
      return;
    }
    // 外部源命中：能用 Obsidian 打开的（库内文件）就内部打开，否则交给系统
    if (s.kind === "external") {
      const rel = this.toVaultRelative(s.path);
      const file = rel ? this.plugin.app.vault.getAbstractFileByPath(rel) : null;
      if (file instanceof TFile) {
        this.openFileReuse(file);
        return;
      }
      openExternal(s.path);
      return;
    }
    // daemon 块命中：带 block_id 的用 #^锚点打开（锚点解析不出时回落开文件）
    if (!s.path) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(s.path);
    if (file instanceof TFile) {
      if (s.blockId) {
        void this.plugin.app.workspace.openLinkText(`${s.path}#^${s.blockId}`, "");
      } else {
        this.openFileReuse(file);
      }
    }
  }

  /**
   * 打开文件：已打开的（含库外挂载文件在库内的映射）直接激活原标签，不再新建。
   * 原实现每次都 `getLeaf("tab").openFile()`，反复点同一条结果会堆出一排重复
   * 标签页（2026-10-24）。
   */
  private openFileReuse(file: TFile): void {
    const ws = this.plugin.app.workspace;
    const existing = ws
      .getLeavesOfType("markdown")
      .find((l) => (l.view as unknown as { file?: TFile }).file?.path === file.path);
    if (existing) {
      void ws.setActiveLeaf(existing, { focus: true });
      return;
    }
    void ws.getLeaf("tab").openFile(file);
  }

  /** 绝对路径 → vault 相对路径（不属于本库返回 null） */
  private toVaultRelative(abs: string): string | null {
    const base = (this.plugin.app.vault.adapter as unknown as { basePath?: string }).basePath;
    if (!base) return null;
    const normBase = base.replace(/\\/g, "/").replace(/\/+$/, "");
    const normAbs = abs.replace(/\\/g, "/");
    if (!normAbs.toLowerCase().startsWith(normBase.toLowerCase() + "/")) return null;
    return normAbs.slice(normBase.length + 1);
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

/** 系统默认应用打开（Electron shell；不可用时静默失败） */
function openExternal(path: string): void {
  const shell = (
    (window as unknown as { require?: (m: string) => unknown }).require?.("electron") as
      | { shell?: { openPath(p: string): Promise<string> } }
      | undefined
  )?.shell;
  if (shell) void shell.openPath(path);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
