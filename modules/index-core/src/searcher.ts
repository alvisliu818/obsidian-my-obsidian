/**
 * 统一索引 · 查询端。
 *
 * 纪律（设计 §5/§10）：
 *  - 列表/命中查询**禁取 content 列**（单行可达 1MB）；content 按 rowid 单查
 *  - bm25 列权重：title 6.0 > tags 5.0 > headings 4.0 > content 1.0
 *  - LIKE 限域兜底：unicode61 中文 2 字子串必漏（探针实证），MATCH 命中不足时
 *    对 items.content 全表 LIKE（万级行可接受），命中追加在 FTS 结果尾部
 *  - recency boost 查询后 JS 组合，不进 SQL
 */

import type { CompiledQuery } from "./query";
import { resolveTarget } from "./links";
import type { SqliteService } from "./sqlite-service";

export interface SearchHit {
  /** items.rowid（content 单查 / 高亮定位用） */
  rowid: number;
  path: string;
  title: string;
  ext: string;
  domain: string;
  mtime: number;
  /** 块级 item 的 block_id（M2-2；文件级 item 为 null）。块命中打开/定位锚点用 */
  blockId: string | null;
  /** 综合得分，越大越好 */
  score: number;
}

export interface SearchOptions {
  /** 返回上限（默认 50） */
  limit?: number;
  /** 90 天线性 recency 加分上限（默认 0.5） */
  recencyBoost?: number;
  /** FTS 命中数低于该值才跑 LIKE 兜底（默认 10；0 = 关闭） */
  likeThreshold?: number;
}

const HIT_FIELDS =
  "i.rowid AS rowid, f.path AS path, f.title AS title, f.ext AS ext, f.domain AS domain, i.mtime AS mtime, i.block_id AS blockId";
const JOINS = "FROM items_fts JOIN items i ON i.rowid = items_fts.rowid JOIN files f ON f.rowid = i.file_rowid";

/** LIKE 通配符转义（配 ESCAPE '\'） */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** node:sqlite 绑定参数类型（不直接 import node:sqlite，保持本模块环境无关） */
type SqlParam = string | number | bigint | null | Uint8Array;

