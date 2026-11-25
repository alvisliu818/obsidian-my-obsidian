import { describe, expect, it } from "vitest";
import {
  EVENT_MARKER_FILE,
  EVENT_MARKER_SOURCE,
  backgroundShimSource,
  needsBackgroundShim,
  stripBackgroundShim,
} from "./backgroundShim";

describe("backgroundShim", () => {
  it("SW 垫片带权限门控与非法 @match 收敛", () => {
    const src = backgroundShimSource(true);
    expect(src).toContain('indexOf("alarms") >= 0');
    expect(src).toContain("__obHasAlarms && chrome.alarms");
    expect(src).toContain("__obAutoFixMatch = true");
    expect(src).toContain("*://*");
    const off = backgroundShimSource(false);
    expect(off).toContain("__obAutoFixMatch = false");
    expect(off).not.toBe(src);
  });

  it("换版能剥掉旧垫片，保留扩展源码", () => {
    const old = backgroundShimSource(true);
    const original = "console.log('extension worker');";
    expect(stripBackgroundShim(old + original)).toBe(original);
    expect(stripBackgroundShim(original)).toBe(original);
  });

  it("生成的垫片是可解析的 JS", () => {
    expect(() => new Function(backgroundShimSource(true))).not.toThrow();
  });

  it("只在需要时注入，marker 文件名避开 Chromium 保留前缀", () => {
    expect(needsBackgroundShim("chrome.userScripts.register([])")).toBe(true);
    expect(needsBackgroundShim("chrome.alarms.create('x', {})")).toBe(true);
    expect(needsBackgroundShim("console.log(1)")).toBe(false);
    expect(EVENT_MARKER_FILE.startsWith("_")).toBe(false);
    expect(EVENT_MARKER_SOURCE).toContain("noop injection marker");
  });
});
