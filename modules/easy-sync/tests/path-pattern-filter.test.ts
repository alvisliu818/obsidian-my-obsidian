/**
 * path-pattern-filter 单元测试（obsidian-my-obsidian 功能增强）。
 *
 * 覆盖：条目语法（普通路径 / /正则/flags）、归一化去重、校验拒绝坏条目、
 * 文件级黑/白名单匹配、目录级保守判定，以及「黑名单压白名单」与
 * 「坏正则绝不抛错」两条安全语义。
 */
import { describe, expect, it } from "vitest";

import {
  isFolderExcludedByPatterns,
  isFolderPathKeptByWhitelist,
  isPathExcludedByPatterns,
  isPathIncludedByWhitelist,
  normalizePathPatterns,
  parsePathPattern,
  validatePathPatterns,
} from "../src/sync/path-pattern-filter";

describe("parsePathPattern", () => {
  it("普通条目：归一化反斜杠、去首尾斜杠、折叠重复斜杠", () => {
    expect(parsePathPattern("  notes\\sub\\  ")).toEqual({
      ok: true,
      pattern: { kind: "plain", normalized: "notes/sub" },
    });
    expect(parsePathPattern("daily//2026/")).toEqual({
      ok: true,
      pattern: { kind: "plain", normalized: "daily/2026" },
    });
    // 首尾都有斜杠的条目按 /正则/flags 形状解析（vault 相对路径本就不以
    // / 开头——想写普通路径就去掉首斜杠，语法提示里写明了）。
    expect(parsePathPattern("/daily//2026/").ok).toBe(true);
  });

  it("无闭合斜杠的 /开头 串按普通路径处理，不会误当正则", () => {
    expect(parsePathPattern("/odd")).toEqual({
      ok: true,
      pattern: { kind: "plain", normalized: "odd" },
    });
  });

  it("正则条目：解析 body 与 flags", () => {
    const parsed = parsePathPattern("/\\.tmp$/i");
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.pattern.kind === "regex") {
      expect(parsed.pattern.regex.test("notes/a.TMP")).toBe(true);
    } else {
      expect.unreachable("expected regex pattern");
    }
  });

  it("非法 flags 被拒绝", () => {
    const parsed = parsePathPattern("/x/q");
    expect(parsed.ok).toBe(false);
  });

  it("语法错误的正则被拒绝并给出原因", () => {
    const parsed = parsePathPattern("/([unclosed/");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason.length).toBeGreaterThan(0);
  });

  it("空条目与 . / .. 路径被拒绝", () => {
    expect(parsePathPattern("").ok).toBe(false);
    expect(parsePathPattern("   ").ok).toBe(false);
    expect(parsePathPattern("../escape").ok).toBe(false);
    expect(parsePathPattern("./here").ok).toBe(false);
    expect(parsePathPattern(".").ok).toBe(false);
  });
});

describe("normalizePathPatterns / validatePathPatterns", () => {
  it("去空、去大小写重复，保留首个拼写", () => {
    expect(
      normalizePathPatterns([" Notes ", "notes", "", 42, "/RE/i", "/re/I"]),
    ).toEqual(["Notes", "/RE/i"]);
  });

  it("validatePathPatterns 汇总无法解析的条目（归一化保留原文，校验负责拦截）", () => {
    const result = validatePathPatterns(["notes", "/([bad/", "..", "/ok/"]);
    expect(result.normalized).toEqual(["notes", "/([bad/", "..", "/ok/"]);
    expect(result.invalid).toEqual([
      { raw: "/([bad/", reason: expect.stringMatching(/./u) },
      { raw: "..", reason: expect.stringMatching(/./u) },
    ]);
  });
});

