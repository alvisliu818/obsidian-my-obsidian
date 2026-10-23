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
  constructor(
    private readonly svc: SqliteService,
    private readonly tokenizeOpts: TokenizeOptions,
  ) {}

  /** 覆盖式写入一个文件（全删全插）。内容未变（hash 门）时零写入 */
  upsertFile(meta: FileMeta, rawContent: string): UpsertResult {
    const fileHash = contentHash(rawContent);
    const prev = this.svc.prepare("SELECT content_hash FROM sync_state WHERE path = ?").get(
      meta.path,
    ) as { content_hash: string } | undefined;
    if (prev && prev.content_hash === fileHash) return { skipped: true };

    this.svc.transaction(() => {
      const existing = this.svc.prepare("SELECT rowid FROM files WHERE path = ?").get(meta.path) as
        | { rowid: number }
        | undefined;
      let fileRowid: number;
      if (existing) {
        fileRowid = existing.rowid;
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
      this.insertItem(fileRowid, {
        title: meta.title,
        content: rawContent,
        format: meta.ext === "org" ? "org" : "md",
        mtime: meta.mtime,
      });
      this.svc
        .prepare("INSERT OR REPLACE INTO sync_state (path, content_hash, indexed_at) VALUES (?, ?, ?)")
        .run(meta.path, fileHash, Date.now());
    });
    return { skipped: false };
  }

  removeFile(path: string): void {
    this.svc.transaction(() => {
      // 级联清 items/links，FTS 随触发器退场
      this.svc.prepare("DELETE FROM files WHERE path = ?").run(path);
      this.svc.prepare("DELETE FROM sync_state WHERE path = ?").run(path);
    });
  }

  /** 全库清空（重建入口，M2 用） */
  clearAll(): void {
    this.svc.transaction(() => {
      this.svc.prepare("DELETE FROM files").run();
      this.svc.prepare("DELETE FROM sync_state").run();
    });
  }

  private insertItem(fileRowid: number, item: ItemInput): void {
    const t = (text: string) => tokenizeForIndexing(text, this.tokenizeOpts).join(" ");
    const tTitle = t(item.title);
    const tHeadings = t(extractHeadings(item.content).join("\n"));
    const tTags = t(extractTags(item.content).join(" "));
    const tContent = t(item.content);
    // t_* 一律写空串而非 NULL：FTS external-content 的 insert/delete 路径
    // 必须看到同一份列值（触发器对称）
    this.svc
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
  }
}
