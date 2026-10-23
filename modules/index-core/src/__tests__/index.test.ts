import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteService } from "../sqlite-service";
import { IndexWriter, extractHeadings, extractTags, type FileMeta } from "../index-writer";
import { compileQuery, parseQuery } from "../query";
import { getItemContent, search } from "../searcher";
import { hasCJK, tokenizeForIndexing, type ChsSegmenter } from "../tokenize";
import { parseLinks, resolveKeyOf } from "../links";
import { extractBlocks } from "../blocks";
import { SCHEMA_VERSION } from "../schema";

const dirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "idx-core-idx-"));
  dirs.push(d);
  return d;
}

/** 测试文件元数据（path 必填，其余可覆盖） */
function meta(partial: Partial<FileMeta> & { path: string }): FileMeta {
  const title = partial.title ?? partial.path.split("/").pop()!.replace(/\.\w+$/, "");
  return {
    domain: "vault",
    mtime: Date.now(),
    size: 100,
    ext: partial.path.split(".").pop()!.toLowerCase(),
    title,
    ...partial,
  };
}
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows 句柄残留，忽略
    }
  }
});

/** 确定性假中文分词器：2 字滑窗 + 末字 + 整词（近似 cm-chs-patch search 模式） */
const fakeSegmenter: ChsSegmenter = {
  cut: (word: string) => {
    const chunks: string[] = [];
    for (let i = 0; i + 2 <= word.length; i += 2) chunks.push(word.slice(i, i + 2));
    if (word.length % 2 === 1) chunks.push(word[word.length - 1]);
    chunks.push(word);
    return [...new Set(chunks)];
  },
};

describe("tokenize", () => {
  it("拉丁词：非字母数字一律分隔（含连字符）", () => {
    expect(tokenizeForIndexing("hello world, foo-bar_baz")).toEqual([
      "hello",
      "world",
      "foo",
      "bar_baz",
    ]);
  });

  it("camelCase 拆分可选项，索引查询共用同一开关", () => {
    expect(tokenizeForIndexing("unifiedIndex")) .toEqual(["unifiedIndex"]);
    expect(tokenizeForIndexing("unifiedIndex", { splitCamel: true })).toEqual([
      "unifiedIndex",
      "unified",
      "Index",
    ]);
  });

  it("CJK 降级：无分词器时内置 bigram（全偏移 2 字滑窗 + 整词）", () => {
    expect(tokenizeForIndexing("黑板报 前端开发")).toEqual([
      "黑板",
      "板报",
      "黑板报",
      "前端",
      "端开",
      "开发",
      "前端开发",
    ]);
    expect(tokenizeForIndexing("中文")).toEqual(["中文"]); // ≤2 字整词即可
    // 奇数长：滑窗到末位 + 整词；去重
    expect(tokenizeForIndexing("一三三")).toEqual(["一三", "三三", "一三三"]);
  });

  it("CJK 分词器：产出子词 + 整词", () => {
    const tokens = tokenizeForIndexing("黑板报", { chsSegmenter: fakeSegmenter });
    expect(tokens).toContain("黑板");
    expect(tokens).toContain("黑板报");
  });

  it("hasCJK", () => {
    expect(hasCJK("中文")).toBe(true);
    expect(hasCJK("latin")).toBe(false);
  });
});

describe("extractHeadings / extractTags", () => {
  it("md 标题与 org 星标", () => {
    expect(extractHeadings("# 一级\n正文\n## 二级\n* org 一级")).toEqual([
      "一级",
      "二级",
      "org 一级",
    ]);
  });
  it("行内 hashtag（行中紧贴不命中，同 Obsidian 规则）", () => {
    expect(extractTags("这是 #项目 以及 (#括号)")).toEqual(["项目", "括号"]);
    expect(extractTags("标签和#紧跟 不算")).toEqual([]);
  });
});

