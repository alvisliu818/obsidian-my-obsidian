/**
 * LocalScanner × 黑/白名单模式集成测试（obsidian-my-obsidian 功能增强）。
 *
 * 直接验证 isExcluded / isExcludedDirectory 的挂接顺序：
 *   内部路径 > excludedFolders > 黑名单 > 插件目录逻辑 > includePaths
 *   > 白名单 > excludePaths > 默认文件名排除。
 * 不需要真实 Vault —— 构造器与 shouldSyncPath(Path) 只用 configDir 与纯函数。
 */
import { describe, expect, it } from "vitest";

import { LocalScanner } from "../src/sync/local-scanner";

function makeScanner(config: Partial<ConstructorParameters<typeof LocalScanner>[1]> = {}): LocalScanner {
  const fakeVault = { configDir: ".obsidian", adapter: {} };
  return new LocalScanner(
    fakeVault as unknown as ConstructorParameters<typeof LocalScanner>[0],
    config,
    "test-plugin",
  );
}

describe("LocalScanner.shouldSyncPath × 黑/白名单", () => {
  it("默认配置下普通路径参与同步", () => {
    const scanner = makeScanner();
    expect(scanner.shouldSyncPath("notes/a.md")).toBe(true);
  });

  it("黑名单普通条目剪掉子树，不影响相邻目录", () => {
    const scanner = makeScanner({ pathBlacklist: ["私人"] });
    expect(scanner.shouldSyncPath("私人")).toBe(false);
    expect(scanner.shouldSyncPath("私人/a.md")).toBe(false);
    expect(scanner.shouldSyncPath("私人日记/a.md")).toBe(true);
  });

  it("黑名单正则条目按整条路径匹配", () => {
    const scanner = makeScanner({ pathBlacklist: ["/\\.obsidian\\/.*\\.log$/i"] });
    expect(scanner.shouldSyncPath(".obsidian/plugins/x/run.log")).toBe(false);
    expect(scanner.shouldSyncPath("notes/a.md")).toBe(true);
  });

  it("白名单非空时未命中内容被排除", () => {
    const scanner = makeScanner({ pathWhitelist: ["项目"] });
    expect(scanner.shouldSyncPath("项目/a.md")).toBe(true);
    expect(scanner.shouldSyncPath("其他/a.md")).toBe(false);
  });

  it("黑名单压白名单（安全优先）", () => {
    const scanner = makeScanner({
      pathBlacklist: ["项目/机密.md"],
      pathWhitelist: ["项目"],
    });
    expect(scanner.shouldSyncPath("项目/机密.md")).toBe(false);
    expect(scanner.shouldSyncPath("项目/公开.md")).toBe(true);
  });

  it("白名单不影响同步范围开关纳管的配置文件（includePaths 先于白名单）", () => {
    const scanner = makeScanner({
      pathWhitelist: ["项目"],
      includePaths: [".obsidian/bookmarks.json"],
    });
    expect(scanner.shouldSyncPath(".obsidian/bookmarks.json")).toBe(true);
    expect(scanner.shouldSyncPath("其他/notes.md")).toBe(false);
  });

  it("excludedFolders 仍强于白名单（先于黑/白名单层判定）", () => {
    const scanner = makeScanner({
      excludedFolders: ["私人"],
      pathWhitelist: ["私人/公开"],
    });
    expect(scanner.shouldSyncPath("私人/公开/a.md")).toBe(false);
  });

  it("默认文件名排除照常生效（白名单也压不过）", () => {
    const scanner = makeScanner({ pathWhitelist: ["项目"] });
    expect(scanner.shouldSyncPath("项目/.DS_Store")).toBe(false);
    expect(scanner.shouldSyncPath("项目/~$report.docx")).toBe(false);
    expect(scanner.shouldSyncPath("项目/notes.md")).toBe(true);
  });

  it("EasySync 内部路径恒排除（黑名单也压不过）", () => {
    const scanner = makeScanner({
      pathBlacklist: [],
      includeOwnPluginCode: true,
    });
    expect(
      scanner.shouldSyncPath(".obsidian/plugins/test-plugin/data.json"),
    ).toBe(false);
  });
});

describe("LocalScanner.shouldSyncFolderPath × 黑/白名单", () => {
  it("黑名单命中目录直接剪枝", () => {
    const scanner = makeScanner({ pathBlacklist: ["私人", "/^tmp-/"] });
    expect(scanner.shouldSyncFolderPath("私人")).toBe(false);
    expect(scanner.shouldSyncFolderPath("私人/sub")).toBe(false);
    expect(scanner.shouldSyncFolderPath("tmp-build")).toBe(false);
    expect(scanner.shouldSyncFolderPath("notes")).toBe(true);
  });

  it("白名单剪掉不可能命中内容的目录，保留可能有后代的目录", () => {
    const scanner = makeScanner({ pathWhitelist: ["项目/alpha"] });
    expect(scanner.shouldSyncFolderPath("项目")).toBe(true);
    expect(scanner.shouldSyncFolderPath("项目/alpha")).toBe(true);
    expect(scanner.shouldSyncFolderPath("项目/alpha/sub")).toBe(true);
    expect(scanner.shouldSyncFolderPath("项目/beta")).toBe(false);
    expect(scanner.shouldSyncFolderPath("其他")).toBe(false);
  });

  it("正则白名单保守放行目录，交由文件级过滤裁决", () => {
    const scanner = makeScanner({ pathWhitelist: ["/^日记\\/2026-/"] });
    expect(scanner.shouldSyncFolderPath("日记")).toBe(true);
    expect(scanner.shouldSyncFolderPath("其他")).toBe(true);
    expect(scanner.shouldSyncPath("其他/a.md")).toBe(false);
    expect(scanner.shouldSyncPath("日记/2026-01-01.md")).toBe(true);
  });
});
