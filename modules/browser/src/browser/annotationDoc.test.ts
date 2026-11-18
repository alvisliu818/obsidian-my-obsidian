/**
 * 标注笔记 Markdown 序列化/解析 roundtrip 测试。
 * 覆盖：转义链接文本、base64 元数据、嵌套批注、页面级标注、坏数据兜底。
 */
import { describe, expect, it } from "vitest";

import {
  escapeLinkText,
  normalizeUrlKey,
  parseAnnotationDoc,
  rebuildAnchorLine,
  safeTitle,
} from "./annotationDoc";

/** 与 annotation.ts create() 同构的一行锚点序列化（测试用复刻） */
function makeAnchorLine(item: {
  id: string;
  quote: string;
  prefix?: string;
  suffix?: string;
  color?: string;
  created?: number;
  tags?: string[];
}, pageUrl: string): string {
  const annUrl = pageUrl + "#syann=" + item.id;
  return "- [" + escapeLinkText(item.quote) + "](" + annUrl + ") <!--syann:" + b64(item) + "-->";
}

function b64(o: unknown): string {
  return Buffer.from(JSON.stringify(o), "utf8").toString("base64");
}

describe("normalizeUrlKey", () => {
  it("去 hash，保留 origin+path+search", () => {
    expect(normalizeUrlKey("https://a.com/p?x=1#frag")).toBe("https://a.com/p?x=1");
    expect(normalizeUrlKey("https://a.com/p#syann=ann-1")).toBe("https://a.com/p");
  });
});