describe("parseQuery", () => {
  it("短语 / 排除 / 前缀 / 字段", () => {
    const terms = parseQuery('前端 -后端 "黑板报 前端" title:索引 tag:项目 path:2024 ext:md uni*');
    expect(terms).toHaveLength(8);
    expect(terms[0]).toMatchObject({ kind: "term", text: "前端", exclude: false });
    expect(terms[1]).toMatchObject({ kind: "term", text: "后端", exclude: true });
    expect(terms[2]).toMatchObject({ kind: "phrase", text: "黑板报 前端", exclude: false });
    expect(terms[3]).toMatchObject({ field: "title", text: "索引" });
    expect(terms[4]).toMatchObject({ field: "tag", text: "项目" });
    expect(terms[5]).toMatchObject({ field: "path", text: "2024" });
    expect(terms[6]).toMatchObject({ field: "ext", text: "md" });
    expect(terms[7]).toMatchObject({ kind: "term", text: "uni", prefix: true });
  });

  it("未知 field 前缀按裸词；未闭合引号吃到串尾", () => {
    expect(parseQuery("my:term")[0]).toMatchObject({ kind: "term", text: "my:term" });
    expect(parseQuery('"abc def')[0]).toMatchObject({ kind: "phrase", text: "abc def" });
  });
});

describe("compileQuery", () => {
  it("LIKE 兜底候选：仅 ≤2 字中文（单字必漏进兜底；≥3 字靠 bigram 命中 FTS，不再兜底）", () => {
    expect(compileQuery("黑板").likeTerms).toEqual(["黑板"]);
    expect(compileQuery("板").likeTerms).toEqual(["板"]); // 单字
    expect(compileQuery("前端开发").likeTerms).toEqual([]); // bigram 覆盖
    expect(compileQuery("前端开发", { chsSegmenter: fakeSegmenter }).likeTerms).toEqual([]);
  });

  it("纯过滤查询 match 为 null，非空判定正确", () => {
    const q = compileQuery("path:2024 ext:md");
    expect(q.match).toBeNull();
    expect(q.isEmpty).toBe(false);
    expect(compileQuery("   ").isEmpty).toBe(true);
  });

  it("前缀仅 title/tags 列展开", () => {
    const q = compileQuery("uni*");
    expect(q.match).toContain("t_title");
    expect(q.match).toContain("t_tags");
    expect(q.match).toContain("*");
  });

  it("引号安全：token 内部引号转义、运算符字符被分词剥除", () => {
    const q = compileQuery('foo"bar AND (baz');
    expect(q.match).not.toContain('foo"bar'); // 原样必然不存在
    expect(q.match).toContain('"bar"');
  });

  it("backlink: 解析为反链过滤键（resolveKeyOf 归一：剥锚点、小写）", () => {
    expect(compileQuery("backlink:子dir/目标.md#^x").backlinkFilters).toEqual(["子dir/目标.md"]);
    expect(compileQuery("backlink:目标").match).toBeNull(); // 纯过滤查询
    expect(compileQuery("backlink:目标").isEmpty).toBe(false);
  });
});

describe("parseLinks / resolveKeyOf", () => {
  it("wiki/embed/blockref/md 行内/org 提取；外部协议与纯锚点跳过", () => {
    const links = parseLinks(
      "[[笔记A]] ![[图.png]] [[笔记B#^abc]] [t](./子/笔记C.md) [外](https://x.y) [[#^self]] [[org页][o]]",
      "md",
    );
    const kinds = links.map((l) => `${l.kind}:${l.target}`);
    expect(kinds).toContain("wiki:笔记A");
    expect(kinds).toContain("embed:图.png");
    expect(kinds).toContain("blockref:笔记B");
    expect(kinds).toContain("md:./子/笔记C.md");
    expect(kinds.some((k) => k.includes("x.y"))).toBe(false);
    expect(links.find((l) => l.target === "笔记B")?.anchor).toBe("^abc");
    const org = parseLinks("[[org页][o]]", "org");
    expect(org[0]).toMatchObject({ kind: "wiki", target: "org页" });
  });

  it("resolveKey：反斜杠归一、锚点剥离、小写、URL 解码", () => {
    expect(resolveKeyOf("子dir/笔记 C.md#^x")).toBe("子dir/笔记 c.md");
    expect(resolveKeyOf("A%20B.md")).toBe("a b.md");
  });
});

