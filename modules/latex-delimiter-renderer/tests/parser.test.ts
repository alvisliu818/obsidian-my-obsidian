/**
 * Upstream's own parser tests, carried over and re-expressed in vitest.
 *
 * Every assertion here is upstream's (Andreas Burger, MIT) — it is the contract
 * the module is built on, so it is kept verbatim. Only the runner changed: the
 * standalone plugin used `node:test` + tsx, the host runs vitest.
 */

import { describe, expect, it } from "vitest";
import { convertForObsidianRender, findMathDelimiters } from "../src/parser";

describe("findMathDelimiters", () => {
  it("finds inline and display delimiters", () => {
    expect(findMathDelimiters("A \\(x+1\\) B \\[y^2\\]")).toEqual([
      { from: 2, to: 9, source: "x+1", display: false },
      { from: 12, to: 19, source: "y^2", display: true }
    ]);
  });

  it("ignores escaped, empty, and multiline inline delimiters", () => {
    expect(findMathDelimiters("\\\\(no\\) \\(\\) \\(a\nb\\)")).toEqual([]);
  });

  it("allows multiline display math", () => {
    expect(findMathDelimiters("\\[\na+b\n\\]")).toEqual([
      { from: 0, to: 9, source: "\na+b\n", display: true }
    ]);
  });
});

describe("convertForObsidianRender", () => {
  it("converts delimiters for rendering without touching code", () => {
    const markdown = [
      "Inline \\(x\\).",
      "`literal \\(x\\)`",
      "```tex",
      "\\[not rendered\\]",
      "```",
      "\\[y\\]"
    ].join("\n");
    expect(convertForObsidianRender(markdown)).toEqual(
      [
        "Inline $x$.",
        "`literal \\(x\\)`",
        "```tex",
        "\\[not rendered\\]",
        "```",
        "$$y$$"
      ].join("\n")
    );
  });

  it("is idempotent — a second pass changes nothing", () => {
    // 六个渲染面(静态块/内嵌/闪卡/代码块前缀/库外文件)各自都会调一次,
    // 已经转过的文本再走一遍必须原样出来。
    const once = convertForObsidianRender("\\(x\\) 与 $y$");
    expect(once).toBe("$x$ 与 $y$");
    expect(convertForObsidianRender(once)).toBe(once);
  });
});