describe("safeTitle", () => {
  it("清洗文件系统非法字符", () => {
    expect(safeTitle('a/b\\c:d*e?f"g<h>i|j#k')).toBe("a b c d e f g h i j k");
    expect(safeTitle("")).toBe("未命名页面");
    expect(safeTitle("x".repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe("escapeLinkText", () => {
  it("转义并还原 []", () => {
    const raw = "foo [bar] baz";
    const esc = escapeLinkText(raw);
    expect(esc).toBe("foo \\[bar\\] baz");
    expect(parseAnnotationDoc("- [" + esc + "](https://a.com#syann=x)")[0].quote).toBe(raw);
  });
});

describe("parseAnnotationDoc", () => {
  it("frontmatter/来源行不误判为标注", () => {
    const doc = [
      "---",
      'url: "https://a.com/x"',
      "domain: a.com",
      "created: 2026-11-18",
      "---",
      "",
      "- [来源](https://a.com/x)",
      "- 创建于 2026-11-18",
      "",
    ].join("\n");
    expect(parseAnnotationDoc(doc)).toEqual([]);
  });

  it("选区标注：引用/元数据/嵌套批注 roundtrip", () => {
    const url = "https://a.com/x?y=1";
    const urlKey = normalizeUrlKey(url);
    const item = {
      id: "ann-abc-123",
      quote: "被标注的一段文字",
      prefix: "前文三十字",
      suffix: "后文三十字",
      color: "blue",
      created: 1700000000000,
      tags: ["重点", "待读"],
    };
    const doc = [
      "---",
      'url: "' + url + '"',
      "domain: a.com",
      "---",
      "",
      "- [来源](" + url + ")",
      "",
      makeAnchorLine(item, url),
      "    - 第一行批注",
      "      第二行续行",
      "",
      "用户自己加的段落不该被吃掉",
    ].join("\n");
    const items = parseAnnotationDoc(doc);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(item.id);
    expect(items[0].quote).toBe(item.quote);
    expect(items[0].prefix).toBe(item.prefix);
    expect(items[0].suffix).toBe(item.suffix);
    expect(items[0].color).toBe("blue");
    expect(items[0].tags).toEqual(["重点", "待读"]);
    expect(items[0].note).toBe("第一行批注\n第二行续行");
    expect(doc).toContain(urlKey.slice(0, 10));
  });

  it("页面级标注（无 #syann 片段，元数据带 id）", () => {
    const url = "https://b.com/";
    const line =
      "- [某页面标题](" + url + ") - 2026-11-18 09:30 <!--syann:" +
      b64({ id: "ann-page-1", url, quote: "", prefix: "", suffix: "", created: 5, color: "yellow", tags: [] }) +
      "-->";
    const items = parseAnnotationDoc(line);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("ann-page-1");
    expect(items[0].quote).toBe("");
    expect(items[0].created).toBe(5);
  });

  it("多行批注与空批注行安全", () => {
    const url = "https://c.com/";
    const doc =
      "- [引用](" + url + "#syann=ann-2) <!--syann:" + b64({ id: "ann-2", url, quote: "引用", prefix: "", suffix: "", created: 1, color: "pink", tags: [] }) + "-->";
    const items = parseAnnotationDoc(doc);
    expect(items[0].note).toBe("");
    expect(items[0].color).toBe("pink");
  });

  it("坏 base64/坏 JSON 的行按引用文本兜底解析，不抛错", () => {
    const doc = "- [兜底引用](https://d.com#syann=ann-9) <!--syann:!!!notb64!-->";
    const items = parseAnnotationDoc(doc);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("ann-9");
    expect(items[0].quote).toBe("兜底引用");
    expect(items[0].color).toBe("yellow");
  });
});

describe("rebuildAnchorLine", () => {
  it("原位改颜色/标签，链接文本不变", () => {
    const url = "https://e.com/x";
    const line = makeAnchorLine(
      { id: "ann-r", quote: "一段[带括号]的引用", prefix: "p", suffix: "s", color: "yellow", created: 42, tags: [] },
      url,
    );
    const rebuilt = rebuildAnchorLine(line, {
      id: "ann-r",
      url,
      quote: "一段[带括号]的引用",
      prefix: "p",
      suffix: "s",
      created: 42,
      color: "green",
      tags: ["新标签"],
    });
    const items = parseAnnotationDoc(rebuilt);
    expect(items[0].color).toBe("green");
    expect(items[0].tags).toEqual(["新标签"]);
    expect(items[0].quote).toBe("一段[带括号]的引用");
    expect(rebuilt).toContain("#syann=ann-r");
  });
});

describe("rect 标注 roundtrip（b8b26f2/35ae788 对齐）", () => {
  it("kind/rect/shot 元数据与 ![[嵌入]] 行解析", () => {
    const url = "https://r.com/page";
    const meta = {
      id: "ann-rect-1", url: normalizeUrlKey(url), quote: "", prefix: "", suffix: "",
      created: 99, color: "yellow", tags: [],
      kind: "rect", rect: { x: 12, y: 340, w: 300, h: 120 }, shot: "Browser/Annotations/assets/r.com/annot-x.png",
    };
    const doc = [
      "- [框选](" + url + "#syann=ann-rect-1) <!--syann:" + Buffer.from(JSON.stringify(meta), "utf8").toString("base64") + "-->",
      "    ![[Browser/Annotations/assets/r.com/annot-x.png]]",
      "    - 截图批注",
    ].join("\n");
    const items = parseAnnotationDoc(doc);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("rect");
    expect(items[0].rect).toEqual({ x: 12, y: 340, w: 300, h: 120 });
    expect(items[0].shot).toBe("Browser/Annotations/assets/r.com/annot-x.png");
    // 嵌入行不混进批注正文
    expect(items[0].note).toBe("截图批注");
  });

  it("hlOff/inlineOff 状态 roundtrip（取消高亮/小字）", () => {
    const meta = {
      id: "ann-hl-1", url: "https://x.com/", quote: "文字", prefix: "", suffix: "",
      created: 1, color: "yellow", tags: [], hlOff: true, inlineOff: false,
    };
    const doc = "- [文字](https://x.com/#syann=ann-hl-1) <!--syann:" + Buffer.from(JSON.stringify(meta), "utf8").toString("base64") + "-->";
    const items = parseAnnotationDoc(doc);
    expect(items[0].hlOff).toBe(true);
    expect(items[0].inlineOff).toBe(false);
  });
});