describe("extractBlocks（M2-2 块级拆分）", () => {
  it("md 列表块：id:: 行提取（剥 ^）、属性行不进 content、无 id 块不产出", () => {
    const content = [
      "alias:: 页属性",
      "- 普通块 无 id",
      "- 有 id 块",
      "  id:: ^abc",
      "  续行内容",
      "- 空行前块",
      "",
      "- 空行后块",
      "  id:: 123e4567-e89b-12d3-a456-426614174000",
    ].join("\n");
    const blocks = extractBlocks(content, "md");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ title: "有 id 块", blockId: "abc" });
    expect(blocks[0].content).toBe("- 有 id 块\n  续行内容");
    expect(blocks[0].content).not.toContain("id::");
    expect(blocks[1].blockId).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("org 星标块：到下一标题收块，id:: 行剥离", () => {
    const blocks = extractBlocks("* 一级\n id:: ^o1\n正文\n** 二级\n id:: ^o2\n** 三级\n", "org");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ title: "一级", blockId: "o1", content: "* 一级\n正文" });
    expect(blocks[1]).toMatchObject({ title: "二级", blockId: "o2", content: "** 二级" });
  });

  it("嵌套列表各自成块；无 id:: 短路返回空；同 id 只保首个；CRLF 尾巴容忍", () => {
    const nested = "- 父\n  id:: ^p\n  - 子\n    id:: ^c\n";
    expect(extractBlocks(nested, "md").map((b) => b.blockId)).toEqual(["p", "c"]);
    expect(extractBlocks("普通 md 没有 id 属性\n- 列表也不拆", "md")).toEqual([]);
    const dup = "- a\n  id:: ^x\n- b\n  id:: ^x\n";
    expect(extractBlocks(dup, "md").map((b) => b.title)).toEqual(["a"]);
    expect(extractBlocks("- win 块\r\n  id:: ^w\r\n", "md")[0]?.blockId).toBe("w");
  });
});