describe("isPathExcludedByPatterns", () => {
  it("空列表不排除任何路径", () => {
    expect(isPathExcludedByPatterns("anything.md", [])).toBe(false);
    expect(isPathExcludedByPatterns("anything.md", undefined)).toBe(false);
  });

  it("普通条目：目录边界前缀匹配，大小写不敏感", () => {
    const blacklist = ["私人"];
    expect(isPathExcludedByPatterns("私人", blacklist)).toBe(true);
    expect(isPathExcludedByPatterns("私人/笔记.md", blacklist)).toBe(true);
    expect(isPathExcludedByPatterns("私人/子/笔记.md", blacklist)).toBe(true);
    expect(isPathExcludedByPatterns("私人日记/笔记.md", blacklist)).toBe(false);
    expect(isPathExcludedByPatterns("笔记.md", blacklist)).toBe(false);
    expect(isPathExcludedByPatterns("私人/notes.md", ["私人".toUpperCase()]))
      .toBe(true);
  });

  it("普通条目也能精确命中单个文件路径", () => {
    expect(isPathExcludedByPatterns("notes/tmp.md", ["notes/tmp.md"]))
      .toBe(true);
    expect(isPathExcludedByPatterns("notes/tmp-old.md", ["notes/tmp.md"]))
      .toBe(false);
  });

  it("正则条目：对整条 vault 相对路径做匹配", () => {
    const blacklist = ["/^drafts\\/.*\\.tmp$/i"];
    expect(isPathExcludedByPatterns("drafts/a.tmp", blacklist)).toBe(true);
    expect(isPathExcludedByPatterns("drafts/sub/b.TMP", blacklist)).toBe(true);
    expect(isPathExcludedByPatterns("notes/a.tmp", blacklist)).toBe(false);
    expect(isPathExcludedByPatterns("drafts/a.md", blacklist)).toBe(false);
  });

  it("无 i flag 的正则区分大小写", () => {
    const blacklist = ["/\\.tmp$/"];
    expect(isPathExcludedByPatterns("a.tmp", blacklist)).toBe(true);
    expect(isPathExcludedByPatterns("a.TMP", blacklist)).toBe(false);
  });

  it("坏正则条目按不匹配处理，绝不抛错", () => {
    const blacklist = ["/([unclosed/", "私人"];
    expect(isPathExcludedByPatterns("drafts/a.md", blacklist)).toBe(false);
    expect(isPathExcludedByPatterns("私人/x.md", blacklist)).toBe(true);
  });
});

describe("isPathIncludedByWhitelist", () => {
  it("空白名单等于不设限", () => {
    expect(isPathIncludedByWhitelist("anything.md", [])).toBe(true);
    expect(isPathIncludedByWhitelist("anything.md", undefined)).toBe(true);
  });

  it("非空白名单：命中才保留", () => {
    const whitelist = ["项目", "/^日记\\/2026-/"];
    expect(isPathIncludedByWhitelist("项目/a.md", whitelist)).toBe(true);
    expect(isPathIncludedByWhitelist("项目/子/b.md", whitelist)).toBe(true);
    expect(isPathIncludedByWhitelist("日记/2026-01-01.md", whitelist))
      .toBe(true);
    expect(isPathIncludedByWhitelist("其他/a.md", whitelist)).toBe(false);
    expect(isPathIncludedByWhitelist("日记/2025-12-31.md", whitelist))
      .toBe(false);
  });
});

describe("isFolderPathKeptByWhitelist", () => {
  it("空白名单不设限", () => {
    expect(isFolderPathKeptByWhitelist("any/folder", [])).toBe(true);
    expect(isFolderPathKeptByWhitelist("any/folder", undefined)).toBe(true);
  });

  it("普通条目：目录自身或后代可能命中则保留，无关目录剪枝", () => {
    const whitelist = ["项目/alpha"];
    expect(isFolderPathKeptByWhitelist("项目", whitelist)).toBe(true);
    expect(isFolderPathKeptByWhitelist("项目/alpha", whitelist)).toBe(true);
    expect(isFolderPathKeptByWhitelist("项目/alpha/sub", whitelist))
      .toBe(true);
    expect(isFolderPathKeptByWhitelist("项目/beta", whitelist)).toBe(false);
    expect(isFolderPathKeptByWhitelist("其他", whitelist)).toBe(false);
  });

  it("正则条目：保守放行，交由文件级过滤裁决", () => {
    const whitelist = ["/deep\\/nested\\/.*\\.md$/"];
    expect(isFolderPathKeptByWhitelist("deep", whitelist)).toBe(true);
    expect(isFolderPathKeptByWhitelist("shallow", whitelist)).toBe(true);
    expect(isFolderPathKeptByWhitelist("deep/nested", whitelist)).toBe(true);
  });
});

describe("isFolderExcludedByPatterns", () => {
  it("目录级黑名单：命中即剪枝整棵子树", () => {
    const blacklist = ["/^private($|\\/)/i", "tmp-output"];
    expect(isFolderExcludedByPatterns("private", blacklist)).toBe(true);
    expect(isFolderExcludedByPatterns("Private/sub", blacklist)).toBe(true);
    expect(isFolderExcludedByPatterns("tmp-output", blacklist)).toBe(true);
    expect(isFolderExcludedByPatterns("notes", blacklist)).toBe(false);
  });
});
