import { describe, expect, it } from "vitest";
import { buildShimSource } from "./cs-runtime";

describe("content-script shim", () => {
  const src = buildShimSource("ext@example", "file:///ext/");

  it("生成可解析的 JS", () => {
    expect(() => new Function(src)).not.toThrow();
  });

  it("DOMContentLoaded 补发只调本插件捕获的回调，不派发到共享 DOM", () => {
    expect(src).toContain("window.__obFireDomReady");
    expect(src).toContain("window.__obBeginDomReadyCapture");
    expect(src).toContain("window.__obEndDomReadyCapture");
    expect(src).not.toContain('document.dispatchEvent(new Event("DOMContentLoaded"))');
  });
});
