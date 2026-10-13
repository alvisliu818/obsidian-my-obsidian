/**
 * My Obsidian — one plugin hosting several of the author's add-ons.
 *
 * Each module is the ORIGINAL plugin class, unmodified: it still calls
 * `this.loadData()` / `this.saveData()` and still thinks it owns its data.json.
 * What makes four of them coexist is two things done here:
 *
 *  1. every instance gets its own slice of our single data.json (its `loadData`
 *     returns `settings.modules[id].data`, its `saveData` writes it back), and
 *  2. it is handed the host's manifest, so `manifest.dir` points at the one
 *     real plugin folder — sidecar files (wasm, preload scripts) land in the
 *     same place they did before.
 *
 * That is the whole trick. No module had to be rewritten to become a module.
 */
import { Notice, Plugin } from "obsidian";
import type { App, PluginManifest } from "obsidian";
import {
	DEFAULT_SETTINGS,
	MyObsidianSettingTab,
	defaultModuleState,
	type ModuleDescriptor,
	type ModuleState,
	type MyObsidianSettings,
	type SubPluginLike,
} from "./settings";

import LogseqEditorPlugin from "../modules/logseq/src/main";
import BrowserPlugin from "../modules/browser/src/main";
import JupyterNotebookPlugin from "../modules/jupyter/src/main";
import BreadcrumbNavPlugin from "../modules/breadcrumb/src/main";
import DocAssistPlugin from "../modules/doc-assist/src/main";
import MaterialIconThemePlugin from "../modules/material-icon-theme/src/main";
import TraceTimePlugin from "../modules/tracetime/src/main";
import AIImageAnalyzerPlugin from "../modules/ai-image-analyzer/src/main";
import OmnisearchPlugin from "../modules/omnisearch/src/main";
import SaveControlPlugin from "../modules/save-control/src/main";
import { CodeFileView, DEFAULT_CODE_EXTENSIONS, VIEW_TYPE_CODE_FILE } from "./codeFileView";

export default class MyObsidianPlugin extends Plugin {
	settings: MyObsidianSettings = DEFAULT_SETTINGS;

	/** Loaded modules, by id. */
	private readonly live = new Map<string, SubPluginLike>();
	/** Old plugin ids we re-published into the app's plugin table. */
	private readonly aliases: string[] = [];

