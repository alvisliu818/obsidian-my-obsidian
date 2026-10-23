import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteService, vaultSlugOf } from "../sqlite-service";
import { contentHash } from "../fnv";
import { SCHEMA_VERSION } from "../schema";

const dirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "idx-core-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  // Windows 下残留句柄会让 rmSync 报 EPERM——清理失败不掩埋真实测试结果
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeService(dbDir: string, fingerprint = "fp1"): SqliteService {
  return new SqliteService({ dbDir, vaultSlug: "testvault", fingerprint });
}

describe("SqliteService", () => {
  let dbDir: string;

  beforeEach(() => {
    dbDir = makeDir();
  });

  it("懒打开：构造不落盘，ensureOpen 后创建 schema", () => {
    const svc = makeService(dbDir);
    expect(svc.isOpen).toBe(false);
    expect(existsSync(svc.filePath)).toBe(false);
    svc.ensureOpen();
    expect(svc.isOpen).toBe(true);
    expect(existsSync(svc.filePath)).toBe(true);
    expect(svc.metaGet("schema_version")).toBe(String(SCHEMA_VERSION));
    expect(svc.metaGet("fingerprint")).toBe("fp1");
    svc.close();
  });

  it("数据跨会话存活；同指纹不重建", () => {
    const svc = makeService(dbDir);
    svc.ensureOpen();
    svc.transaction(() => {
      svc.prepare("INSERT INTO files (path, domain) VALUES ('a.md', 'vault')").run();
      svc.prepare(
        "INSERT INTO items (file_rowid, content, format) VALUES (1, 'hello', 'md')",
      ).run();
    });
    svc.close();

    const svc2 = makeService(dbDir);
    svc2.ensureOpen();
    const count = svc2.prepare("SELECT count(*) c FROM items").get() as { c: number };
    expect(count.c).toBe(1);
    svc2.close();
  });

  it("指纹变更 → 全量重建，数据清空、指纹更新", () => {
    const svc = makeService(dbDir);
    svc.ensureOpen();
    svc.prepare("INSERT INTO files (path, domain) VALUES ('a.md', 'vault')").run();
    svc.close();

    const svc2 = new SqliteService({ dbDir, vaultSlug: "testvault", fingerprint: "fp2" });
    svc2.ensureOpen();
    const files = svc2.prepare("SELECT count(*) c FROM files").get() as { c: number };
    expect(files.c).toBe(0);
    expect(svc2.metaGet("fingerprint")).toBe("fp2");
    svc2.close();
  });

  it("坏库（垃圾字节）→ 删库重建而非抛错", () => {
    writeFileSync(path.join(dbDir, "testvault.db"), "not a sqlite database, just garbage bytes");
    let rebuilt = false;
    const probed = new SqliteService({
      dbDir,
      vaultSlug: "testvault",
      fingerprint: "fp1",
      onEvent: (e) => {
        if (e.type === "rebuild") rebuilt = true;
      },
    });
    probed.ensureOpen();
    expect(rebuilt).toBe(true);
    expect(probed.metaGet("schema_version")).toBe(String(SCHEMA_VERSION));
    probed.close();
  });

  it("外键级联：删文件 → items/links 随之消失（foreign_keys=ON 生效）", () => {
    const svc = makeService(dbDir);
    svc.ensureOpen();
    svc.transaction(() => {
      svc.prepare("INSERT INTO files (path, domain) VALUES ('a.md', 'vault')").run();
      svc.prepare(
        "INSERT INTO items (file_rowid, content, format) VALUES (1, 'blk', 'md')",
      ).run();
      svc.prepare(
        "INSERT INTO links (src_item, raw, kind, resolved) VALUES (1, '[[x]]', 'wiki', 0)",
      ).run();
    });
    svc.prepare("DELETE FROM files WHERE path='a.md'").run();
    const items = svc.prepare("SELECT count(*) c FROM items").get() as { c: number };
    const links = svc.prepare("SELECT count(*) c FROM links").get() as { c: number };
    expect(items.c).toBe(0);
    expect(links.c).toBe(0);
    svc.close();
  });

  it("事务回滚：抛错后不留半截写入", () => {
    const svc = makeService(dbDir);
    svc.ensureOpen();
    expect(() =>
      svc.transaction(() => {
        svc.prepare("INSERT INTO files (path, domain) VALUES ('x.md', 'vault')").run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const files = svc.prepare("SELECT count(*) c FROM files").get() as { c: number };
    expect(files.c).toBe(0);
    svc.close();
  });

  it("FTS5 触发器自动同步：insert 后可查、update 重分词、delete 后消失", () => {
    const svc = makeService(dbDir);
    svc.ensureOpen();
    svc.transaction(() => {
      svc.prepare("INSERT INTO files (path, domain) VALUES ('a.md', 'vault')").run();
      svc.prepare(
        "INSERT INTO items (file_rowid, content, t_content, format) VALUES (1, ?, ?, 'md')",
      ).run("黑板报 前端开发", "黑板报 前端开发");
    });
    // 整词命中（unicode61 把连续 CJK 视为一个 token，「前端开发」是整词），回表内容来自 items 分词列
    const hit = svc
      .prepare("SELECT rowid, t_content FROM items_fts WHERE items_fts MATCH '前端开发'")
      .all() as { rowid: number; t_content: string }[];
    expect(hit).toHaveLength(1);
    expect(hit[0].t_content).toBe("黑板报 前端开发");
    // 2 字中文子串：unicode61 下 match 不中（探针实证）→ 上层 LIKE 限域兜底
    const miss = svc.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH '前端'").all();
    expect(miss).toHaveLength(0);

    // update：旧 token 退场，新 token 进场（触发器 delete+insert 对）
    svc.transaction(() => {
      svc.prepare(
        "UPDATE items SET content = ?, t_content = ? WHERE rowid = 1",
      ).run("黑板报 后端开发", "黑板报 后端开发");
    });
    expect(svc.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH '前端开发'").all()).toHaveLength(0);
    expect(svc.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH '后端开发'").all()).toHaveLength(1);

    // delete：索引行随触发器退场，不残留
    svc.prepare("DELETE FROM items WHERE rowid = 1").run();
    expect(svc.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH '后端开发'").all()).toHaveLength(0);
    svc.close();
  });

  it("prepared statement 缓存：同一 SQL 返回同一实例，close 后清空", () => {
    const svc = makeService(dbDir);
    svc.ensureOpen();
    const seen = new WeakSet<object>();
    const a = svc.prepare("SELECT 1");
    seen.add(a);
    expect(svc.prepare("SELECT 1")).toBe(a);
    svc.close();
    svc.ensureOpen();
    // 不直接比较旧语句对象——finalized 原生对象连属性巡检都会抛错，用 WeakSet 成员判断
    const b = svc.prepare("SELECT 1");
    expect(seen.has(b)).toBe(false);
    svc.close();
  });

  it("bulk 模式：beginBulk/commitBulk 后库仍健康、数据存活", () => {
    const svc = makeService(dbDir);
    svc.ensureOpen();
    svc.beginBulk();
    svc.transaction(() => {
      svc.prepare("INSERT INTO files (path, domain) VALUES ('b.md', 'vault')").run();
    });
    svc.commitBulk();
    svc.close();

    const svc2 = makeService(dbDir);
    svc2.ensureOpen();
    const files = svc2.prepare("SELECT count(*) c FROM files").get() as { c: number };
    expect(files.c).toBe(1);
    svc2.close();
  });
});

describe("vaultSlugOf / contentHash", () => {
  it("vaultSlug：特殊字符替换 + 短 hash 后缀防碰撞", () => {
    const a = vaultSlugOf("E:\\HOME\\BaiduSyncdisk");
    const b = vaultSlugOf("E:\\HOME\\Code");
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/[:\\]/);
  });

  it("contentHash：稳定 + 长度参与（前缀相同不同长不撞）", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash("hello")).not.toBe(contentHash("hell"));
    expect(contentHash("")).not.toBe(contentHash("\u0000"));
  });
});