describe("全域 links / names（schema v2）", () => {
  let dbDir: string;
  let svc: SqliteService;
  let writer: IndexWriter;

  beforeEach(() => {
    dbDir = makeDir();
    svc = new SqliteService({ dbDir, vaultSlug: "lk", fingerprint: "fp" });
    writer = new IndexWriter(svc, {});
  });

  const linkRows = () =>
    svc
      .prepare(
        "SELECT l.raw, l.kind, l.resolved, l.target_path, l.target_item, l.resolve_key FROM links l",
      )
      .all() as Array<Record<string, unknown>>;

  it("schema v2：新库带 resolve_key 列；v1 库重开自动迁移", () => {
    expect(svc.metaGet("schema_version")).toBe(String(SCHEMA_VERSION));
    const cols = svc.prepare("PRAGMA table_info(links)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "resolve_key")).toBe(true);
    // 模拟 v1 旧库：去掉列和版本，重开应自动补
    svc.close();
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(path.join(dbDir, "lk.db"));
    raw.exec("DROP INDEX IF EXISTS idx_links_rkey; ALTER TABLE links DROP COLUMN resolve_key;");
    raw.prepare("UPDATE meta SET value='1' WHERE key='schema_version'").run();
    raw.close();
    const svc2 = new SqliteService({ dbDir, vaultSlug: "lk", fingerprint: "fp" });
    const cols2 = svc2.prepare("PRAGMA table_info(links)").all() as Array<{ name: string }>;
    expect(cols2.some((c) => c.name === "resolve_key")).toBe(true);
    svc2.close();
  });

  it("链接立即解析（路径精确与 basename）+ vault 优先 ext", () => {
    writer.upsertFile(meta({ path: "notes/目标.md", title: "目标" }), "内容");
    writer.upsertFile(meta({ path: "ext/E:/other/目标.md", domain: "ext", title: "目标" }), "ext 内容");
    writer.upsertFile(meta({ path: "src.md" }), "链接 [[目标]] 和 [md](notes/目标.md)");
    const rows = linkRows();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.resolved).toBe(1);
      expect(r.target_path).toBe("notes/目标.md"); // vault(0) 赢 ext(1)
    }
  });

  it("悬空链接：目标落地后回查补解析；目标删除留 raw", () => {
    writer.upsertFile(meta({ path: "a.md" }), "引用 [[缺失页]]");
    expect(linkRows()[0].resolved).toBe(0);
    writer.upsertFile(meta({ path: "dir/缺失页.md", title: "缺失页" }), "出现了");
    expect(linkRows()[0].resolved).toBe(1);
    expect(linkRows()[0].target_path).toBe("dir/缺失页.md");
    // 删除目标：links 随其 items 级联消失的是它自己的出链；a.md 的入链留在悬空态
    writer.removeFile("dir/缺失页.md");
    const dangling = linkRows()[0];
    expect(dangling.resolved).toBe(0);
    expect(dangling.raw).toBe("[[缺失页]]");
  });

  it("removeFile 清 names；重名文件改名不残留", () => {
    writer.upsertFile(meta({ path: "x/同名.md" }), "v1");
    writer.upsertFile(meta({ path: "y/同名.md", title: "同名" }), "v2");
    const names = svc.prepare("SELECT n.name, n.original, f.path FROM names n JOIN items i ON i.rowid=n.item_rowid JOIN files f ON f.rowid=i.file_rowid").all() as Array<Record<string, unknown>>;
    expect(names).toHaveLength(2);
    writer.removeFile("x/同名.md");
    const left = svc.prepare("SELECT count(*) c FROM names").get() as { c: number };
    expect(left.c).toBe(1);
  });

  it("backfillLinks：幂等，存量 items 补齐 links/names（模拟 v1 老库升级）", () => {
    // 直插两个 item（绕过 writer 的 links 写入路径，模拟 v1 时代的存量数据）
    svc.transaction(() => {
      svc.prepare("INSERT INTO files (path, domain, title) VALUES ('p/甲.md', 'vault', '甲')").run();
      svc.prepare("INSERT INTO files (path, domain, title) VALUES ('q/乙.md', 'vault', '乙')").run();
      svc.prepare("INSERT INTO items (file_rowid, content, format) VALUES (1, '见 [[乙]] 和 [[无处]]', 'md')").run();
      svc.prepare("INSERT INTO items (file_rowid, content, format) VALUES (2, '孤岛', 'md')").run();
    });
    writer.backfillLinks();
    const rows = svc
      .prepare("SELECT raw, resolved, target_path, resolve_key FROM links ORDER BY raw")
      .all() as Array<{ raw: string; resolved: number; target_path: string | null; resolve_key: string }>;
    expect(rows).toHaveLength(2);
    const hit = rows.find((r) => r.raw === "[[乙]]")!;
    expect(hit.resolved).toBe(1);
    expect(hit.target_path).toBe("q/乙.md");
    expect(rows.find((r) => r.raw === "[[无处]]")!.resolved).toBe(0);
    const names = svc.prepare("SELECT count(*) c FROM names").get() as { c: number };
    expect(names.c).toBe(2);
    // 幂等：再跑一遍不重复
    writer.backfillLinks();
    const links2 = svc.prepare("SELECT count(*) c FROM links").get() as { c: number };
    expect(links2.c).toBe(2);
  });

  it("backfillBlocks：存量 file-level item 从库内 content 补块 item，blockref 重解析升级块级（幂等）", async () => {
    // 模拟 M2-1 时代存量：直插 file-level item + 已解析到文件级的 blockref
    svc.transaction(() => {
      svc.prepare("INSERT INTO files (path, domain, title) VALUES ('老.md', 'vault', '老')").run();
      svc.prepare("INSERT INTO items (file_rowid, content, format) VALUES (1, '- 块\n  id:: ^a\n  内容', 'md')").run();
      svc.prepare("INSERT INTO files (path, domain, title) VALUES ('引.md', 'vault', '引')").run();
      svc.prepare("INSERT INTO items (file_rowid, content, format) VALUES (2, '见 [[老#^a]]', 'md')").run();
      svc.prepare("INSERT INTO names (name, original, item_rowid, precedence) VALUES ('老', '老', 1, 0)").run();
      svc.prepare(
        `INSERT INTO links (src_item, raw, target_path, target_item, target_root, anchor, kind, resolved, resolve_key)
         VALUES (2, '[[老#^a]]', '老.md', 1, 1, '^a', 'blockref', 1, '老')`,
      ).run();
    });
    await writer.backfillBlocks();
    const blk = svc.prepare("SELECT rowid, parent_rowid FROM items WHERE block_id = 'a'").get() as {
      rowid: number;
      parent_rowid: number;
    };
    expect(blk).toMatchObject({ parent_rowid: 1 });
    const link = svc.prepare("SELECT target_item, target_root FROM links").get() as {
      target_item: number;
      target_root: number;
    };
    expect(link).toEqual({ target_item: blk.rowid, target_root: 1 });
    // 幂等：再跑一遍块不翻倍
    await writer.backfillBlocks();
    const c = svc.prepare("SELECT count(*) c FROM items WHERE block_id IS NOT NULL").get() as { c: number };
    expect(c.c).toBe(1);
  });
});

