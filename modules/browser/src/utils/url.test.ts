/**
 * 链接拦截判定单测（对齐思源 f01eaa2：同源页面放行）。
 *
 * 覆盖 shouldInterceptLink 的三道闸门：http(s) / 排除名单 / 宿主同源，
 * 以及 isAppInternalUrl 在不透明源（app://、file://、Node 无 window）下不误判。
 */
import { describe, expect, it } from "vitest";

import { isAppInternalUrl, shouldInterceptLink } from "./url";

describe("isAppInternalUrl", () => {
  it("同 origin 的 http(s) 页面视为宿主自身页面", () => {
    expect(isAppInternalUrl("https://127.0.0.1:1933/stage/build/app/settings.html?settingsWindowToken=x", "https://127.0.0.1:1933")).toBe(true);
    expect(isAppInternalUrl("http://localhost:8080/a/b", "http://localhost:8080")).toBe(true);
  });

  it("不同 origin（含端口/协议差异）视为外部", () => {
    expect(isAppInternalUrl("https://example.com/a", "https://127.0.0.1:1933")).toBe(false);
    expect(isAppInternalUrl("http://127.0.0.1:1933/a", "https://127.0.0.1:1933")).toBe(false);
    expect(isAppInternalUrl("https://127.0.0.1:1934/a", "https://127.0.0.1:1933")).toBe(false);
  });

  it("不透明源 / 无 origin / 坏地址不误判", () => {
    expect(isAppInternalUrl("https://example.com", "null")).toBe(false);
    expect(isAppInternalUrl("https://example.com", "")).toBe(false);
    // 与思源 isSiyuanInternalUrl 一致：相对地址按 base 解析，算同源（外层
    // shouldInterceptLink 的 http(s) 闸门会挡住这类非绝对外链）
    expect(isAppInternalUrl("relative/path", "https://example.com")).toBe(true);
    // 非 http(s) 绝对协议即使 base 同源也不算（地址栏/浏览器内部协议照常处理）
    expect(isAppInternalUrl("obsidian://open?vault=x", "https://example.com")).toBe(false);
  });
});

describe("shouldInterceptLink", () => {
  const origin = "https://127.0.0.1:1933";

  it("普通 http(s) 外链且未排除 → 拦截", () => {
    expect(shouldInterceptLink("https://example.com/a?b=1", "", origin)).toBe(true);
    expect(shouldInterceptLink("http://example.com", "", origin)).toBe(true);
  });

  it("排除站点 → 放行（支持子域规则）", () => {
    expect(shouldInterceptLink("https://example.com/a", "example.com", origin)).toBe(false);
    expect(shouldInterceptLink("https://sub.example.com/a", "*.example.com", origin)).toBe(false);
    expect(shouldInterceptLink("https://other.com/a", "example.com", origin)).toBe(true);
  });

  it("宿主自身页面 → 放行（独立设置窗口不被劫持）", () => {
    expect(shouldInterceptLink("https://127.0.0.1:1933/stage/build/app/settings.html?token=x", "", origin)).toBe(false);
    // 即使同时命中排除名单也仍放行
    expect(shouldInterceptLink("https://127.0.0.1:1933/x", "127.0.0.1", origin)).toBe(false);
  });

  it("非 http(s) 协议 → 放行", () => {
    expect(shouldInterceptLink("obsidian://open?vault=x", "", origin)).toBe(false);
    expect(shouldInterceptLink("app://obsidian.md/index.html", "", origin)).toBe(false);
    expect(shouldInterceptLink("file:///C:/a.md", "", origin)).toBe(false);
    expect(shouldInterceptLink("", "", origin)).toBe(false);
  });
});
