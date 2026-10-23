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

const dirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "idx-core-idx-"));
  dirs.push(d);
  return d;
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

  it("CJK 降级：无分词器时整块保留", () => {
    expect(tokenizeForIndexing("黑板报 前端开发")).toEqual(["黑板报", "前端开发"]);
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
  it("LIKE 兜底候选：短中文必有；降级模式长中文也入列", () => {
    expect(compileQuery("黑板").likeTerms).toEqual(["黑板"]);
    expect(compileQuery("前端开发").likeTerms).toEqual(["前端开发"]); // 降级模式
    expect(compileQuery("前端开发", { chsSegmenter: fakeSegmenter }).likeTerms).toEqual([]); // 有分词器则靠分词
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

  it("英文/中文整词命中；bm25 排序 title 优先", () => {
    writer.upsertFile(meta({ path: "a.md", title: "Unified notes" }), "unified search engine 正文");
    writer.upsertFile(meta({ path: "b.md", title: "别的" }), "提到 unified 一次");
    const hits = search(svc, compileQuery("unified"));
    expect(hits.map((h) => h.path)).toEqual(["a.md", "b.md"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    // 中文整词（降级模式：内容含空格才切开，整块 token 可查）
    writer.upsertFile(meta({ path: "c.md" }), "黑板报 前端开发");
    expect(search(svc, compileQuery("黑板报")).map((h) => h.path)).toEqual(["c.md"]);
  });

  it("2 字中文子串走 LIKE 兜底", () => {
    writer.upsertFile(meta({ path: "c.md" }), "黑板报 前端开发");
    const hits = search(svc, compileQuery("黑板"));
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
