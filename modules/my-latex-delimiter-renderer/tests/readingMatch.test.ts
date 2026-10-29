/**
 * The positioning rules this build adds on top of upstream.
 *
 * Upstream located a formula with `rendered.text.indexOf(visibleSource)` — a
 * plain search from offset 0. That is right almost always and wrong in two
 * ways that matter, both of which upstream's test suite cannot see because it
 * never runs a real markdown parser:
 *
 *  1. a literal `(…)` earlier in the section is found FIRST and gets turned
 *     into math, and
 *  2. a body markdown rewrote into elements (`\(a_1 + b_2\)` → `(a<em>1 +
 *     b</em>2)`) is never found at all, so the formula silently stays raw.
 *
 * LaTeX subscripts make (2) the common case rather than a corner one, which is
 * why `locateVisible` exists.
 */

import { describe, expect, it } from "vitest";
import {
  locateVisible,
  sectionTextOf,
  stripEmphasis,
  stripMarkdownEscapes,
  visibleForm,
} from "../src/main";
import { findMathDelimiters } from "../src/parser";

const inline = (source: string) => findMathDelimiters(`\\(${source}\\)`)[0]!;
const display = (source: string) => findMathDelimiters(`\\[${source}\\]`)[0]!;

describe("stripMarkdownEscapes", () => {
  it("collapses the very delimiters that hide a formula", () => {
    // `\(` is a legal CommonMark escape, so the DOM reads `(E=mc^2)` — a needle
    // built from the raw source would never match.
    expect(stripMarkdownEscapes("\\(E=mc^2\\)")).toBe("(E=mc^2)");
  });

  it("leaves LaTeX commands alone — a backslash before a letter is not an escape", () => {
    expect(stripMarkdownEscapes("\\frac{a}{b}")).toBe("\\frac{a}{b}");
  });

  it("strips inside the body too, so needle and DOM stay in step", () => {
    // `\,` 是 LaTeX 间距命令,markdown 同样吃掉它的反斜杠。
    expect(stripMarkdownEscapes("\\(a\\,b\\)")).toBe("(a,b)");
  });
});

describe("stripEmphasis", () => {
  it("removes only emphasis markers", () => {
    expect(stripEmphasis("a_1 + b_2")).toBe("a1 + b2");
    expect(stripEmphasis("plain text")).toBe("plain text");
  });
});

describe("sectionTextOf", () => {
  it("carves this element's slice out of the whole-document text", () => {
    // getSectionInfo().text 是**整篇**,不是本节。
    expect(
      sectionTextOf({ text: "标题\n第一段\n第二段\n第三段", lineStart: 1, lineEnd: 2 }),
    ).toBe("第一段\n第二段");
  });
});

describe("visibleForm", () => {
  it("is the shape a formula has after markdown", () => {
    expect(visibleForm(inline("x"))).toBe("(x)");
    expect(visibleForm(display("x"))).toBe("[x]");
  });

  it("keeps the body faithful to the source", () => {
    expect(visibleForm(inline("a\\,b"))).toBe("(a,b)");
    // 但渲染喂回去的必须是**源码里**的 body,见 renderReadingView 用 match.source。
    expect(inline("a\\,b").source).toBe("a\\,b");
  });
});

describe("locateVisible", () => {
  it("finds an ordinary formula", () => {
    expect(locateVisible("质能方程 (E=mc^2) 成立", "(E=mc^2)", 0, 5)).toEqual({
      from: 5,
      to: 13,
    });
  });

  it("uses `at` so a same-shaped literal earlier in the section is not touched", () => {
    const text = "(a) 是记号,公式是 (a)";
    // 没有 at(从 0 找)会命中前面那个普通括号 —— 这正是修之前的行为。
    expect(locateVisible(text, "(a)", 0, 0)).toEqual({ from: 0, to: 3 });
    // 有了 at 就落在真公式上。
    expect(locateVisible(text, "(a)", 0, 12)).toEqual({ from: 12, to: 15 });
  });

  it("recognises a body markdown rewrote into emphasis", () => {
    // `\(a_1 + b_2\)` 渲染后是 `(a1 + b2)`:下标的下划线没了。
    // 注意 to 是**渲染后**的长度,比 needle 短 —— 定位与长度必须分开返回。
    expect(locateVisible("(a1 + b2)", "(a_1 + b_2)", 0, 0)).toEqual({ from: 0, to: 9 });
  });

  it("backs up when prose in front of the formula lost emphasis markers", () => {
    // `(a) 和 *b* 和 \(c\)` 渲染成 `(a) 和 b 和 (c)` —— 实际位置比 at 更靠前。
    expect(locateVisible("(a) 和 b 和 (c)", "(c)", 3, 13)).toEqual({ from: 10, to: 13 });
  });

  it("never walks onto a formula already consumed", () => {
    const text = "(a)、(b)";
    const first = locateVisible(text, "(a)", 0, 0);
    expect(first).toEqual({ from: 0, to: 3 });
    expect(locateVisible(text, "(b)", first!.to, 4)).toEqual({ from: 4, to: 7 });
  });

  it("gives up rather than guess", () => {
    expect(locateVisible("(aaa)", "(zzz)", 0, 0)).toBeNull();
  });
});
