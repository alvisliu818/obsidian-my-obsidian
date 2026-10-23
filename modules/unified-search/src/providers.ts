/**
 * 外部搜索引擎接入（Everything 文件名 / AnyTXT 全文）。
 *
 * 两者都是本机常驻服务，走 HTTP，与磁盘索引（index-core）互补：
 *  - Everything：**文件名**秒搜全盘（NTFS 索引），但搜不了内容；
 *  - AnyTXT：**文件内容**全文（含 docx/pdf/图片 OCR），但索引要自己维护；
 *  - 本插件的 SQLite 索引：vault 内 md/org + 挂载文本，可控、可增量。
 *
 * 纪律：外部源一律**带超时 + 失败静默**。工具没开/没索引/端口不对都不能拖慢
 * 或打断本地搜索——这也是为什么每个 provider 都自带 AbortController。
 *
 * 接口要点（2026-10-24 实测本机）：
 *  - Everything：需先在 Everything 里启用 HTTP 服务器（工具→选项→HTTP 服务器）。
 *    `GET {base}/?s=&j=1&path_column=1&size_column=1&date_modified_column=1&c=`；
 *    JSON 里 path 是**目录**，完整路径要 path + name 拼。
 *  - AnyTXT：ATGUI 进程内 JSON-RPC（默认 9920，fallback 9921）。method 必须带
 *    服务前缀 `ATRpcServer.Searcher.V1.`；`Search` 只回 count，**取列表要用
 *    `GetResult`**（limit/offset/order），片段用 `GetFragment`（fid + pattern）。
 */

export type ExternalSource = "everything" | "anytxt";

export interface ExternalHit {
  source: ExternalSource;
  /** 完整路径（Everything 由 path+name 拼出；AnyTXT 直接给绝对路径） */
  path: string;
  name: string;
  size?: number;
  /** 毫秒时间戳 */
  mtime?: number;
  /** AnyTXT 的匹配片段（开启「取片段」时才有） */
  snippet?: string;
}

const DEFAULT_TIMEOUT = 2500;

