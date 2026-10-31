import { Parser, Language, Query } from "web-tree-sitter";
import { Notice, requestUrl, RequestUrlResponse } from "obsidian";
import CodeLinkPlugin from "../main";
import { AvailableWasmLangs, LangScmMap } from "./data";
import { withRetry } from "../utils";

/**
 * Version of @cursorless/tree-sitter-wasms package used for downloading language parsers.
 * This is separate from the web-tree-sitter runtime (different packages with
 * independent versioning schemes).
 */
const TREE_SITTER_WASMS_VERSION = "0.7.0";

/**
 * 聚合适配（独立版从 jsdelivr CDN 拉 tree-sitter.wasm）：esbuild 构建期内嵌
 * 安装的 web-tree-sitter 包里的 tree-sitter.wasm（见根 esbuild.mjs 的
 * __TREE_SITTER_WASM_B64__ define，同 wa-sqlite/onig/jieba 的先例）——
 * glue 与 wasm 出自同一份包，消灭版本漂移，运行时不再依赖 CDN。
 */
declare const __TREE_SITTER_WASM_B64__: string | undefined;

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export class TreeSitterLoader {
	private _initialized = false;

	constructor(_plugin: CodeLinkPlugin) {}

	async init() {
		if (this._initialized) return;

		try {
			// `wasmBinary` 短路 Emscripten 的取件分支（同 logseq 的 wa-sqlite 装载）；
			// locateFile 必须给——不给时 findWasmBinary 会走
			// `new URL('web-tree-sitter.wasm', import.meta.url)`，而聚合 bundle 里
			// import.meta.url 被 define 成空串，直接抛 Invalid base URL。
			// 类型声明是 ArrayBuffer，运行时收 BufferSource（Uint8Array 也可）。
			const b64 =
				typeof __TREE_SITTER_WASM_B64__ === "string" ? __TREE_SITTER_WASM_B64__ : "";
			if (!b64) throw new Error("tree-sitter wasm is not embedded in this build");

			await Parser.init({
				wasmBinary: base64ToBytes(b64).buffer,
				locateFile: () => "web-tree-sitter.wasm",
			});
			this._initialized = true;
		} catch (err) {
			console.error("Failed to initialize web-tree-sitter:", err);
			new Notice(
				"CodeLink: Failed to initialize the code parsing engine. Some features may not work."
			);
			throw err;
		}
	}

	async load(): Promise<typeof Parser> {
		await this.init();
		return Parser;
	}
}

export class LangLoader {
	private _cache: Map<string, Language> = new Map();
	private _loading: Map<string, AbortController> = new Map();

	constructor(private _plugin: CodeLinkPlugin) {}

	async load(langName: string): Promise<Lang> {
		if (!AvailableWasmLangs.includes(langName)) {
			throw new Error(`Language ${langName} is not available.`);
		}

		await this._plugin.treeSitterLoader.init();

		if (this._cache.has(langName)) {
			return new Lang(langName, this._cache.get(langName)!);
		}

		if (this._loading.has(langName)) {
			throw new Error(`Language ${langName} is already loading.`);
		}

		const controller = new AbortController();
		this._loading.set(langName, controller);

		let loadSuccessful = false;

		try {
			const url = `https://cdn.jsdelivr.net/npm/@cursorless/tree-sitter-wasms@${TREE_SITTER_WASMS_VERSION}/out/tree-sitter-${langName}.wasm`;

			const response = (await withRetry(async () => {
				return await requestUrl(url);
			}, 3, 1000, controller.signal)) as RequestUrlResponse;

			if (controller.signal.aborted) {
				throw new Error("aborted");
			}

			const langWasm = response.arrayBuffer;
			const lang = await Language.load(new Uint8Array(langWasm));
			this._cache.set(langName, lang);

			loadSuccessful = true;
			return new Lang(langName, lang);
		} finally {
			this._loading.delete(langName);
			if (!loadSuccessful && !controller.signal.aborted) {
				controller.abort();
			}
		}
	}

	unload(langName: string) {
		this.abort(langName);
		this._cache.delete(langName);
	}

	abort(langName: string) {
		const controller = this._loading.get(langName);
		if (controller) {
			controller.abort();
			this._loading.delete(langName);
		}
	}

	isLoaded(langName: string): boolean {
		return this._cache.has(langName);
	}

	isLoading(langName: string): boolean {
		return this._loading.has(langName);
	}

	async preDownload(langs: string[]) {
		const total = langs.length;
		let count = 0;

		const notice = new Notice(`CodeLink: Pre-downloading parsers (0/${total})...`, 0);

		for (const lang of langs) {
			try {
				await this.load(lang);
				count++;
				notice.setMessage(`CodeLink: Pre-downloading parsers (${count}/${total})...`);
			} catch (err) {
				console.error(`Failed to pre-download ${lang}:`, err);
			}
		}

		notice.hide();
		if (count > 0) {
			new Notice(`CodeLink: Finished pre-downloading ${count} parsers.`);
		}
	}
}

export class Lang {
	constructor(
		private _name: string,
		private _lang: Language
	) {}

	async parser(): Promise<Parser> {
		const parser = new Parser();
		parser.setLanguage(this._lang);
		return parser;
	}

	async tagsQuery(): Promise<Query | null> {
		const scm = (LangScmMap as Record<string, string>)[this._name];
		if (!scm) return null;
		return new Query(this._lang, scm);
	}

	get name(): string {
		return this._name;
	}
}