describe("IndexWriter / search 集成", () => {
  let dbDir: string;
  let svc: SqliteService;
  let writer: IndexWriter;

  beforeEach(() => {
    dbDir = makeDir();
    svc = new SqliteService({ dbDir, vaultSlug: "it", fingerprint: "fp" });
    writer = new IndexWriter(svc, {}); // 降级模式（无分词器）
  });

  it("英文/中文整词命中；bm25 排序 title 优先", () => {
    writer.upsertFile(meta({ path: "a.md", title: "Unified notes" }), "unified search engine 正文");
    writer.upsertFile(meta({ path: "b.md", title: "别的" }), "提到 unified 一次");
    const hits = search(svc, compileQuery("unified"));
    expect(hits.map((h) => h.path)).toEqual(["a.md", "b.md"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    // 中文（bigram 降级：整词变体 + 窗口均可查）
    writer.upsertFile(meta({ path: "c.md" }), "黑板报 前端开发");
    expect(search(svc, compileQuery("黑板报")).map((h) => h.path)).toEqual(["c.md"]);
  });

  it("单字中文走 LIKE 兜底（bigram 无单字 token）", () => {
    writer.upsertFile(meta({ path: "c.md" }), "黑板报 前端开发");
    const hits = search(svc, compileQuery("板"));
    expect(hits.map((h) => h.path)).toContain("c.md");
    // 兜底结果不带高亮 token 影响不了正确性：原文可回查
    expect(getItemContent(svc, hits[0].rowid)).toContain("黑板报");
  });

  it("短语有序相邻；排除词剔除", () => {
    writer.upsertFile(meta({ path: "p.md" }), "前端 开发 笔记");
    expect(search(svc, compileQuery('"前端 开发"'))).toHaveLength(1);
    expect(search(svc, compileQuery('"开发 前端"'))).toHaveLength(0);
    writer.upsertFile(meta({ path: "q.md" }), "前端 部署 指南");
    expect(search(svc, compileQuery("前端 -部署")).map((h) => h.path)).toEqual(["p.md"]);
  });

  it("title/tag/path/ext 过滤", () => {
    writer.upsertFile(meta({ path: "d/黑板报.md" }), "#项目 周报内容");
    writer.upsertFile(meta({ path: "e/前端.md", ext: "org", title: "前端" }), "org 内容 #项目");
    expect(search(svc, compileQuery("title:黑板报")).map((h) => h.path)).toEqual(["d/黑板报.md"]);
    expect(search(svc, compileQuery("tag:项目")).map((h) => h.path).sort()).toEqual([
      "d/黑板报.md",
      "e/前端.md",
    ]);
    expect(search(svc, compileQuery("path:e/")).map((h) => h.path)).toEqual(["e/前端.md"]);
    expect(search(svc, compileQuery("ext:org")).map((h) => h.path)).toEqual(["e/前端.md"]);
    // 组合：词 + 过滤（周报走 LIKE 兜底 + path 过滤）
    expect(search(svc, compileQuery("周报 path:d/")).map((h) => h.path)).toEqual(["d/黑板报.md"]);
  });

  it("hash 门：未变跳过，变更重索引（旧 token 退场）", () => {
    const m = meta({ path: "x.md" });
    writer.upsertFile(m, "第一版 内容");
    const again = writer.upsertFile(m, "第一版 内容");
    expect(again.skipped).toBe(true);
    // 只有 mtime 变、内容未变 → 仍跳过（同步盘 mtime 抖动免疫）
    expect(writer.upsertFile({ ...m, mtime: m.mtime + 9999 }, "第一版 内容").skipped).toBe(true);
    writer.upsertFile(m, "第二版 内容");
    expect(search(svc, compileQuery("第一版"))).toHaveLength(0);
    expect(search(svc, compileQuery("第二版")).map((h) => h.path)).toEqual(["x.md"]);
  });

  it("removeFile 后全链路消失", () => {
    writer.upsertFile(meta({ path: "y.md" }), "要被删除 内容");
    writer.removeFile("y.md");
    expect(search(svc, compileQuery("要被删除"))).toHaveLength(0);
    expect(search(svc, compileQuery("path:y"))).toHaveLength(0);
  });

  it("backlink: 反链过滤——已解析 target_item 与悬空 resolve_key 双路命中", () => {
    writer.upsertFile(meta({ path: "目标.md", title: "目标" }), "目标 内容");
    writer.upsertFile(meta({ path: "a.md" }), "引用 [[目标]]");
    writer.upsertFile(meta({ path: "b.md" }), "提到 [[缺失页]]");
    writer.upsertFile(meta({ path: "c.md" }), "无链接 内容");
    // 已解析路：a.md → 目标.md（键「目标」经 names 解析出 target_item）
    expect(search(svc, compileQuery("backlink:目标")).map((h) => h.path)).toEqual(["a.md"]);
    // 悬空路：b.md → 缺失页（目标不存在仍可查到引用方）
    expect(search(svc, compileQuery("backlink:缺失页")).map((h) => h.path)).toEqual(["b.md"]);
    // 组合正词：FTS + 过滤叠加
    expect(search(svc, compileQuery("backlink:目标 引用")).map((h) => h.path)).toEqual(["a.md"]);
    // 目标落地后，悬空路收敛为解析路，结果不变
    writer.upsertFile(meta({ path: "dir/缺失页.md", title: "缺失页" }), "出现了");
    expect(search(svc, compileQuery("backlink:缺失页")).map((h) => h.path)).toEqual(["b.md"]);
    // 纯过滤直接列文件，无链接文档不混入
    expect(search(svc, compileQuery("backlink:目标"))).not.toContain(
      expect.objectContaining({ path: "c.md" }),
    );
  });

  it("附件占位 item：embed 解析 + 附件名可搜 + size 门 + 删除退回悬空", () => {
    writer.upsertFile(meta({ path: "n.md" }), "看图 ![[pic.png]]");
    let link = svc.prepare("SELECT resolved, target_path FROM links").get() as {
      resolved: number;
      target_path: string | null;
    };
    expect(link.resolved).toBe(0); // 附件未落，悬空
    writer.upsertAttachment(meta({ path: "assets/pic.png", size: 7 }));
    link = svc.prepare("SELECT resolved, target_path FROM links").get() as typeof link;
    expect(link.resolved).toBe(1);
    expect(link.target_path).toBe("assets/pic.png");
    // 附件名进 t_title 可搜（title 权重高排在前）；n.md 正文含 pic.png 原文也命中
    const attHits = search(svc, compileQuery("pic")).map((h) => h.path);
    expect(attHits[0]).toBe("assets/pic.png");
    expect(attHits).toContain("n.md");
    // size 门：同 size 跳过（mtime 抖动免疫），items/names 不翻倍
    expect(writer.upsertAttachment(meta({ path: "assets/pic.png", size: 7, mtime: 999 })).skipped).toBe(true);
    // size 变更：占位重建，仍恰一个 item
    writer.upsertAttachment(meta({ path: "assets/pic.png", size: 8 }));
    const c = svc
      .prepare("SELECT count(*) c FROM items i JOIN files f ON f.rowid = i.file_rowid WHERE f.path = 'assets/pic.png'")
      .get() as { c: number };
    expect(c.c).toBe(1);
    // 删除附件：入链退回悬空留 raw（同 md 文件语义）
    writer.removeFile("assets/pic.png");
    const after = svc.prepare("SELECT resolved, raw FROM links").get() as { resolved: number; raw: string };
    expect(after.resolved).toBe(0);
    expect(after.raw).toBe("![[pic.png]]");
  });

  it("M2-2 块级拆分：文件 item + 带 id 块 item；搜索命中块级并去重；重写全量重建", () => {
    writer.upsertFile(meta({ path: "日.md", title: "日" }), "- 块甲\n  id:: ^a\n  甲内容\n- 块乙\n  id:: ^b\n");
    const items = svc
      .prepare("SELECT rowid, block_id, parent_rowid, ord FROM items ORDER BY rowid")
      .all() as Array<{ rowid: number; block_id: string | null; parent_rowid: number | null; ord: number }>;
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ block_id: null, parent_rowid: null });
    expect(items[1]).toMatchObject({ block_id: "a", parent_rowid: items[0].rowid, ord: 0 });
    expect(items[2]).toMatchObject({ block_id: "b", parent_rowid: items[0].rowid, ord: 1 });
    // 块内容可搜，命中块 item（blockId 非空）
    expect(search(svc, compileQuery("甲内容"))[0]).toMatchObject({ path: "日.md", blockId: "a" });
    // 同文件双命中去重：块级优先，文件级不重复出现
    expect(search(svc, compileQuery("块甲")).map((h) => h.blockId)).toEqual(["a"]);
    // 文件重写：块 item 全量重建，旧块退场
    writer.upsertFile(meta({ path: "日.md", title: "日" }), "- 只有块丙\n  id:: ^c\n");
    const after = svc.prepare("SELECT block_id FROM items ORDER BY rowid").all() as Array<{
      block_id: string | null;
    }>;
    expect(after.map((r) => r.block_id)).toEqual([null, "c"]);
    expect(search(svc, compileQuery("甲内容"))).toHaveLength(0);
  });

  it("M2-2 块引用 [[页#^id]]：解析到块 item（target_root 留文件级），缺块回退文件级", () => {
    writer.upsertFile(meta({ path: "目标.md", title: "目标" }), "- 块\n  id:: ^a\n  内容\n");
    writer.upsertFile(meta({ path: "引.md" }), "引 [[目标#^a]] 与 [[目标#^zz]] 与 [[目标]]");
    const rows = svc
      .prepare("SELECT raw, target_item, target_root, resolved FROM links ORDER BY raw")
      .all() as Array<{ raw: string; target_item: number; target_root: number; resolved: number }>;
    expect(rows).toHaveLength(3);
    const blockRowid = (svc.prepare("SELECT rowid FROM items WHERE block_id = 'a'").get() as { rowid: number })
      .rowid;
    const fileRowid = (
      svc
        .prepare(
          "SELECT i.rowid AS r FROM items i JOIN files f ON f.rowid = i.file_rowid WHERE f.path = '目标.md' AND i.parent_rowid IS NULL",
        )
        .get() as { r: number }
    ).r;
    expect(rows.find((r) => r.raw === "[[目标#^a]]")).toMatchObject({
      resolved: 1,
      target_item: blockRowid,
      target_root: fileRowid,
    });
    // 块不存在：回退文件级
    expect(rows.find((r) => r.raw === "[[目标#^zz]]")!.target_item).toBe(fileRowid);
    expect(rows.find((r) => r.raw === "[[目标]]")!.target_item).toBe(fileRowid);
  });

  it("fast-check：任意串编译出的 MATCH 在真库上必可执行（注入安全）", () => {
    writer.upsertFile(meta({ path: "seed.md", title: "种子" }), "seed content 种子 内容 #tag");
    const queryChars = "abZ01 中文测试 #\"-*!():_.".split("");
    const arbQuery = fc.stringOf(fc.constantFrom(...queryChars), {
      minLength: 1,
      maxLength: 24,
    });
    fc.assert(
      fc.property(arbQuery, (q) => {
        const compiled = compileQuery(q); // 不抛
        const hits = search(svc, compiled, { likeThreshold: 0 }); // MATCH 在真库执行不抛
        expect(Array.isArray(hits)).toBe(true);
        for (const h of hits) expect(typeof h.rowid).toBe("number");
      }),
      { numRuns: 200 },
    );
  });
});

