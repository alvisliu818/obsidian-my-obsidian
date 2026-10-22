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
import { ExternalCodeView, VIEW_TYPE_EXTERNAL_CODE } from "../modules/logseq/src/views/ExternalCodeView";
import BrowserPlugin from "../modules/browser/src/main";
import JupyterNotebookPlugin from "../modules/jupyter/src/main";
import BreadcrumbNavPlugin from "../modules/breadcrumb/src/main";
import DocAssistPlugin from "../modules/doc-assist/src/main";
import MaterialIconThemePlugin from "../modules/material-icon-theme/src/main";
import TraceTimePlugin from "../modules/tracetime/src/main";
import AIImageAnalyzerPlugin from "../modules/ai-image-analyzer/src/main";
import OmnisearchPlugin from "../modules/omnisearch/src/main";
import ObsidianGitPlugin from "../modules/obsidian-git/src/main";
import SaveControlPlugin from "../modules/save-control/src/main";
import OpenTabSettingsPlugin from "../modules/open-tab-settings/src/main";
import AudioRecorderPlugin from "../modules/audio-recorder/src/main";
import MediaJournalPlugin from "../modules/media-journal/src/main";
import MusicPlayerPlugin from "../modules/music-player/src/main";
import AudioPlayerPlugin from "../modules/audio-player/src/main";
import ScrollingPlugin from "../modules/scrolling/src/core/main";
import AbstractFolderPlugin from "../modules/abstract-folder/main";
import MomentumPlugin from "../modules/momentum/src/main";
import HearthPlugin from "../modules/hearth/src/main";
// media-extended v3 自带 obsidian@1.5.7 类型与自己的 "@/..." 别名（与
// music-player 的 @/ 同名冲突），经 require 桥接进 bundle：不进宿主 tsc
// 程序（类型由模块自带 tsconfig 独立校验），运行时打包不受影响。
const MediaExtendedPlugin = (
	require("../modules/media-extended/apps/app/src/mx-main") as {
		default: new (app: unknown, manifest: unknown) => SubPluginLike;
	}
).default;
// custom-attachment-location v16 体量大（147 文件 / 约 2.8 万行），在宿主
// strict 配置下有 1673 处类型错误（多为隐式 any、上游自带 .ts 扩展名导入与类型
// 差异），按收编判据走 require 桥：不进宿主 tsc 程序，类型由模块自带 tsconfig
// 独立校验，运行时照常打进 bundle。
const CustomAttachmentLocationPlugin = (
	require("../modules/custom-attachment-location/src/main") as {
		default: new (app: unknown, manifest: unknown) => SubPluginLike;
	}
).default;
// advanced-rename-and-delete-handler v2.3：custom-attachment-location v12+
// 声明的伴生依赖（附件跟随重命名/删除的真正执行者）。同款 require 桥；
// descriptor 里的 manifest 覆盖（id/version 特制成上游值）是 CAL 门禁能
// 打开的关键，见 modules/advanced-rename-and-delete-handler/NOTICE。
const AdvancedRenameAndDeleteHandlerPlugin = (
	require("../modules/advanced-rename-and-delete-handler/src/main") as {
		default: new (app: unknown, manifest: unknown) => SubPluginLike;
	}
).default;
import { DEFAULT_CODE_EXTENSIONS } from "./codeFileView";
import { registerFreeExtensions } from "./extensionRegistry";

/**
 * Reached through a require bridge rather than imported, because the bridge's
 * own module explains why: `@mnaoumov/obsidian-lib`'s typings contain a
 * `declare global` that widens Obsidian's `App`, and importing them here breaks
 * unrelated modules. The bridge must ALSO use import internally — the package
 * is dual-published and `require` would resolve to the CJS build, a SECOND
 * module instance with its own singleton, so patching it would do nothing.
 */
