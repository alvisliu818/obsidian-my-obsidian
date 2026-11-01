/**
 * 原生 Markdown 编辑器的 @ 检索：输入 `@` 唤起文件建议（文件名模糊匹配 +
 * omnisearch 全文兜底），回车/点击后把查询串替换为
 * `[文件名](obsidian://open?vault=<库名>&file=<路径>)` —— 用 URI 而非相对
 * wikilink，链接点开时走 Obsidian 的 URI 路由，对库外挂载/外部打开也一致。
 */
import {
	Editor,
	type EditorPosition,
	EditorSuggest,
	type EditorSuggestContext,
	type EditorSuggestTriggerInfo,
	type Plugin,
	TFile,
	prepareFuzzySearch,
} from "obsidian";

interface AtSuggestion {
	file: TFile;
	/** omnisearch 内容命中时的摘要；文件名命中时为空。 */
	excerpt?: string;
}

interface OmnisearchApi {
	search(q: string): Promise<Array<{ path: string; basename: string; excerpt: string }>>;
}

const MAX_SUGGESTIONS = 30;

export function registerAtLinkSuggest(plugin: Plugin): void {
	plugin.registerEditorSuggest(new AtLinkSuggest(plugin));
}

class AtLinkSuggest extends EditorSuggest<AtSuggestion> {
	constructor(host: Plugin) {
		super(host.app);
		this.setInstructions([{ command: "↵", purpose: "插入 obsidian:// 链接" }]);
	}

	/**
	 * 每次按键都会进来，保持轻量：只做一次 lastIndexOf。
	 * `@` 允许出现在行内任意位置（中文输入没有敲空格的习惯，要求 `@` 前是
	 * 空白/行首会导致紧跟汉字时弹窗不出现）；查询词取 `@` 到光标，允许空格，
	 * 便于匹配带空格的文件名与 omnisearch 多关键词。
	 */
	onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
		if (cursor.ch === 0) return null;
		const line = editor.getLine(cursor.line);
		const idx = line.lastIndexOf("@", cursor.ch - 1);
		if (idx === -1) return null;
		return {
			start: { line: cursor.line, ch: idx },
			end: cursor,
			query: line.slice(idx + 1, cursor.ch),
		};
	}

	async getSuggestions(ctx: EditorSuggestContext): Promise<AtSuggestion[]> {
		const files = this.app.vault.getFiles();
		const query = ctx.query;
		if (!query) {
			// 空查询：最近改动的文件
			return [...files]
				.sort((a, b) => b.stat.mtime - a.stat.mtime)
				.slice(0, MAX_SUGGESTIONS)
				.map((file) => ({ file }));
		}

		const fuzzy = prepareFuzzySearch(query);
		const nameHits: Array<{ file: TFile; score: number }> = [];
		for (const file of files) {
			const hit = fuzzy(file.path);
			if (hit) nameHits.push({ file, score: hit.score });
		}
		nameHits.sort((a, b) => a.score - b.score);

		const suggestions: AtSuggestion[] = nameHits
			.slice(0, MAX_SUGGESTIONS)
			.map(({ file }) => ({ file }));

		// 名字命中没占满时，用 omnisearch 的全文检索补"内容"命中（模块未启用
		// 或索引未就绪时 contentSearch 返回空，@ 仍是纯文件名检索）。
		if (suggestions.length < MAX_SUGGESTIONS) {
			const byPath = new Map(files.map((f) => [f.path, f]));
			const seen = new Set(suggestions.map((s) => s.file.path));
			for (const hit of await this.contentSearch(query)) {
				if (suggestions.length >= MAX_SUGGESTIONS) break;
				const file = byPath.get(hit.path);
				if (file && !seen.has(file.path)) {
					seen.add(file.path);
					suggestions.push({ file, excerpt: hit.excerpt });
				}
			}
		}
		return suggestions;
	}

	private async contentSearch(
		query: string,
	): Promise<Array<{ path: string; excerpt: string }>> {
		const api = (
			this.app.plugins?.plugins?.["my-omnisearch"] as unknown as {
				api?: OmnisearchApi;
			} | undefined
		)?.api;
		if (!api) return [];
		try {
			const results = await api.search(query);
			return results.map((r) => ({
				path: r.path,
				excerpt: r.excerpt.replace(/\s+/g, " ").trim(),
			}));
		} catch {
			return [];
		}
	}

	renderSuggestion(sugg: AtSuggestion, el: HTMLElement): void {
		el.addClass("at-link-suggest");
		el.createDiv({ cls: "suggestion-title" }).setText(sugg.file.basename);
		el.createDiv({ cls: "suggestion-subtext" }).setText(
			sugg.excerpt ?? sugg.file.path,
		);
	}

	selectSuggestion(sugg: AtSuggestion, _evt: MouseEvent | KeyboardEvent): void {
		const ctx = this.context;
		if (!ctx) return;
		// 链接文本里的方括号会吞掉 markdown 链接的右括号边界，转义掉。
		const name = sugg.file.basename.replace(/[[\]]/g, "\\$&");
		const url =
			`obsidian://open?vault=${encodeURIComponent(this.app.vault.getName())}` +
			`&file=${encodeURIComponent(sugg.file.path)}`;
		ctx.editor.replaceRange(`[${name}](${url})`, ctx.start, ctx.end);
	}
}
