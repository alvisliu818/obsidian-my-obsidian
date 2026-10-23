/**
 * 统一索引 · 写入端。
 *
 * 同步语义（docs/unified-index-design.md §4）：
 *  - 权威 = 磁盘文件，库是可重建投影
 *  - 变更门 = content_hash（FNV-1a+len，防同步盘 mtime 抖动），未变即跳过
 *  - 增量单位 = 一个文件 = 一个事务：删旧 items（级联 links、FTS 触发器退场）
 *    → 插新 → 更新 sync_state，同事务原子完成
 *  - FTS 同步全部由 items 上的触发器完成，写入端**不得**直接触碰 items_fts
 *
 * M1 粒度：整文件一个 item（t_title=文件名、t_headings=标题行、t_tags=标签）。
 * items 的 parent_rowid/ord/block_id 已为块级拆分（M2）备好。
 */

import { contentHash } from "./fnv";
import { tokenizeForIndexing, type TokenizeOptions } from "./tokenize";
import { LinkResolver, parseLinks, resolveKeyOf } from "./links";
import type { SqliteService } from "./sqlite-service";

export interface FileMeta {
  /** vault 相对路径 / ext 域的绝对路径 */
  path: string;
  domain: "vault" | "ext";
  mtime: number;
  size: number;
  /** 小写无点扩展名 */
  ext: string;
  /** 文件名（不含扩展名） */
  title: string;
}

export interface UpsertResult {
  /** true = hash 门判定未变更，跳过写入 */
  skipped: boolean;
}

