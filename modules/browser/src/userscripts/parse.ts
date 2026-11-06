/**
 * ==UserScript== 头解析（userscript 标准元数据块）。
 *
 * @match/@include 缺省时回落到安装来源的 origin/*——GreasyFork 等源的脚本
 * 几乎都声明 match/include；没声明的按「来源站点可用」处理比全站生效安全。
 */

export interface ParsedUserScript {
	name: string;
	version: string;
	namespace: string;
	author: string;
	description: string;
	matches: string[];
	excludeMatches: string[];
	grants: string[];
	runAt: "document_start" | "document_end" | "document_idle";
	/** 完整脚本源码（含头注释——注入时头注释无害且便于导出辨识） */
	code: string;
}

function safeBasename(url?: string): string {
	try {
		if (!url) return "";
		const p = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
		return p.replace(/\.user\.js$/i, "");
	} catch {
		return "";
	}
}

export function parseUserScript(source: string, sourceUrl?: string): ParsedUserScript | null {
	const srcUrl = sourceUrl ?? "";
	const block = /\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/.exec(source);
	if (!block) return null;
	const meta: Record<string, string[]> = {};
	for (const line of block[1].split(/\r?\n/)) {
		const mm = /^\s*\/\/\s*@(\S+)\s+(.*)$/.exec(line);
		if (mm) (meta[mm[1]] ??= []).push(mm[2].trim());
	}
	const list = (k: string): string[] => meta[k] ?? [];
	const first = (k: string): string => list(k)[0] ?? "";
	let fallback = "<all_urls>";
	try {
		fallback = new URL(srcUrl).origin + "/*";
	} catch {
		/* 来源不是合法 URL（剪贴板导入）时退全站 */
	}
	const matches = [...list("match"), ...list("include")];
	const runAt = first("run-at").toLowerCase();
	return {
		name: first("name") || safeBasename(srcUrl) || "userscript",
		version: first("version") || "0.0.0",
		namespace: first("namespace"),
		author: first("author"),
		description: first("description"),
		matches: matches.length ? matches : [fallback],
		excludeMatches: [...list("exclude"), ...list("exclude-match")],
		grants: list("grant"),
		runAt:
			runAt === "document-start"
				? "document_start"
				: runAt === "document-end"
					? "document_end"
					: "document_idle",
		code: source,
	};
}

/**
 * 用户脚本匹配判定：@match 是 Chrome match-pattern；@include 是通配符 glob
 * （语义更松）。两者并起来判，`<all_urls>` 与裸 `*` 全过。
 */
export function userScriptMatches(patterns: string[], excludePatterns: string[], url: string): boolean {
	const hit = patterns.some((p) => usMatch(p, url));
	if (!hit) return false;
	return !excludePatterns.some((p) => usMatch(p, url));
}

export function usMatch(pattern: string, url: string): boolean {
	const p = pattern.trim();
	if (!p) return false;
	if (p === "*" || p === "<all_urls>") return true;
	return patternToRegExp(p).test(url);
}

/** glob 片段 → 正则片段：* → .*、? → .、其余元字符转义。 */
function globPart(s: string): string {
	let out = "";
	for (const ch of s) {
		if (ch === "*") out += ".*";
		else if (ch === "?") out += ".";
		else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return out;
}

function patternToRegExp(pattern: string): RegExp {
	// scheme 段允许 *（*:// = 任意协议）
	const m = /^([a-z*][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
	if (m) {
		const scheme = m[1].toLowerCase() === "http" ? "https?" : m[1] === "*" ? "[a-z][a-z0-9+.-]*" : globPart(m[1]);
		const host = m[2] === "*" ? "[^/]*" : globPart(m[2]).replace(/^\.\*\\\./, "(?:[^/]*\\.)?");
		const path = globPart(m[3] ?? "/");
		return new RegExp(`^${scheme}://${host}${path}$`, "i");
	}
	return new RegExp(`^${globPart(pattern)}$`, "i");
}