async function fetchJson(url: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Everything HTTP 基本鉴权（设置里可选填用户名/密码） */
function authHeader(user: string, pass: string): Record<string, string> {
  if (!user && !pass) return {};
  const raw = `${user}:${pass}`;
  const b64 =
    typeof btoa === "function" ? btoa(raw) : Buffer.from(raw, "utf8").toString("base64");
  return { Authorization: `Basic ${b64}` };
}

export interface EverythingOptions {
  /** 形如 http://127.0.0.1:8080 */
  baseUrl: string;
  limit: number;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

/**
 * Everything 文件名搜索。查询串原样传给 Everything（它自己的语法：空格 AND、
 * `|` OR、`!` NOT、通配符 `*`），中文由 URLSearchParams 负责编码。
 */
export async function searchEverything(
  query: string,
  opts: EverythingOptions,
): Promise<ExternalHit[]> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const url =
    `${base}/?s=${encodeURIComponent(query)}&j=1&path_column=1&size_column=1` +
    `&date_modified_column=1&c=${Math.max(1, opts.limit)}&sort=date_modified&ascending=0`;
  const data = (await fetchJson(
    url,
    { headers: authHeader(opts.username ?? "", opts.password ?? "") },
    opts.timeoutMs,
  )) as { results?: Array<Record<string, unknown>> } | null;
  const rows = data?.results ?? [];
  const out: ExternalHit[] = [];
  for (const r of rows) {
    const name = String(r.name ?? "");
    const dir = String(r.path ?? "");
    if (!name) continue;
    // path_column=1 给的是父目录：拼出完整路径（目录项也照拼，打开时系统处理）
    const full = dir ? `${dir.replace(/[\\/]+$/, "")}\\${name}` : name;
    const size = Number(r.size);
    const dm = Number(r.date_modified);
    out.push({
      source: "everything",
      path: full,
      name,
      size: Number.isFinite(size) && size > 0 ? size : undefined,
      // Everything 的 date_modified 是 FILETIME（100ns since 1601）或 Unix？两种都兼容
      mtime: normalizeFiletime(dm),
    });
  }
  return out;
}

/** Everything 的 date_modified 通常是 FILETIME；落在 Unix 量级时按秒换算 */
function normalizeFiletime(v: number): number | undefined {
  if (!Number.isFinite(v) || v <= 0) return undefined;
  if (v > 1e17) return Math.round((v - 116444736000000000) / 10000); // FILETIME → ms
  if (v > 1e12) return v; // 已是毫秒
  if (v > 1e9) return Math.round(v * 1000); // 秒
  return undefined;
}

const ANYTXT_RPC = "ATRpcServer.Searcher.V1.";

export interface AnyTxtOptions {
  /** 形如 http://127.0.0.1:9920 */
  url: string;
  limit: number;
  /** 目录过滤，如 "E:" 或 "E:\\notes"；留空则用服务端默认（实测默认 C:） */
  filterDir?: string;
  /** 扩展名过滤，如 "*.md" 或 "doc;pdf"；留空 = "*" */
  filterExt?: string;
  /** 额外取内容片段（每条一次 GetFragment 请求，只对前 N 条做） */
  withSnippet?: boolean;
  snippetCount?: number;
  timeoutMs?: number;
}

async function anytxtRpc(
  url: string,
  method: string,
  input: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<Record<string, unknown> | null> {
  const payload = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: ANYTXT_RPC + method,
    params: { input },
  };
  const data = (await fetchJson(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  )) as { result?: { data?: { output?: Record<string, unknown> } }; error?: unknown } | null;
  if (!data) return null;
  if (data.error) return null;
  return data.result?.data?.output ?? null;
}

/** AnyTXT 全文搜索：GetResult 一次拿到文件列表（Search 只回计数，不够用） */
export async function searchAnyTxt(query: string, opts: AnyTxtOptions): Promise<ExternalHit[]> {
  const output = await anytxtRpc(
    opts.url,
    "GetResult",
    {
      pattern: query,
      filterDir: opts.filterDir || "",
      filterExt: opts.filterExt || "*",
      lastModifyBegin: 0,
      lastModifyEnd: 2147483647,
      limit: Math.max(1, opts.limit),
      offset: 0,
      order: 2, // lastModify DESC
    },
    opts.timeoutMs,
  );
  // files 有两种形态（实测 1.3.x 给的是**二维数组 + field 表头**，老版本给对象
  // 数组）：两种都兼容，否则整个结果集会被静默丢弃
  const field = (output?.field as string[] | undefined) ?? [];
  const rows = (output?.files as Array<unknown> | undefined) ?? [];
  const out = new Map<string, ExternalHit & { fid?: string }>();
  for (const raw of rows) {
    const rec: Record<string, unknown> = Array.isArray(raw)
      ? Object.fromEntries(field.map((k, i) => [k, (raw as unknown[])[i]]))
      : (raw as Record<string, unknown>);
    const path = String(rec.file ?? rec.path ?? "");
    if (!path) continue;
    const size = Number(rec.size);
    const lm = Number(rec.lastModify);
    const hit: ExternalHit & { fid?: string } = {
      source: "anytxt",
      path,
      name: path.split(/[\\/]/).pop() ?? path,
      size: Number.isFinite(size) ? size : undefined,
      mtime: lm > 1e12 ? lm : lm > 1e9 ? Math.round(lm * 1000) : undefined,
      fid: String(rec.fid ?? ""),
    };
    out.set(path, hit);
  }
  const hits = [...out.values()];
  // 片段：每条一次 RPC，只对前几条做（多了会明显变慢）
  if (opts.withSnippet) {
    const n = Math.min(hits.length, opts.snippetCount ?? 5);
    await Promise.all(
      hits.slice(0, n).map(async (hit) => {
        if (!hit.fid) return;
        const frag = await anytxtRpc(opts.url, "GetFragment", { fid: hit.fid, pattern: query }, opts.timeoutMs);
        const text = frag?.text;
        if (typeof text === "string" && text) hit.snippet = text.replace(/\s+/g, " ").slice(0, 240);
      }),
    );
  }
  return hits;
}

/** 触发 AnyTXT 索引同步（新文件搜不到时用；无返回体，失败静默） */
export async function syncAnyTxtIndex(url: string, folder = ""): Promise<boolean> {
  const out = await anytxtRpc(url, "SyncIndex", folder ? { folder } : {});
  return out !== null;
}

export interface ExternalSettings {
  everything: { enabled: boolean; baseUrl: string; username: string; password: string; limit: number };
  anytxt: { enabled: boolean; url: string; filterDir: string; filterExt: string; limit: number; snippet: boolean };
}

/**
 * 并行跑所有启用的外部源。单个源失败返回空数组（不抛）——工具没开是常态，
 * 绝不能影响本地索引搜索。
 */
export async function searchExternal(
  query: string,
  s: ExternalSettings,
): Promise<ExternalHit[]> {
  const jobs: Array<Promise<ExternalHit[]>> = [];
  if (s.everything.enabled && s.everything.baseUrl) {
    jobs.push(
      searchEverything(query, {
        baseUrl: s.everything.baseUrl,
        limit: s.everything.limit,
        username: s.everything.username,
        password: s.everything.password,
      }).catch(() => [] as ExternalHit[]),
    );
  }
  if (s.anytxt.enabled && s.anytxt.url) {
    jobs.push(
      searchAnyTxt(query, {
        url: s.anytxt.url,
        limit: s.anytxt.limit,
        filterDir: s.anytxt.filterDir,
        filterExt: s.anytxt.filterExt,
        withSnippet: s.anytxt.snippet,
      }).catch(() => [] as ExternalHit[]),
    );
  }
  if (!jobs.length) return [];
  const groups = await Promise.all(jobs);
  return groups.flat();
}