export function search(svc: SqliteService, q: CompiledQuery, options: SearchOptions = {}): SearchHit[] {
  const limit = options.limit ?? 50;
  if (q.isEmpty) return [];
  const recencyBoost = options.recencyBoost ?? 0.5;
  const likeThreshold = options.likeThreshold ?? 10;

  const hits = new Map<number, SearchHit>();
  const filterWhere = (): { where: string[]; params: SqlParam[] } => {
    const where: string[] = [];
    const params: SqlParam[] = [];
    for (const p of q.pathFilters) {
      where.push("f.path LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(p)}%`);
    }
    if (q.extFilters.length) {
      where.push(`(${q.extFilters.map(() => "f.ext = ?").join(" OR ")})`);
      params.push(...q.extFilters);
    }
    // 反链过滤（M2-4）双路：已解析链接按 target_item 命中（idx_links_target），
    // 悬空链接按 resolve_key 命中（idx_links_rkey 部分索引）——目标不存在时
    // 引用它的文档照样能被 backlink: 查到。目标解析不出时 item 参数给 -1（永不命中）
    for (const k of q.backlinkFilters) {
      const hit = resolveTarget(svc, k);
      where.push(
        `(EXISTS (SELECT 1 FROM links l WHERE l.src_item = i.rowid AND ` +
          `((l.resolved = 1 AND l.target_item = ?) OR (l.resolved = 0 AND l.resolve_key = ?))))`,
      );
      params.push(hit?.targetItem ?? -1, k);
    }
    return { where, params };
  };

  if (q.match) {
    const { where, params } = filterWhere();
    where.unshift("items_fts MATCH ?");
    params.unshift(q.match);
    // -bm25 翻转成越大越好；LIMIT 多取一倍给 recency 重排留料
    const rows = svc
      .prepare(
        `SELECT ${HIT_FIELDS}, -bm25(items_fts, 6.0, 4.0, 5.0, 1.0) AS score
         ${JOINS}
         WHERE ${where.join(" AND ")}
         ORDER BY score DESC
         LIMIT ?`,
      )
      .all(...params, limit * 2) as unknown as (SearchHit & { score: number })[];
    for (const r of rows) hits.set(r.rowid, r);
  }

  // 纯过滤查询（只有 path:/ext:/backlink:，无正负词）：直接列文件
  if (!q.match && (q.pathFilters.length || q.extFilters.length || q.backlinkFilters.length)) {
    const { where, params } = filterWhere();
    const rows = svc
      .prepare(
        `SELECT ${HIT_FIELDS}
         FROM items i JOIN files f ON f.rowid = i.file_rowid
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         LIMIT ?`,
      )
      .all(...params, limit) as unknown as Omit<SearchHit, "score">[];
    rows.forEach((r, idx) => hits.set(r.rowid, { ...r, score: -idx }));
  }

  // LIKE 兜底：仅当存在中文兜底触发词且 FTS 命中不足。兜底结果必须满足
  // 完整查询语义：AND 全部正向原文 + NOT 全部排除原文 + 过滤条件，
  // 否则被 NOT 剔除的文档会从兜底「漏」回来。
  if (q.likeTerms.length && hits.size < likeThreshold) {
    const where: string[] = q.positiveTexts.map(() => "i.content LIKE ? ESCAPE '\\'");
    const params: SqlParam[] = q.positiveTexts.map((t) => `%${escapeLike(t)}%`);
    for (const t of q.excludeTexts) {
      where.push("i.content NOT LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(t)}%`);
    }
    const filters = filterWhere();
    where.push(...filters.where);
    params.push(...filters.params);
    const rows = svc
      .prepare(
        `SELECT ${HIT_FIELDS}
         FROM items i JOIN files f ON f.rowid = i.file_rowid
         WHERE ${where.join(" AND ")}
         LIMIT ?`,
      )
      .all(...params, limit) as unknown as Omit<SearchHit, "score">[];
    // 追加在 FTS 结果之后：分数取当前最小值递减
    let tail = hits.size ? Math.min(...[...hits.values()].map((h) => h.score)) : 0;
    for (const r of rows) {
      if (hits.has(r.rowid)) continue;
      hits.set(r.rowid, { ...r, score: --tail });
    }
  }

  // recency：90 天线性衰减加分（mtime 抖动不敏感，量级远小于 bm25 差距）
  const now = Date.now();
  const day = 86_400_000;
  const out = [...hits.values()].map((h) => {
    const ageDays = Math.max(0, (now - h.mtime) / day);
    return { ...h, score: h.score + recencyBoost * Math.max(0, 1 - ageDays / 90) };
  });
  out.sort((a, b) => b.score - a.score);
  // 同文件去重（M2-2）：文件级 item 索引全文，块命中时文件级必然同中——
  // 不去重结果列表双份刷屏。块级命中优先（更精准、打开带锚点），分数取两者
  // 较高者保排名；纯文件级命中维持原样。
  const byPath = new Map<string, SearchHit & { score: number }>();
  for (const h of out) {
    const prev = byPath.get(h.path);
    if (!prev) byPath.set(h.path, h);
    else if (prev.blockId === null && h.blockId !== null) {
      byPath.set(h.path, { ...h, score: Math.max(prev.score, h.score) });
    }
  }
  return [...byPath.values()].slice(0, limit);
}

/** 按 rowid 单查原文（列表查询禁取 content 的配套出口） */
export function getItemContent(svc: SqliteService, rowid: number): string {
  const row = svc.prepare("SELECT content FROM items WHERE rowid = ?").get(rowid) as
    | { content: string }
    | undefined;
  return row?.content ?? "";
}
