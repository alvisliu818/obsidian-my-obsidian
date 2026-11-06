/**
 * 用户脚本解析与匹配测试（原生 userscript 管理,2026-11-07）。
 * parse.ts 全部为纯函数——直接测语义,无需 Obsidian 环境。
 */
import { describe, expect, it } from "vitest";
import { parseUserScript, userScriptMatches } from "./parse";

describe("parseUserScript", () => {
  it("解析标准 ==UserScript== 头", () => {
    const src = `// ==UserScript==
// @name        Test Script
// @version     1.2.3
// @namespace   ns/example
// @author      someone
// @description a test script
// @match       https://example.com/*
// @exclude     https://example.com/private/*
// @grant       GM_setValue
// @grant       GM_xmlhttpRequest
// @run-at      document-end
// ==/UserScript==
console.log("body");`;
    const p = parseUserScript(src, "https://example.com/script.user.js");
    expect(p).not.toBeNull();
    expect(p!.name).toBe("Test Script");
    expect(p!.version).toBe("1.2.3");
    expect(p!.namespace).toBe("ns/example");
    expect(p!.author).toBe("someone");
    expect(p!.description).toBe("a test script");
    expect(p!.matches).toEqual(["https://example.com/*"]);
    expect(p!.excludeMatches).toEqual(["https://example.com/private/*"]);
    expect(p!.grants).toEqual(["GM_setValue", "GM_xmlhttpRequest"]);
    expect(p!.runAt).toBe("document_end");
    expect(p!.code).toBe(src);
  });

  it("无 match/include 时回落安装来源 origin/*", () => {
    const src = `// ==UserScript==\n// @name NoMatch\n// ==/UserScript==\n1`;
    const p = parseUserScript(src, "https://src.example.org/scripts/x.user.js");
    expect(p!.matches).toEqual(["https://src.example.org/*"]);
  });

  it("缺 ==UserScript== 头返回 null", () => {
    expect(parseUserScript("console.log('no header')", "https://a.com/x.js")).toBeNull();
  });

  it("无 @name 时用来源文件名去 .user.js 后缀", () => {
    const src = `// ==UserScript==\n// @match *://*/*\n// ==/UserScript==\n`;
    const p = parseUserScript(src, "https://a.com/scripts/cool-tool.user.js");
    expect(p!.name).toBe("cool-tool");
  });

  it("真实世界头部样本:非标准键容忍 + @require 相对地址解析 + @noframes", () => {
    const src = `// ==UserScript==
// @name         Real World Script
// @namespace    https://github.com/author/repo
// @version      2.4.1
// @description  一个真实世界的脚本:带非标准键与相对 @require
// @author       author
// @homepageURL  https://github.com/author/repo#readme
// @supportURL   https://github.com/author/repo/issues
// @icon         https://img.example.com/icon.png
// @license      MIT
// @match        https://target.example/*://forum.target.example/*
// @require      https://cdn.example/lib.js
// @require      ../libs/relative-lib.js
// @resource     cssRes https://cdn.example/style.css
// @grant        GM_getValue
// @grant        none
// @noframes
// @antifeature  ads-referral 本地化说明
// ==/UserScript==`;
    const p = parseUserScript(src, "https://github.com/author/repo/raw/main/script.user.js");
    expect(p!.name).toBe("Real World Script");
    expect(p!.requires).toEqual([
      { url: "https://cdn.example/lib.js" },
      { url: "https://github.com/author/repo/raw/libs/relative-lib.js" },
    ]);
    expect(p!.noframes).toBe(true);
    expect(p!.grants).toEqual(["GM_getValue", "none"]);
    expect(p!.matches[0]).toBe("https://target.example/*://forum.target.example/*");
  });

  it("未知 run-at 落 document_idle", () => {
    const src = `// ==UserScript==\n// @name X\n// @run-at whatever\n// ==/UserScript==\n`;
    expect(parseUserScript(src, "https://a.com/x.user.js")!.runAt).toBe("document_idle");
  });
});

describe("userScriptMatches", () => {
  it.each([
    ["http://127.0.0.1:18777/*", "http://127.0.0.1:18777/page", true],
    ["http://127.0.0.1:18777/*", "http://127.0.0.1:18777/", true],
    ["https://greasyfork.org/*", "https://greasyfork.org/scripts", true],
    ["https://greasyfork.org/*", "http://greasyfork.org/x", false],
    ["*://*.example.com/*", "https://a.example.com/p", true],
    // Chrome match-pattern 语义：*.example.com 连主域一起匹配
    ["*://*.example.com/*", "https://example.com/p", true],
    ["*://example.com/*", "https://example.com/p", true],
    ["*://example.com/*", "https://other.com/p", false],
  ])("%s vs %s → %s", (pattern, url, want) => {
    expect(userScriptMatches([pattern as string], [], url as string)).toBe(want);
  });

  it("<all_urls> 与裸 * 全过", () => {
    expect(userScriptMatches(["<all_urls>"], [], "anything://x/y")).toBe(true);
    expect(userScriptMatches(["*"], [], "https://anything/x")).toBe(true);
  });

  it("exclude 命中则不匹配", () => {
    expect(
      userScriptMatches(["https://example.com/*"], ["https://example.com/private/*"], "https://example.com/private/x"),
    ).toBe(false);
  });
});
