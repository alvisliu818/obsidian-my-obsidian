/**
 * Chrome match pattern 匹配 + 用户脚本 URL 匹配（自 hosts/userscriptInjector
 * 抽出的零依赖模块——匹配语义是油猴直装链的关键路径，单独成模块才好单测）。
 */

/** Chrome match pattern（`<all_urls>` / scheme://host/path，host 支持 `*` 与 `*.`）。 */
export function matchPattern(pattern: string, url: string): boolean {
	if (!pattern) return false;
	if (pattern === "<all_urls>") return true;
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}

	const schemeSep = pattern.indexOf("://");
	if (schemeSep < 0) return false;
	const scheme = pattern.slice(0, schemeSep);
	const rest = pattern.slice(schemeSep + 3);
	const slash = rest.indexOf("/");
	const host = slash < 0 ? rest : rest.slice(0, slash);
	const path = slash < 0 ? "/*" : rest.slice(slash);

	if (scheme !== "*") {
		const want = scheme.replace(/:$/, "");
		if (u.protocol.replace(/:$/, "") !== want) return false;
	} else if (!/^https?:$/.test(u.protocol)) {
		return false;
	}

	if (host !== "*") {
		if (host.startsWith("*.")) {
			const base = host.slice(2);
			if (u.hostname !== base && !u.hostname.endsWith("." + base)) return false;
		} else if (u.hostname !== host) {
			return false;
		}
	}

	if (path !== "/*" && path !== "*") {
		// Only leading/trailing wildcards are handled — enough for real manifests.
		const re = new RegExp(
			"^" +
				path
					.split("*")
					.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
					.join(".*") +
				"$",
		);
		if (!re.test(u.pathname + u.search)) return false;
	}
	return true;
}

/**
 * userScripts 注册条目的 URL 匹配：matches/excludeMatches（match pattern）。
 * excludeMatches 命中即整体排除。
 */
export function userScriptMatches(entry: { matches?: string[]; excludeMatches?: string[] }, rawUrl: string): boolean {
	const matches: string[] = entry.matches || [];
	const excludeMatches: string[] = entry.excludeMatches || [];
	if (excludeMatches.some((p) => safePattern(p, rawUrl))) return false;
	return matches.some((p) => safePattern(p, rawUrl));
}

// TM 系脚本允许非标准通配 host（实测 SEJ: host 写 `**`），标准 match pattern
// 不认 `**` —— 视同任意主机归一后匹配（否则直装条目永不被注入）。
export function safePattern(pattern: string, rawUrl: string): boolean {
	try {
		const norm = /:\/\/\*\*(?:[/?#]|$)/.test(pattern) ? pattern.replace("://**/", "://*/").replace("://**", "://*") : pattern;
		return matchPattern(norm, rawUrl);
	} catch {
		return false;
	}
}