	readonly descriptors: ModuleDescriptor[] = [
		{
			id: "logseq",
			// The id other modules look this one up by (jupyter reads
			// `pythonEnvs` off it, breadcrumb reads its mount list).
			legacyId: "obsidian-logseq",
			name: "Logseq Editor",
			summary: "Logseq 式块大纲编辑器：折叠、缩放、块引用、任务、SQLite 索引，以及库外文件的虚拟文档树。",
			desktopOnly: true,
			cls: LogseqEditorPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "browser",
			legacyId: "obsidian-browser",
			name: "Browser",
			summary: "库内的多标签浏览器：地址栏、书签、历史、下载、网页剪藏与 Chrome 扩展支持。",
			desktopOnly: true,
			cls: BrowserPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "jupyter",
			legacyId: "obsidian-jupyter-notebook",
			name: "Jupyter Notebook",
			summary: "在库里查看、编辑并运行 .ipynb，自带常驻 Python 内核。",
			desktopOnly: true,
			cls: JupyterNotebookPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "breadcrumb",
			legacyId: "breadcrumb-nav",
			name: "Breadcrumb Nav",
			summary: "笔记顶部的面包屑（文件 › 标题 / 块层级），支持悬浮查看同级与逐级下钻。",
			desktopOnly: false,
			cls: BreadcrumbNavPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "doc-assist",
			legacyId: "obsidian-doc-assist",
			name: "Doc Assist",
			summary:
				"文档加工流水线：剪藏清洗（多余空行 / 行尾空白 / 列表前缀 / AI 报告残留）、中英文加空格与标点互转、列表段落整理、断尾求真删区间。",
			desktopOnly: true,
			cls: DocAssistPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "material-icon-theme",
			// Same id before and after the merge: this module is a THIRD-PARTY
			// plugin (GilbertzzzZZ, MIT) kept whole, not our own code, so the
			// alias has to be its real upstream id.
			legacyId: "material-icon-theme",
			name: "Material Icon Theme",
			summary:
				"文件浏览器换上 Material Design 图标：按文件名 / 扩展名 / 文件夹名匹配，含 Obsidian 专有的 canvas、base。上游 GilbertzzzZZ（MIT）。",
			desktopOnly: false,
			cls: MaterialIconThemePlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "tracetime",
			// Third-party too (QuincySx, MIT), kept as the user's own fork of it.
			legacyId: "tracetime",
			name: "TraceTime",
			summary:
				"在每个段落旁显示它最后一次被编辑的时间，编辑器与阅读模式都有；记录存在本地，不联网。上游 QuincySx（MIT）。",
			desktopOnly: false,
			cls: TraceTimePlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// GPL-3.0: merging it in is what switched the whole repo to GPL-3.
			// Kept whole, upstream is Swaggeroo.
			id: "ai-image-analyzer",
			legacyId: "ai-image-analyzer",
			name: "AI image analyzer",
			summary:
				"用 AI 给图片生成关键词：Gemini / Ollama 等接口，支持批量分析、按关键词反查图片，结果缓存本地。上游 Swaggeroo（GPL-3.0）。",
			desktopOnly: true,
			cls: AIImageAnalyzerPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// GPL-3 as well — upstream Simon Cambier. Its Svelte components build
			// through the same esbuild (see the svelte plugin in esbuild.mjs).
			id: "omnisearch",
			legacyId: "omnisearch",
			name: "Omnisearch",
			summary:
				"库内全文搜索引擎：拼音容错、按路径/标签/区块过滤、文件内搜索与 API。上游 Simon Cambier（GPL-3）。",
			desktopOnly: false,
			cls: OmnisearchPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// 两个上游 MIT 插件的合并（见 modules/save-control/NOTICE.md）。库外
			// 文件支持依赖 Node fs（快照/读写），只承诺桌面端。
			id: "save-control",
			legacyId: "save-history",
			name: "Save Control",
			summary:
				"自动保存节奏控制 + 文件版本历史（save-history 与 autosave-control 合并）：延迟落盘、状态栏待保存指示、标签页未保存圆点与关闭提示；虚拟文档树挂载的库外文件同样支持。上游 Sevoni（MIT）+ mihasm（MIT）。",
			desktopOnly: true,
			cls: SaveControlPlugin as unknown as ModuleDescriptor["cls"],
		},
	];

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(
			new MyObsidianSettingTab(this.app, this, {
				settings: this.settings,
				descriptors: this.descriptors,
				save: () => this.saveSettings(),
				reload: (id) => this.enableModule(id),
			}),
		);
		for (const d of this.descriptors) await this.bootModule(d);
		this.registerCodeFiles();
	}

	// ------------------------------------------------------------------
	// 宿主自己的功能：库内代码文件
	// ------------------------------------------------------------------

	/**
	 * Take over the code extensions Obsidian has no view for, and add a
	 * "run the current file" command.
	 *
	 * The extension list is a setting, not a constant: the point is that these
	 * files currently open as an empty placeholder, so claiming them costs
	 * nothing — but a user who wants `.json` handled by something else can drop
	 * it without rebuilding Markdown is never in the list.
	 */
	private registerCodeFiles(): void {
		const exts = (this.settings.codeFileExtensions ?? DEFAULT_CODE_EXTENSIONS).filter(
			(e) => !!e && !/^(md|canvas)$/i.test(e),
		);
		this.registerView(VIEW_TYPE_CODE_FILE, (leaf) => new CodeFileView(leaf));
		if (exts.length) this.registerExtensions(exts, VIEW_TYPE_CODE_FILE);

		this.addCommand({
			id: "run-code-file",
			name: "运行当前代码文件",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(CodeFileView);
				if (!view?.file) return false;
				if (!checking) void view.runCurrentFile();
				return true;
			},
		});
	}

	/** Which modules actually came up. Used by the e2e probe and handy in the
	 *  console when a feature looks missing. */
	loadedModuleIds(): string[] {
		return Array.from(this.live.keys());
	}

	onunload(): void {
		// Leave the app's plugin table exactly as we found it.
		const table = (
			this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }
		).plugins?.plugins;
		for (const alias of this.aliases) if (table) delete table[alias];
		for (const [id, inst] of this.live) {
			try {
				inst.onunload?.();
			} catch (e) {
				console.error(`[my-obsidian] ${id} failed to unload`, e);
			}
		}
		this.live.clear();
	}

	// ------------------------------------------------------------------

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<MyObsidianSettings> | null;
		this.settings = { modules: {} };
		for (const d of this.descriptors) {
			this.settings.modules[d.id] = Object.assign(
				defaultModuleState(d.desktopOnly),
				raw?.modules?.[d.id],
			);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Boot a module if its switch is on. A failing module must not take the
	 *  others down with it — one broken feature should not brick the plugin. */
	private async bootModule(d: ModuleDescriptor): Promise<void> {
		const bootlog = ((window as unknown as { __bootlog?: string[] }).__bootlog ??= []);
		const state = this.settings.modules[d.id];
		if (!state?.enabled) {
			console.debug(`[my-obsidian] ${d.id}: disabled, skip`);
			bootlog.push(`${d.id}: disabled`);
			return;
		}
		if (this.live.has(d.id)) return;
		try {
			console.debug(`[my-obsidian] booting ${d.id}...`);
			bootlog.push(`${d.id}: booting`);
			await this.startModule(d, state);
			console.debug(`[my-obsidian] booted ${d.id}`);
			bootlog.push(`${d.id}: booted`);
		} catch (e) {
			console.error(`[my-obsidian] ${d.id} failed to load`, e);
			new Notice(`「${d.name}」载入失败，其余功能不受影响（详情见控制台）`);
		}
	}

	/** Turn a module on at runtime (the settings toggle). */
	async enableModule(id: string): Promise<void> {
		const d = this.descriptors.find((x) => x.id === id);
		const state = this.settings.modules[id];
		if (!d || !state) return;
		await this.bootModule(d);
	}

	/**
	 * Instantiate a sub-plugin and run its onload with its own data slice.
	 *
	 * Two small lies make four plugins behave as one:
	 *
	 *  - `loadData`/`saveData` are shadowed on the instance, so the module sees
	 *    only its own slice of the one data.json (shadowing the instance, not
	 *    the prototype, keeps the swap scoped to this module).
	 *  - the manifest is a SHALLOW COPY with `name` replaced. `id` and `dir`
	 *    must stay the host's: logseq builds its extension-store path from
	 *    `manifest.id` and writes sidecar files under `manifest.dir`, so
	 *    changing either would point outside the real plugin folder. The name
	 *    is what the settings sidebar labels the tab with — sharing the host's
	 *    name would show five tabs all called "My Obsidian".
	 */
	private async startModule(d: ModuleDescriptor, state: ModuleState): Promise<void> {
		const manifest = { ...this.manifest, name: d.name } as PluginManifest;
		const inst = new d.cls(this.app as App, manifest);
		const host = this;
		inst.loadData = async (): Promise<unknown> => state.data ?? {};
		inst.saveData = async (data: unknown): Promise<void> => {
			state.data = data;
			await host.saveSettings();
		};
		await inst.onload();
		this.live.set(d.id, inst);
		this.aliasLegacyId(d, inst);
	}

	/**
	 * Re-publish the instance under the id it had as a standalone plugin.
	 *
	 * Adds a key to the app's plugin table and nothing else: the enable/disable
	 * list comes from community-plugins.json, not from this table, so no ghost
	 * plugin appears in the settings. It only makes `app.plugins.plugins[oldId]`
	 * resolve again for the modules (and third-party plugins) that look it up.
	 */
	private aliasLegacyId(d: ModuleDescriptor, inst: SubPluginLike): void {
		if (!d.legacyId) return;
		const table = (
			this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }
		).plugins?.plugins;
		if (!table) return;
		table[d.legacyId] = inst;
		this.aliases.push(d.legacyId);
	}
}
