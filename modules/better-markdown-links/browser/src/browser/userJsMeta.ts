/**
 * .user.js 头解析（纯函数，无 IO）——从 URL 下载的脚本内容解析
 * ==UserScript== 元数据，供安装确认弹窗与直装注册使用。
 */

export interface UserScriptMeta {
	name: string;
	version: string;
	author: string;
	description: string;
	matches: string[];
}

/** 解析 ==UserScript== 头；没有头或 @match/@include 全缺时返回 null（调用方给错误提示 / 兜底 all_urls）。 */
export function parseUserScript(code: string, url: string): UserScriptMeta | null {
	if (!/==\s*UserScript\s*==/.test(code)) return null;
	const meta = (k: string): string => {
		const m = code.match(new RegExp("//\\s*@" + k + "\\s+([^\\r\\n]+)", "i"));
		return m ? m[1].trim() : "";
	};
	const fname = decodeURIComponent(url.split("?")[0].split("/").pop() || "").replace(/\.user\.js$/i, "");
	const matches: string[] = [];
	const re = new RegExp("//\\s*@(match|include)\\s+([^\\r\\n]+)", "gi");
	let mm: RegExpExecArray | null;
	while ((mm = re.exec(code))) {
		const pat = mm[2].trim();
		if (pat && !matches.includes(pat)) matches.push(pat);
	}
	if (!matches.length) return null;
	return {
		name: meta("name") || fname || "userscript",
		version: meta("version"),
		author: meta("author"),
		description: meta("description"),
		matches,
	};
}