/** md 标题行 / org 星标行 */
const HEADING_RE = /^[ \t]*(?:#{1,6}\s+(.+)|\*{1,6}\s+(.+))$/gm;
/** 行内 hashtag（# 前需空白/起始/括号，同 Obsidian；行中紧贴不命中） */
const TAG_RE = /(^|[\s(（【\[])#([^\s#。，、！？：；""''（）()【】\]]+)/gu;

export function extractHeadings(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(HEADING_RE)) out.push(m[1] ?? m[2] ?? "");
  return out;
}

export function extractTags(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(TAG_RE)) out.push(m[2]);
  return out;
}

export interface ItemInput {
  /** 文件级 item = 文件名；块级 item = 块首行（M2） */
  title: string;
  content: string;
  format: "md" | "org";
  mtime: number;
  /** M2 块级拆分用；M1 整文件 item 不传 */
  blockId?: string | null;
  parentRowid?: number | null;
  ord?: number;
}

export class IndexWriter {
  private readonly resolver: LinkResolver;

  constructor(
    private readonly svc: SqliteService,
    private readonly tokenizeOpts: TokenizeOptions,
  ) {
    this.resolver = new LinkResolver(svc);
  }

  /**
   * stat 门（设计 §4.3：size → mtime 先于 content_hash）：files 表里记的
   * mtime/size 与当前一致 → 内容必然已索引，调用方**免读文件**。启动扫描
   * 全量重读盘（网盘上 1.2 万文件）就是漏了这层门导致的。
   * size 未提供（ext 域清单只有 mtime）时只比 mtime。
   */
  statUnchanged(path: string, mtime: number, size?: number): boolean {
    const row = this.svc.prepare("SELECT mtime, size FROM files WHERE path = ?").get(path) as
      | { mtime: number | null; size: number | null }
      | undefined;
    if (!row || row.mtime === null || row.mtime !== mtime) return false;
    if (size !== undefined && row.size !== null && row.size !== size) return false;
    return true;
  }

  /** 覆盖式写入一个文件（全删全插）。内容未变（hash 门）时零写入 */
  upsertFile(meta: FileMeta, rawContent: string): UpsertResult {
    const fileHash = contentHash(rawContent);
    const prev = this.svc.prepare("SELECT content_hash FROM sync_state WHERE path = ?").get(
      meta.path,
    ) as { content_hash: string } | undefined;
    if (prev && prev.content_hash === fileHash) {
      // mtime/size 与库内不一致（同步盘 touch、mtime 抖动）：回写一行让
      // statUnchanged 收敛——否则这种文件每次启动都会被重读+重 hash。
      // 只动 files 行，不碰 items（UPDATE 会触发 FTS 触发器，代价不成比例）。
      const stat = this.svc.prepare("SELECT mtime, size FROM files WHERE path = ?").get(meta.path) as
        | { mtime: number | null; size: number | null }
        | undefined;
      if (stat && (stat.mtime !== meta.mtime || stat.size !== meta.size)) {
        this.svc.prepare("UPDATE files SET mtime = ?, size = ? WHERE path = ?").run(
          meta.mtime,
          meta.size,
          meta.path,
        );
      }
      return { skipped: true };
    }

    this.svc.transaction(() => {
      const existing = this.svc.prepare("SELECT rowid FROM files WHERE path = ?").get(meta.path) as
        | { rowid: number }
        | undefined;
      let fileRowid: number;
      if (existing) {
        fileRowid = existing.rowid;
        // names 无外键：先于 items 删除手工清理（否则悬空 names 行）
        this.svc
          .prepare("DELETE FROM names WHERE item_rowid IN (SELECT rowid FROM items WHERE file_rowid = ?)")
          .run(fileRowid);
        // 指向旧 items 的入链退回悬空（rowid 将全部更换）
        this.svc
          .prepare(
            `UPDATE links SET resolved = 0, target_path = NULL, target_item = NULL, target_root = NULL
             WHERE resolved = 1 AND target_item IN (SELECT rowid FROM items WHERE file_rowid = ?)`,
          )
          .run(fileRowid);
        // 删旧 items：级联清 links，FTS 随 AFTER DELETE 触发器退场
        this.svc.prepare("DELETE FROM items WHERE file_rowid = ?").run(fileRowid);
        this.svc.prepare("UPDATE files SET mtime=?, size=?, ext=?, title=? WHERE rowid=?").run(
          meta.mtime,
          meta.size,
          meta.ext,
          meta.title,
          fileRowid,
        );
      } else {
        const info = this.svc
          .prepare(
            "INSERT INTO files (path, domain, mtime, size, ext, title) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(meta.path, meta.domain, meta.mtime, meta.size, meta.ext, meta.title);
        fileRowid = Number(info.lastInsertRowid);
      }
      const itemRowid = this.insertItem(fileRowid, {
        title: meta.title,
        content: rawContent,
        format: meta.ext === "org" ? "org" : "md",
        mtime: meta.mtime,
      });
      // 名字解析表：basename(lower) → 文件级 item，vault(0) 优先 ext(1)
      this.svc
        .prepare("INSERT INTO names (name, original, item_rowid, precedence) VALUES (?, ?, ?, ?)")
        .run(meta.title.toLowerCase(), meta.title, itemRowid, meta.domain === "vault" ? 0 : 1);
      // 全域 links：提取 + 立即解析 + 悬空留待回查
      this.resolver.insertLinks(itemRowid, parseLinks(rawContent, meta.ext === "org" ? "org" : "md"));
      // 本文件落地可能正好补上别人的悬空链接（新增/改名回查）
      this.resolver.resolvePendingFor(meta.path, meta.title);
      this.svc
        .prepare("INSERT OR REPLACE INTO sync_state (path, content_hash, indexed_at) VALUES (?, ?, ?)")
        .run(meta.path, fileHash, Date.now());
    });
    return { skipped: false };
  }

  removeFile(path: string): void {
    this.svc.transaction(() => {
      // names 无外键，先手工清（须在 files 删除、items 级联消失之前）
      this.svc
        .prepare(
          "DELETE FROM names WHERE item_rowid IN (SELECT rowid FROM items WHERE file_rowid = (SELECT rowid FROM files WHERE path = ?))",
        )
        .run(path);
      // 指向被删文件的入链退回悬空（设计 §4.4：删除留 raw 等 re-resolve）
      this.svc
        .prepare(
          `UPDATE links SET resolved = 0, target_path = NULL, target_item = NULL, target_root = NULL
           WHERE resolved = 1 AND target_item IN (SELECT rowid FROM items WHERE file_rowid = (SELECT rowid FROM files WHERE path = ?))`,
        )
        .run(path);
      // 级联清 items/links，FTS 随触发器退场
      this.svc.prepare("DELETE FROM files WHERE path = ?").run(path);
      this.svc.prepare("DELETE FROM sync_state WHERE path = ?").run(path);
    });
  }

  /** 全库清空（重建入口，M2 用） */
  clearAll(): void {
    this.svc.transaction(() => {
      this.svc.prepare("DELETE FROM names").run();
      this.svc.prepare("DELETE FROM files").run();
      this.svc.prepare("DELETE FROM sync_state").run();
    });
  }

  /**
   * v2 升级补齐：存量 items 的 links/names（内容已在库，不重读文件）。
   * hash 门会让老文件在扫描时全跳过——不补的话 links 表永远为空。
   * 三步：全量 names → 按 rowid 分块落 raw+resolve_key（流式防内存爆）→
   * resolveAllPending 统一补解析。幂等（meta 门）。
   */
  backfillLinks(): void {
    if (this.svc.metaGet("links_v2") === "1") return;
    const t0 = Date.now();
    this.svc.transaction(() => {
      this.svc.prepare("DELETE FROM links").run();
      this.svc.prepare("DELETE FROM names").run();
      const insertName = this.svc.prepare(
        "INSERT INTO names (name, original, item_rowid, precedence) VALUES (?, ?, ?, ?)",
      );
      const insertLink = this.svc.prepare(
        `INSERT INTO links (src_item, raw, anchor, kind, resolved, resolve_key)
         VALUES (?, ?, ?, ?, 0, ?)`,
      );
      const CHUNK = 500;
      // 第一遍：全量 names（basename 解析要跨文件，必须先齐）
      let last = 0;
      for (;;) {
        const rows = this.svc
          .prepare(
            `SELECT i.rowid AS rid, f.title AS title, f.domain AS domain
             FROM items i JOIN files f ON f.rowid = i.file_rowid
             WHERE i.rowid > ? ORDER BY i.rowid LIMIT ?`,
          )
          .all(last, CHUNK) as Array<{ rid: number; title: string; domain: string }>;
        if (!rows.length) break;
        for (const r of rows) {
          last = r.rid;
          insertName.run(r.title.toLowerCase(), r.title, r.rid, r.domain === "vault" ? 0 : 1);
        }
      }
      // 第二遍：落 raw + resolve_key（解析延后统一做）
      last = 0;
      for (;;) {
        const rows = this.svc
          .prepare(
            "SELECT rowid AS rid, content AS content, format AS format FROM items WHERE rowid > ? ORDER BY rowid LIMIT ?",
          )
          .all(last, CHUNK) as Array<{ rid: number; content: string; format: string }>;
        if (!rows.length) break;
        for (const r of rows) {
          last = r.rid;
          for (const l of parseLinks(r.content, r.format === "org" ? "org" : "md")) {
            insertLink.run(r.rid, l.raw, l.anchor ?? null, l.kind, resolveKeyOf(l.target));
          }
        }
      }
      // 第三遍：复用解析器，按唯一 key 补解析
      this.resolver.resolveAllPending();
      this.svc.metaSet("links_v2", "1");
    });
    console.debug(`[unified-search] links 回填完成 ${Date.now() - t0}ms`);
  }

  private insertItem(fileRowid: number, item: ItemInput): number {
    const t = (text: string) => tokenizeForIndexing(text, this.tokenizeOpts).join(" ");
    const tTitle = t(item.title);
    const tHeadings = t(extractHeadings(item.content).join("\n"));
    const tTags = t(extractTags(item.content).join(" "));
    const tContent = t(item.content);
    // t_* 一律写空串而非 NULL：FTS external-content 的 insert/delete 路径
    // 必须看到同一份列值（触发器对称）
    const info = this.svc
      .prepare(
        `INSERT INTO items (file_rowid, block_id, parent_rowid, ord, content,
         t_title, t_headings, t_tags, t_content, format, content_hash, mtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fileRowid,
        item.blockId ?? null,
        item.parentRowid ?? null,
        item.ord ?? 0,
        item.content,
        tTitle,
        tHeadings,
        tTags,
        tContent,
        item.format,
        contentHash(item.content),
        item.mtime,
      );
    return Number(info.lastInsertRowid);
  }
}