describe("批量事务（外部 CRUD 风暴摊薄 COMMIT）", () => {
  let dbDir: string;
  let svc: SqliteService;
  let writer: IndexWriter;

  beforeEach(() => {
    dbDir = makeDir();
    svc = new SqliteService({ dbDir, vaultSlug: "bt", fingerprint: "fp" });
    writer = new IndexWriter(svc, {});
  });

  it("批量内写入正常生效；endBatch 提交、rollback 整批丢弃", () => {
    svc.beginBatch();
    expect(svc.inBatch).toBe(true);
    writer.upsertFile(meta({ path: "a.md" }), "alpha 内容");
    writer.upsertFile(meta({ path: "b.md" }), "beta 内容");
    svc.endBatch();
    expect(svc.inBatch).toBe(false);
    expect(search(svc, compileQuery("alpha")).map((h) => h.path)).toEqual(["a.md"]);
    // 第二批 rollback：整批不可见
    svc.beginBatch();
    writer.upsertFile(meta({ path: "c.md" }), "gamma 内容");
    svc.endBatch(true);
    expect(search(svc, compileQuery("gamma"))).toHaveLength(0);
    expect(search(svc, compileQuery("alpha"))).toHaveLength(1); // 已提交的不受影响
  });

  it("批量内 transaction() 以 SAVEPOINT 并入：单文件出错只回滚自己，整批其余保留", () => {
    svc.beginBatch();
    writer.upsertFile(meta({ path: "ok.md" }), "keep 内容");
    expect(() =>
      svc.transaction(() => {
        svc.prepare("INSERT INTO files (path, domain, title) VALUES ('half.md', 'vault', '半')").run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // 出错后批量仍可用（SAVEPOINT 已回退到该文件写入前）
    writer.upsertFile(meta({ path: "z.md" }), "zeta 内容");
    svc.endBatch();
    expect(search(svc, compileQuery("keep")).map((h) => h.path)).toEqual(["ok.md"]);
    expect(search(svc, compileQuery("zeta")).map((h) => h.path)).toEqual(["z.md"]);
    const half = svc.prepare("SELECT count(*) c FROM files WHERE path='half.md'").get() as { c: number };
    expect(half.c).toBe(0);
  });

  it("嵌套 beginBatch 配对：归零才真正提交", () => {
    svc.beginBatch();
    svc.beginBatch();
    writer.upsertFile(meta({ path: "n.md" }), "nested 内容");
    svc.endBatch();
    expect(svc.inBatch).toBe(true); // 外层还开着
    svc.endBatch();
    expect(svc.inBatch).toBe(false);
    expect(search(svc, compileQuery("nested")).map((h) => h.path)).toEqual(["n.md"]);
  });

  it("批量中 upsertFile / upsertAttachment / removeFile 混合写入与逐文件事务等价", () => {
    svc.beginBatch();
    writer.upsertFile(meta({ path: "m.md" }), "看图 ![[i.png]]");
    writer.upsertAttachment(meta({ path: "assets/i.png", size: 3 }));
    writer.removeFile("m.md");
    svc.endBatch();
    expect(search(svc, compileQuery("看图"))).toHaveLength(0);
    expect(search(svc, compileQuery("i")).map((h) => h.path)).toEqual(["assets/i.png"]);
    const links = svc.prepare("SELECT count(*) c FROM links").get() as { c: number };
    expect(links.c).toBe(0); // m.md 的出链随级联消失
  });
});
