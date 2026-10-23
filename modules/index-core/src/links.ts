/**
 * 统一索引 · 全域 links（设计 §2/§4.4）。
 *
 * 双向链的索引侧：写文件时提取全部链接，落 links 表（raw 原文 + resolve_key
 * 小写目标键）；能立即解析就填 target_*，解析不了留 resolved=0（悬空）。
 * 之后任何文件落地（新增/改名），按 resolve_key 部分索引 O(log n) 回查补解析。
 * 名字解析经 names 表：basename(lower) → 文件级 item，vault(0) 优先 ext(1)。
 *
 * M1 只做 md/org 的链接语法；解析粒度是文件级（target_item = target_root =
 * 目标文件的文件级 item）。块级锚点解析（#^block-id）等块级拆分（M2）。
 */

import type { SqliteService } from "./sqlite-service";

export type LinkKind = "wiki" | "md" | "embed" | "blockref";

export interface RawLink {
  /** 原样链接文本（[[a|b]] 整体），诊断用 */
  raw: string;
  kind: LinkKind;
  /** 目标（去别名、去锚点前） */
  target: string;
  /** # 后的锚点（块 id / 标题），M1 仅存不用 */
  anchor?: string;
}

/** 外部协议：不进链接表 */
const EXTERNAL_RE = /^(https?:|mailto:|obsidian:|file:\/\/|#|zotero:)/i;

/** md wiki/embed/blockref：[[target]]、[[target|alias]]、![[target]]、[[target#^id]] */
const WIKI_RE = /(!?)\[\[([^\][|]+)(?:\|([^\][]*))?\]\]/g;
/** org 括号链接：[[target][desc]]（logseq org 文件同款） */
const ORG_RE = /\[\[([^\][[]+)\]\[([^\][]*)\]\]/g;
/** md 行内链接：[text](target)——排除外部协议；![alt](path) 记 embed */
const MD_RE = /(!?)\[[^\][]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** 提取一个文件的全部链接（含去重：同目标多次出现只记一条，M1 不做逐出现计数） */
export function parseLinks(content: string, format: "md" | "org"): RawLink[] {
  const seen = new Set<string>();
  const out: RawLink[] = [];
  const push = (raw: string, kind: LinkKind, fullTarget: string) => {
    const t = fullTarget.trim();
    if (!t || EXTERNAL_RE.test(t)) return;
    const hash = t.indexOf("#");
    const target = hash === 0 ? t : t.slice(0, hash === -1 ? t.length : hash);
    const anchor = hash === -1 ? undefined : t.slice(hash + 1);
    if (!target.trim() && !anchor) return;
    // 块引用（#^id）单独记 kind，锚点是身份主体
    const k: LinkKind = anchor && anchor.startsWith("^") ? "blockref" : kind;
    const key = `${k}|${target}|${anchor ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ raw, kind: k, target: target.trim(), anchor });
  };

  if (format === "org") {
    for (const m of content.matchAll(ORG_RE)) push(m[0], "wiki", m[1]);
  }
  for (const m of content.matchAll(WIKI_RE)) push(m[0], m[1] ? "embed" : "wiki", m[2]);
  for (const m of content.matchAll(MD_RE)) push(m[0], m[1] ? "embed" : "md", m[2]);
  return out;
}

/** 目标 → 解析键（小写；路径或 basename 统一走它，供悬空回查索引） */
export function resolveKeyOf(target: string): string {
  let t = target.trim().replace(/\\/g, "/");
  if (t.startsWith("file://")) t = t.slice(7);
  try {
    if (/%[0-9a-f]{2}/i.test(t)) t = decodeURIComponent(t);
  } catch {
    // 畸形编码保持原样
  }
  const hash = t.indexOf("#");
  if (hash !== -1) t = t.slice(0, hash); // 容错：调用方漏剥的锚点在这兜住
  return t.toLowerCase();
}

/** 键 → 名字表查找键（basename，无扩展名，小写） */
function basenameKey(key: string): string {
  const base = key.split("/").pop() ?? key;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

/** 解析结果（文件级 item 的定位信息） */
interface Resolved {
  targetPath: string;
  targetItem: number;
}

export class LinkResolver {
  constructor(private readonly svc: SqliteService) {}

  /**
   * 单条链接落表：先按当前全库立即解析（files.path 精确 → names basename），
   * 解析不了留悬空（resolve_key 已备好，等目标文件落地回查）。
   */
  insertLinks(itemRowid: number, links: RawLink[]): void {
    if (!links.length) return;
    const insert = this.svc.prepare(
      `INSERT INTO links (src_item, raw, target_path, target_item, target_root, anchor, kind, resolved, resolve_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of links) {
      const key = resolveKeyOf(l.target);
      const hit = this.resolveKey(key);
      insert.run(
        itemRowid,
        l.raw,
        hit?.targetPath ?? null,
        hit?.targetItem ?? null,
        hit?.targetItem ?? null, // M1 文件级 item：target_root 同 target_item
        l.anchor ?? null,
        l.kind,
        hit ? 1 : 0,
        key,
      );
    }
  }

  /** 解析键 → 目标。相对路径精确匹配优先，其次 names（vault 0 > ext 1） */
  private resolveKey(key: string): Resolved | null {
    const byPath = this.svc.prepare("SELECT path, rowid FROM files WHERE lower(path) = ? LIMIT 1").get(key) as
      | { path: string; rowid: number }
      | undefined;
    if (byPath) {
      const item = this.fileLevelItem(byPath.rowid);
      if (item) return { targetPath: byPath.path, targetItem: item };
    }
    const byName = this.svc
      .prepare("SELECT item_rowid FROM names WHERE name = ? ORDER BY precedence, item_rowid LIMIT 1")
      .get(basenameKey(key)) as { item_rowid: number } | undefined;
    if (byName) {
      const path = this.svc
        .prepare("SELECT f.path FROM files f JOIN items i ON i.file_rowid = f.rowid WHERE i.rowid = ?")
        .get(byName.item_rowid) as { path: string } | undefined;
      if (path) return { targetPath: path.path, targetItem: byName.item_rowid };
    }
    return null;
  }

  /** 文件级 item 的 rowid（M1 每文件一个 item，即 file_rowid 下唯一 item） */
  private fileLevelItem(fileRowid: number): number | null {
    const row = this.svc.prepare("SELECT rowid FROM items WHERE file_rowid = ? LIMIT 1").get(fileRowid) as
      | { rowid: number }
      | undefined;
    return row?.rowid ?? null;
  }

  /**
   * 悬空回查：一个文件落地（新增/改名）后，凡 resolve_key 命中它的
   * 路径或 basename 的未解析链接全部补解析（走 idx_links_rkey 部分索引）。
   */
  resolvePendingFor(path: string, title: string): void {
    const norm = path.trim().replace(/\\/g, "/").toLowerCase();
    const base = basenameKey(norm) || title.toLowerCase();
    // 带扩展名 basename：`![[pic.png]]`/`[[note.md]]` 的 resolve_key 是它，
    // 附件场景两头对不上就永远悬空（测试抓过）
    const baseExt = norm.split("/").pop() ?? "";
    const keys = new Set([norm, base, baseExt].filter(Boolean));
    const fileRow = this.svc.prepare("SELECT rowid, path FROM files WHERE lower(path) = ?").get(norm) as
      | { rowid: number; path: string }
      | undefined;
    if (!fileRow) return;
    const item = this.fileLevelItem(fileRow.rowid);
    if (!item) return;
    const upd = this.svc.prepare(
      `UPDATE links SET target_path = ?, target_item = ?, target_root = ?, resolved = 1
       WHERE resolved = 0 AND resolve_key = ?`,
    );
    for (const k of keys) upd.run(fileRow.path, item, item, k);
  }

  /** 全量补解析（重建/回填后入口）：逐唯一 resolve_key 解析并回写 */
  resolveAllPending(): void {
    const keys = this.svc
      .prepare("SELECT DISTINCT resolve_key AS k FROM links WHERE resolved = 0")
      .all() as Array<{ k: string | null }>;
    const upd = this.svc.prepare(
      `UPDATE links SET target_path = ?, target_item = ?, target_root = ?, resolved = 1
       WHERE resolved = 0 AND resolve_key = ?`,
    );
    for (const { k } of keys) {
      if (!k) continue;
      const hit = this.resolveKey(k);
      if (hit) upd.run(hit.targetPath, hit.targetItem, hit.targetItem, k);
    }
  }
}
