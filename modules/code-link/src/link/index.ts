import { TFile } from "obsidian";
import { TagPath } from "../lang/tree";
import { getLang } from "../lang/utils";
import CodeLinkPlugin from "../main";
import { lineWindow, memorize } from "../utils";

export const codeLinkInnerRe =
	/(?<fileLink>[^#|\]]+)(?:#(?<tagPath>[^#|\]]+))?(?:\|(?<alias>[^#|\]]+))?/;

export const codeLinkRe =
	/\[\[(?<fileLink>[^#|\]]+)(?:#(?<tagPath>[^#|\]]+))?(?:\|(?<alias>[^#|\]]+))?\]\](?<query>[^\s]*)?$/;

export const mdCodeLinkRe =
	/\[(?<alias>[^\]]+)?\]\((?<fileLink>[^#|)]+)(?:#(?<tagPath>[^#|)]+))?\)(?<query>[^\s]*)?$/;

type CodeLinkType = "inner" | "md" | "wiki";

export class CodeLinkItem {
	constructor(
		private _plugin: CodeLinkPlugin,
		readonly sourcePath: string,
		readonly text: string,
		readonly fileLink: string,
		readonly type: CodeLinkType,
		readonly rawTagPath: string | null,
		readonly alias: string | null,
		readonly query: string | null
	) {}

	@memorize
	get file(): TFile | null {
		return this._plugin.app.metadataCache.getFirstLinkpathDest(
			this.fileLink,
			this.sourcePath
		);
	}

	async fileContent(): Promise<string | null> {
		return this.file && this._plugin.app.vault.cachedRead(this.file);
	}

	@memorize
	get lang(): string | null {
		return getLang(this.fileLink);
	}

	/**
	 * 行锚:subpath 是 `L<数字>` 时按行锚解读([[file.py#L42]]),与聚合仓
	 * ExternalCodeView 的行链接体系([[file#L42]] 点击跳行)互通——同一种链接,
	 * 这边负责悬浮/嵌入的行窗口预览。不再当符号路径。
	 */
	@memorize
	get line(): number | null {
		const m = this.rawTagPath ? /^L(\d+)$/.exec(this.rawTagPath) : null;
		return m ? Number(m[1]) : null;
	}

	@memorize
	get tagPath(): TagPath | null {
		// 行锚不是符号路径,不能进 tree-sitter 查询(会把 L42 当标识符找)
		return this.rawTagPath && this.line === null
			? TagPath.from(this.rawTagPath)
			: null;
	}

	async tagContent(): Promise<string | null> {
		if (!this.tagPath || !this.file) {
			return null;
		}

		const tree = await this._plugin.parser.parse(this.file);
		const node = tree?.at(this.tagPath);

		return node?.content || null;
	}

	async content(): Promise<string | null> {
		// 行锚优先:目标行 ± 上下文的窗口(带行号),而非整文件
		if (this.line !== null) {
			const text = await this.fileContent();
			return text === null ? null : lineWindow(text, this.line);
		}
		return (await this.tagContent()) || (await this.fileContent());
	}

	private static _from(
		plugin: CodeLinkPlugin,
		sourcePath: string,
		type: CodeLinkType,
		match: RegExpMatchArray | null
	): CodeLinkItem | null {
		const groups = match?.groups;
		if (!groups) {
			return null;
		}

		const text = match[0];
		const fileLink = groups.fileLink;
		const rawTagPath = groups.tagPath || null;
		const alias = groups.alias || null;
		const query = groups.query || null;

		if (!fileLink) {
			return null;
		}

		return new CodeLinkItem(
			plugin,
			sourcePath,
			text,
			fileLink,
			type,
			rawTagPath,
			alias,
			query
		);
	}

	static from(
		plugin: CodeLinkPlugin,
		sourcePath: string,
		text: string
	): CodeLinkItem | null {
		for (const [type, re] of Object.entries({
			wiki: codeLinkRe,
			md: mdCodeLinkRe,
		} as const)) {
			const match = text.match(re);
			if (!match) {
				continue;
			}

			return this._from(plugin, sourcePath, type as CodeLinkType, match);
		}

		return null;
	}

	static fromInner(
		plugin: CodeLinkPlugin,
		sourcePath: string,
		text: string
	): CodeLinkItem | null {
		const match = text.match(codeLinkInnerRe);
		if (!match) {
			return null;
		}

		return this._from(plugin, sourcePath, "inner", match);
	}
}