const { allowReentrantLibraryInit } = require("./libraryInitPatch") as {
	allowReentrantLibraryInit: () => void;
};

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
			name: "my Logseq Editor",
			summary: "Logseq 式块大纲编辑器：折叠、缩放、块引用、任务、SQLite 索引，以及库外文件的虚拟文档树。",
			desktopOnly: true,
			cls: LogseqEditorPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "browser",
			legacyId: "obsidian-browser",
			name: "my Browser",
			summary: "库内的多标签浏览器：地址栏、书签、历史、下载、网页剪藏与 Chrome 扩展支持。",
			desktopOnly: true,
			cls: BrowserPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "jupyter",
			legacyId: "obsidian-jupyter-notebook",
			name: "my Jupyter Notebook",
			summary: "在库里查看、编辑并运行 .ipynb，自带常驻 Python 内核。",
			desktopOnly: true,
			cls: JupyterNotebookPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "breadcrumb",
			legacyId: "breadcrumb-nav",
			name: "my Breadcrumb Nav",
			summary: "笔记顶部的面包屑（文件 › 标题 / 块层级），支持悬浮查看同级与逐级下钻。",
			desktopOnly: false,
			cls: BreadcrumbNavPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "doc-assist",
			legacyId: "obsidian-doc-assist",
			name: "my Doc Assist",
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
			name: "my Material Icon Theme",
			summary:
				"文件浏览器换上 Material Design 图标：按文件名 / 扩展名 / 文件夹名匹配，含 Obsidian 专有的 canvas、base。上游 GilbertzzzZZ（MIT）。",
			desktopOnly: false,
			cls: MaterialIconThemePlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "tracetime",
			// Third-party too (QuincySx, MIT), kept as the user's own fork of it.
			legacyId: "tracetime",
			name: "my TraceTime",
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
			name: "my AI image analyzer",
			summary:
				"用 AI 给图片生成关键词：Gemini / Ollama 等接口，支持批量分析、按关键词反查图片，结果缓存本地。上游 Swaggeroo（GPL-3.0）。",
			desktopOnly: true,
			cls: AIImageAnalyzerPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "obsidian-git",
			// Third-party (Vinzent03, MIT). Upstream natively supports split
			// git layouts: settings.gitDir is injected as GIT_DIR/GIT_WORK_TREE
			// env into simple-git (desktop) and as gitdir: into isomorphic-git
			// (mobile). The user's vault then keeps zero .git traces.
			legacyId: "obsidian-git",
			name: "my Git",
			summary:
				"库内 git 集成：自动备份/定时 pull、源管理视图、行作者标注、差异比对。支持分离布局（设置里填 gitDir 即可让仓库数据放 vault 之外）。上游 Vinzent03（MIT）。",
			desktopOnly: false,
			cls: ObsidianGitPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// GPL-3 as well — upstream Simon Cambier. Its Svelte components build
			// through the same esbuild (see the svelte plugin in esbuild.mjs).
			id: "omnisearch",
			legacyId: "omnisearch",
			name: "my Omnisearch",
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
			name: "my Save Control",
			summary:
				"自动保存节奏控制 + 文件版本历史（save-history 与 autosave-control 合并）：延迟落盘、状态栏待保存指示、标签页未保存圆点与关闭提示；虚拟文档树挂载的库外文件同样支持。上游 Sevoni（MIT）+ mihasm（MIT）。",
			desktopOnly: true,
			cls: SaveControlPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (jesse-r-s-hines, MIT), kept whole.
			id: "open-tab-settings",
			legacyId: "open-tab-settings",
			name: "my Open Tab Settings",
			summary:
				"标签页打开方式定制：默认新标签页/新窗口打开、防止重复标签页、新标签页分组摆放，可按来源（文件列表/搜索/反链等）分别设置。上游 jesse-r-s-hines（MIT）。",
			desktopOnly: false,
			cls: OpenTabSettingsPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (Anatol Khmialeuski, MIT), kept whole — see
			// modules/audio-recorder/NOTICE.
			id: "audio-recorder",
			legacyId: "advanced-audio-recorder",
			name: "my Audio Recorder",
			summary:
				"库内录音与语音转写：多轨（麦克风+系统声）录音、带书签/章节/波形的高级播放器、格式转换、降噪清理与说话人分离转写（Whisper / Deepgram / Gemini / 本地 whisper.cpp）。上游 Anatol Khmialeuski（MIT）。",
			desktopOnly: false,
			cls: AudioRecorderPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (Alaxanalax10, 0-BSD), kept whole — see
			// modules/media-journal/NOTICE. Desktop-only like its own
			// manifest: screen capture needs getDisplayMedia.
			id: "media-journal",
			legacyId: "media-recorder",
			name: "my Media Recorder",
			summary:
				"侧栏里的录像/录屏/录音机：三档画质、画中画预览、计时与暂停续录，录完的 .webm 存进库并可自动嵌入当前笔记（或指定笔记）；嵌入后的视频能拖拽改宽度并写回原文。上游 Alaxanalax10（0-BSD）。",
			desktopOnly: true,
			cls: MediaJournalPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (TracingOrigins / Kevin, MIT), kept whole — see
			// modules/music-player/NOTICE. React UI builds through the same
			// esbuild (tsx loader + node-shim overrides for its mobile polyfills).
			id: "music-player",
			// Same id before and after the merge: keeps the real upstream id
			// alive in the plugin table (same precedent as material-icon-theme).
			legacyId: "music-player",
			name: "my Music Player",
			summary:
				"侧栏音乐播放器：扫描库内音频按艺术家/专辑整理，歌词滚动与卡拉OK逐字、播放队列与收藏、封面自动匹配，库外文件不支持。上游 TracingOrigins（MIT）。",
			desktopOnly: false,
			cls: MusicPlayerPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (AidenLx / PKM-er, MIT), absorbed at the v3 line —
			// see modules/media-extended/NOTICE. 4.x is closed-source; v3
			// (3.2.6) is the last open build. Desktop-only per its manifest.
			id: "media-extended",
			legacyId: "media-extended",
			name: "my Media Extended",
			summary:
				"库内媒体播放增强：本地/YouTube/B站视频与音频的嵌入式播放器、时间戳链接与截图、媒体笔记工作流。上游 AidenLx（MIT；v3 3.2.6 为最后的开源版本）。",
			desktopOnly: true,
			cls: MediaExtendedPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Three third-party plugins merged into one module — see
			// modules/audio-player/NOTICE. media-marker (MIT, Blontern) is the
			// base; audio-timestamp-player (0BSD, ITNQ18) contributed explicit
			// multi-recording bindings, the cross-view floating player and
			// source-mode link clicks; timestamp-player (MIT, Len Zhou) needed
			// no code — its speaker/section features are covered by the base.
			id: "audio-player",
			// All three upstream ids stay resolvable in the plugin table
			// (first use of legacyIds — their data.json files are NOT migrated).
			legacyIds: ["media-marker", "audio-timestamp-player", "timestamp-player"],
			name: "my Audio Player",
			summary:
				"转录文稿时间戳点击即播：自定义播放器（进度/音量/倍速/字幕/画中画/全屏）、贴边媒体、字幕歌词、快捷键、循环区间、时间戳插入；同笔记多录音可用 %%audio-id%% 显式绑定，播放跨视图切换存活（悬浮播放器）。上游 blontern（MIT）+ ITNQ18（0BSD）+ zhoulianglen（MIT）。",
			desktopOnly: false,
			cls: AudioPlayerPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (mnaoumov, MIT), kept whole — see
			// modules/advanced-rename-and-delete-handler/NOTICE. Wired through
			// a require bridge like custom-attachment-location (upstream imports
			// with .ts extensions; obsidian-lib range ^4.2.1 vs root 5.1.0).
			//
			// It is custom-attachment-location v12+'s declared companion: CAL's
			// dependency gate consumes its API through watchPluginApi keyed by
			// the UPSTREAM plugin id, and version-gates it through the plugin
			// table. Hence the manifest override — publishPluginApi registers
			// under plugin.manifest.id, so `id` must be the upstream id, and
			// `version` must satisfy CAL's minPluginVersion 2.2.0 (host is 0.1.0).
			// Listed BEFORE custom-attachment-location: provider first.
			id: "advanced-rename-and-delete-handler",
			legacyId: "advanced-rename-and-delete-handler",
			name: "my Advanced Rename and Delete Handler",
			summary:
				"全库统一接管重命名/删除：更新链接、移动附件文件与文件夹、清理删除残留（空文件夹处理、挽救路径解析）。默认所有开关关闭，装上不改变现有行为；开启后 custom-attachment-location 的「附件跟随重命名」也由它完成。上游 mnaoumov（MIT）。",
			desktopOnly: false,
			manifest: { id: "advanced-rename-and-delete-handler", version: "2.3.0" },
			cls: AdvancedRenameAndDeleteHandlerPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (RainCat1998 / mnaoumov, MIT), kept whole — see
			// modules/custom-attachment-location/NOTICE. Large surface (147
			// files / ~28k lines, 1673 errors under the host's strict config):
			// wired through a require bridge, so it is type-checked by its own
			// tsconfig instead of joining the host tsc program.
			//
			// manifest.version is overridden to the upstream 16.0.0: ARDH
			// declares a BLOCKING conflict against obsidian-custom-attachment-
			// location <12.0.0 (old versions owned a rename handler of their
			// own) and reads the version off the alias-table instance — with
			// the host's 0.1.0 it would read the co-bundled CAL as an OLD CAL,
			// block itself, and dead-lock the CAL gate that depends on it.
			//
			// manifest.id MUST also be the upstream id. Obsidian's
			// PluginSettingTab takes its id from `plugin.manifest.id`, so
			// leaving it as the host's gave CAL a settings tab literally called
			// "obsidian-my-obsidian" — the same id as the host's own tab, which
			// Obsidian indexes by id. One of the two vanished from the settings
			// sidebar, and `openTabById` (the button the core Files-and-links
			// patch uses) could only ever reach the host's. Same reason ARDH
			// overrides its id above. `dir` deliberately stays the host's: CAL
			// writes its sidecar files next to the real plugin folder.
			id: "custom-attachment-location",
			legacyId: "obsidian-custom-attachment-location",
			name: "my Custom Attachment Location",
			summary:
				"自定义附件存放位置：用 {{noteFileName}}、{{date:format}} 等变量拼出目标路径，支持笔记子文件夹/同名文件夹归档、粘贴即自动归位、批量收集与清理未使用附件、重命名删除时同步更新链接。上游 RainCat1998 + mnaoumov（MIT）。",
			desktopOnly: false,
			manifest: { id: "obsidian-custom-attachment-location", version: "16.0.0" },
			cls: CustomAttachmentLocationPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (omeyenburg / Oskar Meyenburg, MIT), kept whole — see
			// modules/scrolling/NOTICE. Upstream history (369 commits) was grafted
			// into this repo, so `git log --follow modules/scrolling` still works.
			id: "scrolling",
			legacyId: "scrolling",
			name: "my Scrolling",
			summary:
				"滚动与导航增强：光标居中（typewriter 模式）、记住并恢复滚动/光标位置、代码块不换行横向滚动、行内 MathJax 与文件树横向滚动、置顶/置底按钮与快捷命令、阅读模式 Vim 式快捷键、滚动条显隐策略、正文最大行宽。上游 omeyenburg（MIT）。",
			desktopOnly: false,
			cls: ScrollingPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (Erfan Rahmani, GPL-3.0), kept whole — see
			// modules/abstract-folder/NOTICE. Upstream history (161 commits) was
			// grafted into this repo, so `git log --follow
			// modules/abstract-folder` still works.
			id: "abstract-folder",
			legacyId: "abstract-folder",
			name: "my Abstract Folder",
			summary:
				"动态虚拟文件夹：按父级关系把散落各处的笔记聚成虚拟文件夹，树形/列式两种版式、拖拽整理、文件夹结构生成与转换（冲突消解、分组管理）、图标与配色自定义。上游 Erfan Rahmani（GPL-3.0）。",
			desktopOnly: true,
			cls: AbstractFolderPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Two upstreams merged into one project (see modules/momentum/NOTICE):
			// Momentum Life (jnagase, MIT) is the base; WorkLife Calendar (atinss,
			// MIT, 145 commits grafted as a second parent) runs inside it as an
			// in-process sub-plugin — one manifest, one data.json, the calendar's
			// settings living under a "worklife" key of this module's slice.
			id: "momentum",
			legacyIds: ["momentum-life", "worklife-calendar"],
			name: "my Momentum",
			summary:
				"生活仪表盘：习惯/任务/健身/营养/学习看板、Google Tasks 与 Google Drive 同步、快速访问面板；并入 WorkLife Calendar 后另有日历/日程/看板/习惯分析/财务/天气视图与 dashboard、hello 代码块。上游 jnagase + atinss（均 MIT）。",
			desktopOnly: false,
			cls: MomentumPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// 库首页（ondreu/Hearth，MIT）——搜索/仪表盘/启动器三合一。
			id: "hearth",
			legacyIds: ["hearth"],
			name: "my Hearth",
			summary:
				"库首页：全局搜索与快速切换器、仪表盘卡片（日记/任务/看板/日历/RSS 阅读/天气/书签/最近文件/画册/启动器/集成 Dataview 等）、工作区布局与壁纸外观，移动端可用。上游 ondreu/Hearth（MIT）。",
			desktopOnly: false,
			cls: HearthPlugin as unknown as ModuleDescriptor["cls"],
		},
	];

	async onload(): Promise<void> {
		// Must precede every module load: the mnaoumov modules call these during
		// their own onload, and the second one to arrive used to throw.
		allowReentrantLibraryInit();
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
	 * it from the setting. Markdown files are never in the list: they have a
	 * perfectly good native editor.
	 *
	 * The default list is the mount-side TEXT_MOUNT_EXTENSIONS minus
	 * md/markdown/canvas, i.e. in-vault code files and mounted (out-of-vault)
	 * code files get exactly the same coverage — and the same editor.
	 *
	 * An empty setting falls back to the default list (the settings UI promises
	 * "leave empty to use the default", and loadSettings() never populates it
	 * from a previous version's raw value, so [] must not mean "nothing").
	 */
	private registerCodeFiles(): void {
		const configured = this.settings.codeFileExtensions;
		const exts = (
			configured && configured.length > 0 ? configured : DEFAULT_CODE_EXTENSIONS
		).filter((e) => !!e && !/^(md|markdown|canvas)$/i.test(e));
		// 库内代码文件与库外用**同一个编辑器**(用户要求):logseq 模块已在自己的
		// onload 里 registerView(VIEW_TYPE_EXTERNAL_CODE),宿主只把扩展名映射过去
		// —— Obsidian 打开 .py 时按该 type 建视图,setState 会带上 {file}(库内
		// 相对路径),ExternalCodeView.setState 已兼容并解析为真实路径。
		// 因此宿主不再注册自己的 CodeFileView(旧整台 CM 方案)。
		//
		// 必须走 registerFreeExtensions:Obsidian 的 registerExtensions 是整批
		// 原子的,只要有一个扩展名已被占用(核心的图片/pdf/md、office 模块先行
		// 注册的 csv、或库外别的插件)就整体抛异常 —— 那会打死 onload,样式全毁。
		// 详见 extensionRegistry.ts 的文件头。
		registerFreeExtensions(this, exts, VIEW_TYPE_EXTERNAL_CODE, "code files");

		this.addCommand({
			id: "run-code-file",
			name: "运行当前代码文件",
			checkCallback: (checking) => {
				// 代码文件统一在 ExternalCodeView(混合编辑)里打开;getActiveViewOfType
				// 对双参构造的类报类型错,直接遍历叶子找当前活动的一个。
				const active = this.app.workspace.activeLeaf?.view;
				const ext =
					active instanceof ExternalCodeView ? active : null;
				if (!ext?.abs) return false;
				if (!checking) void ext.runCurrentFile();
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
		const manifest = { ...this.manifest, ...d.manifest, name: d.name } as PluginManifest;
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
		const ids = d.legacyIds ?? (d.legacyId ? [d.legacyId] : []);
		if (ids.length === 0) return;
		const table = (
			this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }
		).plugins?.plugins;
		if (!table) return;
		for (const id of ids) {
			table[id] = inst;
			this.aliases.push(id);
		}
	}
}
