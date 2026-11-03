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
import { Notice, Platform, Plugin, TFile } from "obsidian";
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

import DocTreePlugin from "../modules/my-doc-tree/src/main";
import CodeEditorPlugin from "../modules/my-code-editor/src/main";
import LogseqEditorPlugin from "../modules/my-logseq/src/main";
import { ExternalCodeView, VIEW_TYPE_EXTERNAL_CODE } from "../modules/my-logseq/src/views/ExternalCodeView";
import BrowserPlugin from "../modules/my-browser/src/main";
import JupyterNotebookPlugin from "../modules/my-jupyter/src/main";
import BreadcrumbNavPlugin from "../modules/my-breadcrumb/src/main";
import DocAssistPlugin from "../modules/my-doc-assist/src/main";
import MaterialIconThemePlugin from "../modules/my-material-icon-theme/src/main";
import TraceTimePlugin from "../modules/my-tracetime/src/main";
import AIImageAnalyzerPlugin from "../modules/my-ai-image-analyzer/src/main";
// omnisearch 的两个可选依赖插件收编（2026-10-31，各自 NOTICE 有出处与适配
// 记录）。必须在 omnisearch descriptor **之前**登记：boot 顺序即数组顺序，
// omnisearch 的设置页/索引期会读它们的实例与 api。
import CMChsPatchPlugin from "../modules/my-cm-chs-patch/src/chsp-main";
import TextExtractorPlugin from "../modules/my-text-extractor/plugin/src/main";
import OmnisearchPlugin from "../modules/my-omnisearch/src/main";
import ObsidianGitPlugin from "../modules/my-obsidian-git/src/main";
import SaveControlPlugin from "../modules/my-save-control/src/main";
import OpenTabSettingsPlugin from "../modules/my-open-tab-settings/src/main";
import AudioRecorderPlugin from "../modules/my-audio-recorder/src/main";
import MediaJournalPlugin from "../modules/my-media-journal/src/main";
import MusicPlayerPlugin from "../modules/my-music-player/src/main";
import AudioPlayerPlugin from "../modules/my-audio-player/src/main";
import ScrollingPlugin from "../modules/my-scrolling/src/core/main";
import AbstractFolderPlugin from "../modules/my-abstract-folder/main";
import MomentumPlugin from "../modules/my-momentum/src/main";
import HearthPlugin from "../modules/my-hearth/src/main";
// latex-delimiter-renderer v1.0.4（Andreas Burger，MIT）：只有两个文件，且在
// 宿主严格配置（strict + noUnusedLocals）下零错误 → 按收编判据走**源码直连**，
// 不需要 require 桥。它是 `\(…\)` / `\[…\]` 公式渲染的正主，见模块内 NOTICE。
import LatexDelimiterRendererPlugin from "../modules/my-latex-delimiter-renderer/src/main";
// 自研统一索引搜索（modules/my-index-core 的消费层）：node:sqlite 磁盘索引，
// 与 omnisearch（minisearch/内存）平行，桌面端专用（node:sqlite 需要 Electron）。
import UnifiedSearchPlugin from "../modules/my-unified-search/src/main";
// code-link v1.0.4（observerw，MIT）：源码只做了相对导入改写（宿主 src/* 别名
// 已被 obsidian-git 占用）即通过宿主严格配置 → 源码直连，无需 require 桥；
// tree-sitter 核心 wasm 构建期内嵌（见模块 NOTICE 与根 esbuild.mjs）。
import CodeLinkPlugin from "../modules/my-code-link/src/main";
// Advanced URI v2.2.1（Vinzent03，MIT）：require 桥（见 modules/my-advanced-uri/NOTICE）。
// 上游 tsconfig 非 strict 且其构建不过 tsc，直连会在宿主严格配置下爆 175 处
// 类型噪音（obsidian 类型版本漂移 + strictNullChecks）——同 media-extended/
// CAL 的判据：类型由模块自带 tsconfig（obsidian@1.13.1，已修 6 处上游遗留
// 瑕疵后零错误）独立校验，运行时照常打进 bundle。
const AdvancedURIPlugin = (
	require("../modules/my-advanced-uri/src/main") as {
		default: new (app: unknown, manifest: unknown) => SubPluginLike;
	}
).default;
// media-extended v3 自带 obsidian@1.5.7 类型与自己的 "@/..." 别名（与
// music-player 的 @/ 同名冲突），经 require 桥接进 bundle：不进宿主 tsc
// 程序（类型由模块自带 tsconfig 独立校验），运行时打包不受影响。
const MediaExtendedPlugin = (
	require("../modules/my-media-extended/apps/app/src/mx-main") as {
		default: new (app: unknown, manifest: unknown) => SubPluginLike;
	}
).default;
// custom-attachment-location v16 体量大（147 文件 / 约 2.8 万行），在宿主
// strict 配置下有 1673 处类型错误（多为隐式 any、上游自带 .ts 扩展名导入与类型
// 差异），按收编判据走 require 桥：不进宿主 tsc 程序，类型由模块自带 tsconfig
// 独立校验，运行时照常打进 bundle。
const CustomAttachmentLocationPlugin = (
	require("../modules/my-custom-attachment-location/src/main") as {
		default: new (app: unknown, manifest: unknown) => SubPluginLike;
	}
).default;
// advanced-rename-and-delete-handler v2.3：custom-attachment-location v12+
// 声明的伴生依赖（附件跟随重命名/删除的真正执行者）。同款 require 桥；
// descriptor 里的 manifest 覆盖（id 用模块自己的 my- 前缀值、version 特制成上游值）是 CAL 门禁能
// 打开的关键，见 modules/my-advanced-rename-and-delete-handler/NOTICE。
const AdvancedRenameAndDeleteHandlerPlugin = (
	require("../modules/my-advanced-rename-and-delete-handler/src/main") as {
		default: new (app: unknown, manifest: unknown) => SubPluginLike;
	}
).default;
// vault-explorer v1.47.4（DecafDev，MIT）：同款 require 桥——它的源码用 `src/...`
// 非相对导入（上游 baseUrl 约定），而宿主 tsconfig 的 `src/*` 别名已被 obsidian-git
// 占用，不能让它进宿主 tsc 程序；类型由模块自带 tsconfig 独立校验，运行时照常
// 打进 bundle（.svelte 组件由根 esbuild 的 svelte 插件编译）。
const VaultExplorerPlugin = (
	require("../modules/my-vault-explorer/src/main") as {
		default: new (app: unknown, manifest: unknown) => SubPluginLike;
	}
).default;
// obsidian-terminal v3.28.0（polyipseity，AGPL-3.0）：require 桥接**源码**。
// 它依赖 vendor 子库 @polyipseity/obsidian-plugin-library（钉 b6eb90c5，随仓
// 收进 modules/my-terminal/vendor），esbuild 从 TS 源码直接打包——含库里的
// Svelte 5 组件/runes 模块与 .py 文本模块，适配见根 esbuild.mjs 的 terminal
// 插件与模块 NOTICE。不进宿主 tsc 程序：上游钉 @polyipseity/obsidian ~1.8.7
// 的 obsidian 类型，与宿主 1.14.4 漂移。
const TerminalPlugin = (
	require("../modules/my-terminal/src/main") as {
		default: new (app: unknown, manifest: unknown) => SubPluginLike;
	}
).default;
import { DEFAULT_CODE_EXTENSIONS } from "./codeFileView";
import { registerFreeExtensions } from "./extensionRegistry";
// 原生 markdown 编辑器（实时预览/源码模式）+ 阅读模式的代码块「▶ 运行」。
// 执行层与库内代码文件共用 exec/runner（真子进程 + 临时文件，stdin 可用）。
import { registerNativeCodeBlockRun } from "../modules/my-code-editor/src/exec/nativeCodeBlockRun";
import { langFromExt } from "../modules/my-code-editor/src/exec/runner";
// 原生 Markdown 编辑器的 @ 检索：文件名模糊匹配 + omnisearch 全文兜底，
// 回车插入 obsidian://open 链接（见 atLinkSuggest.ts 文件头）。
import { registerAtLinkSuggest } from "./atLinkSuggest";

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
	/** 模块自己的设置页（addSettingTab 被截获），由宿主设置页内嵌渲染。 */
	private readonly capturedTabs = new Map<string, unknown>();

	readonly descriptors: ModuleDescriptor[] = [
		{
			// 自研(2026-10-27 自 logseq 模块拆出,拆分前是该模块的挂载面):
			// 挂载面板/库外文件系统(extFs)/库外文件打开路由/图片·视频·Office
			// 查看器/系统「打开方式」。引导顺序必须在 logseq 之前——logseq 的
			// onload 通过 docTreeOf() 找到它登记库外编辑 opener(见 doc-tree
			// 的 openers.ts);它被单独关闭时库外文件回落系统打开,库内编辑不受影响。
			id: "doc-tree",
			name: "my Doc Tree",
			summary:
				"虚拟文档树：把库外文件夹挂进侧栏（挂载树/嵌套挂载/新建笔记/链接进库），库外图片、视频与 Office 文件的应用内查看器，以及库外文件的打开路由与系统「打开方式」菜单。",
			desktopOnly: true,
			cls: DocTreePlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// 自研(2026-10-27 自 logseq 模块拆出):Monaco 编辑器基建 + LSP 宿主 +
			// 代码执行器 + 扩展贡献桥(语法/主题/片段)。惰性初始化——首次
			// createEditor 才落 monaco 真资源,首次 openLspDocument 才 spawn
			// LSP 子进程(常驻内存大头,拆分动机);onunload 释放两者。视图
			// (ExternalCodeView/hybridCodeEditor/CodeDocView)留 logseq,经静态
			// import 使用本模块(上层→底层)。
			id: "code-editor",
			name: "my Code Editor",
			summary: "Monaco 代码编辑器基建：代码块/代码文件的语法高亮与编辑（含混合模式所需的编辑器内核）、LSP 诊断补全（pyright 等）、代码执行器，以及 VSCode 扩展的主题/片段/语法贡献注册。",
			desktopOnly: true,
			cls: CodeEditorPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "logseq",
			// The id other modules look this one up by (jupyter reads
			// `pythonEnvs` off it, breadcrumb reads its mount list).
			name: "my Logseq Editor",
			summary: "Logseq 式块大纲编辑器：折叠、缩放、块引用、任务、SQLite 索引，以及库外文件的虚拟文档树。",
			desktopOnly: true,
			cls: LogseqEditorPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "browser",
			name: "my Browser",
			summary: "库内的多标签浏览器：地址栏、书签、历史、下载、网页剪藏与 Chrome 扩展支持。",
			desktopOnly: true,
			cls: BrowserPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "jupyter",
			name: "my Jupyter Notebook",
			summary: "在库里查看、编辑并运行 .ipynb，自带常驻 Python 内核。",
			desktopOnly: true,
			cls: JupyterNotebookPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "breadcrumb",
			name: "my Breadcrumb Nav",
			summary: "笔记顶部的面包屑（文件 › 标题 / 块层级），支持悬浮查看同级与逐级下钻。",
			desktopOnly: false,
			cls: BreadcrumbNavPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "doc-assist",
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
			name: "my Material Icon Theme",
			summary:
				"文件浏览器换上 Material Design 图标：按文件名 / 扩展名 / 文件夹名匹配，含 Obsidian 专有的 canvas、base。上游 GilbertzzzZZ（MIT）。",
			desktopOnly: false,
			cls: MaterialIconThemePlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			id: "tracetime",
			// Third-party too (QuincySx, MIT), kept as the user's own fork of it.
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
			name: "my Git",
			summary:
				"库内 git 集成：自动备份/定时 pull、源管理视图、行作者标注、差异比对。支持分离布局（设置里填 gitDir 即可让仓库数据放 vault 之外）。上游 Vinzent03（MIT）。",
			desktopOnly: false,
			cls: ObsidianGitPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// omnisearch 的分词依赖（AidenLx，MIT），2026-10-31 收编——顺序在
			// omnisearch 之前。上游要手动导入 jieba wasm，这里构建期内嵌
			// （见模块 NOTICE）；编辑器中文分词与 omnisearch 分词共用一份实例。
			id: "chs-patch",
			name: "my Chs Patch",
			// PluginSettingTab 按 manifest.id 建键：不覆盖会与宿主设置页撞车
			// （同 CAL/ARDH 的先例）。
			manifest: { version: "1.14.0" },
			migrateFrom: "cm-chs-patch",
			summary:
				"编辑器中文分词：双击选词、w/e/b 词移动等按词边界工作；并作为 Omnisearch 的中文分词引擎（内置结巴分词组件，免手动导入）。上游 AidenLx（MIT）。",
			desktopOnly: false,
			cls: CMChsPatchPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// omnisearch 的文本提取依赖（scambier，GPL-3），2026-10-31 收编——
			// 顺序在 omnisearch 之前。PDF/图片 OCR/Office 提取，Omnisearch 的
			// PDFIndexing/imagesIndexing/officeIndexing 靠它才可用。
			id: "text-extractor",
			name: "my Text Extractor",
			manifest: { version: "0.7.0" },
			migrateFrom: "text-extractor",
			summary:
				"从图片（OCR）、PDF 与 Office 文档提取文本：供 Omnisearch 索引其内容，另有右键菜单提取、提取到剪贴板/新笔记与系统原生 OCR 开关。上游 scambier（GPL-3）+ 本地增强。",
			desktopOnly: false,
			cls: TextExtractorPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// GPL-3 as well — upstream Simon Cambier. Its Svelte components build
			// through the same esbuild (see the svelte plugin in esbuild.mjs).
			id: "omnisearch",
			name: "my Omnisearch",
			summary:
				"库内全文搜索引擎：拼音容错、按路径/标签/区块过滤、文件内搜索与 API。上游 Simon Cambier（GPL-3）。",
			desktopOnly: false,
			cls: OmnisearchPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// 两个上游 MIT 插件的合并（见 modules/my-save-control/NOTICE.md）。库外
			// 文件支持依赖 Node fs（快照/读写），只承诺桌面端。
			id: "save-control",
			name: "my Save Control",
			summary:
				"自动保存节奏控制 + 文件版本历史（save-history 与 autosave-control 合并）：延迟落盘、状态栏待保存指示、标签页未保存圆点与关闭提示；虚拟文档树挂载的库外文件同样支持。上游 Sevoni（MIT）+ mihasm（MIT）。",
			desktopOnly: true,
			cls: SaveControlPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (jesse-r-s-hines, MIT), kept whole.
			id: "open-tab-settings",
			name: "my Open Tab Settings",
			summary:
				"标签页打开方式定制：默认新标签页/新窗口打开、防止重复标签页、新标签页分组摆放，可按来源（文件列表/搜索/反链等）分别设置。上游 jesse-r-s-hines（MIT）。",
			desktopOnly: false,
			cls: OpenTabSettingsPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (Anatol Khmialeuski, MIT), kept whole — see
			// modules/my-audio-recorder/NOTICE.
			id: "audio-recorder",
			name: "my Audio Recorder",
			summary:
				"库内录音与语音转写：多轨（麦克风+系统声）录音、带书签/章节/波形的高级播放器、格式转换、降噪清理与说话人分离转写（Whisper / Deepgram / Gemini / 本地 whisper.cpp）。上游 Anatol Khmialeuski（MIT）。",
			desktopOnly: false,
			cls: AudioRecorderPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (Alaxanalax10, 0-BSD), kept whole — see
			// modules/my-media-journal/NOTICE. Desktop-only like its own
			// manifest: screen capture needs getDisplayMedia.
			id: "media-journal",
			name: "my Media Recorder",
			summary:
				"侧栏里的录像/录屏/录音机：三档画质、画中画预览、计时与暂停续录，录完的 .webm 存进库并可自动嵌入当前笔记（或指定笔记）；嵌入后的视频能拖拽改宽度并写回原文。上游 Alaxanalax10（0-BSD）。",
			desktopOnly: true,
			cls: MediaJournalPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (TracingOrigins / Kevin, MIT), kept whole — see
			// modules/my-music-player/NOTICE. React UI builds through the same
			// esbuild (tsx loader + node-shim overrides for its mobile polyfills).
			id: "music-player",
			// Same id before and after the merge: keeps the real upstream id
			// alive in the plugin table (same precedent as material-icon-theme).
			name: "my Music Player",
			summary:
				"侧栏音乐播放器：扫描库内音频按艺术家/专辑整理，歌词滚动与卡拉OK逐字、播放队列与收藏、封面自动匹配，库外文件不支持。上游 TracingOrigins（MIT）。",
			desktopOnly: false,
			cls: MusicPlayerPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (AidenLx / PKM-er, MIT), absorbed at the v3 line —
			// see modules/my-media-extended/NOTICE. 4.x is closed-source; v3
			// (3.2.6) is the last open build. Desktop-only per its manifest.
			id: "media-extended",
			name: "my Media Extended",
			summary:
				"库内媒体播放增强：本地/YouTube/B站视频与音频的嵌入式播放器、时间戳链接与截图、媒体笔记工作流。上游 AidenLx（MIT；v3 3.2.6 为最后的开源版本）。",
			desktopOnly: true,
			cls: MediaExtendedPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Three third-party plugins merged into one module — see
			// modules/my-audio-player/NOTICE. media-marker (MIT, Blontern) is the
			// base; audio-timestamp-player (0BSD, ITNQ18) contributed explicit
			// multi-recording bindings, the cross-view floating player and
			// source-mode link clicks; timestamp-player (MIT, Len Zhou) needed
			// no code — its speaker/section features are covered by the base.
			id: "audio-player",
			// All three upstream ids stay resolvable in the plugin table
			// (first use of legacyIds — their data.json files are NOT migrated).
			name: "my Audio Player",
			summary:
				"转录文稿时间戳点击即播：自定义播放器（进度/音量/倍速/字幕/画中画/全屏）、贴边媒体、字幕歌词、快捷键、循环区间、时间戳插入；同笔记多录音可用 %%audio-id%% 显式绑定，播放跨视图切换存活（悬浮播放器）。上游 blontern（MIT）+ ITNQ18（0BSD）+ zhoulianglen（MIT）。",
			desktopOnly: false,
			cls: AudioPlayerPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (mnaoumov, MIT), kept whole — see
			// modules/my-advanced-rename-and-delete-handler/NOTICE. Wired through
			// a require bridge like custom-attachment-location (upstream imports
			// with .ts extensions; obsidian-lib range ^4.2.1 vs root 5.1.0).
			//
			// It is custom-attachment-location v12+'s declared companion: CAL's
			// dependency gate consumes its API through watchPluginApi keyed by this
			// module's own my- 前缀 id, and version-gates it through the plugin
			// table. Hence the manifest override — publishPluginApi registers
			// under plugin.manifest.id, so `id` must equal the id CAL watches
			// for (the same my- string on both sides), and
			// `version` must satisfy CAL's minPluginVersion 2.2.0 (host is 0.1.0).
			// Listed BEFORE custom-attachment-location: provider first.
			id: "advanced-rename-and-delete-handler",
			name: "my Advanced Rename and Delete Handler",
			summary:
				"全库统一接管重命名/删除：更新链接、移动附件文件与文件夹、清理删除残留（空文件夹处理、挽救路径解析）。默认所有开关关闭，装上不改变现有行为；开启后 custom-attachment-location 的「附件跟随重命名」也由它完成。上游 mnaoumov（MIT）。",
			desktopOnly: false,
			manifest: { version: "2.3.0" },
			cls: AdvancedRenameAndDeleteHandlerPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (RainCat1998 / mnaoumov, MIT), kept whole — see
			// modules/my-custom-attachment-location/NOTICE. Large surface (147
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
			// manifest.id MUST also be overridden — 2026-10-30 起用模块自己的 my- 前缀
			// id，不再借用上游 id，避免与真上游插件在插件表/命令空间里重名。Obsidian's
			// PluginSettingTab takes its id from `plugin.manifest.id`, so
			// leaving it as the host's gave CAL a settings tab literally called
			// "obsidian-my-obsidian" — the same id as the host's own tab, which
			// Obsidian indexes by id. One of the two vanished from the settings
			// sidebar, and `openTabById` (the button the core Files-and-links
			// patch uses) could only ever reach the host's. Same reason ARDH
			// overrides its id above. `dir` deliberately stays the host's: CAL
			// writes its sidecar files next to the real plugin folder.
			id: "custom-attachment-location",
			name: "my Custom Attachment Location",
			summary:
				"自定义附件存放位置：用 {{noteFileName}}、{{date:format}} 等变量拼出目标路径，支持笔记子文件夹/同名文件夹归档、粘贴即自动归位、批量收集与清理未使用附件、重命名删除时同步更新链接。上游 RainCat1998 + mnaoumov（MIT）。",
			desktopOnly: false,
			manifest: { version: "16.0.0" },
			cls: CustomAttachmentLocationPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (omeyenburg / Oskar Meyenburg, MIT), kept whole — see
			// modules/my-scrolling/NOTICE. Upstream history (369 commits) was grafted
			// into this repo, so `git log --follow modules/my-scrolling` still works.
			id: "scrolling",
			name: "my Scrolling",
			summary:
				"滚动与导航增强：光标居中（typewriter 模式）、记住并恢复滚动/光标位置、代码块不换行横向滚动、行内 MathJax 与文件树横向滚动、置顶/置底按钮与快捷命令、阅读模式 Vim 式快捷键、滚动条显隐策略、正文最大行宽。上游 omeyenburg（MIT）。",
			desktopOnly: false,
			cls: ScrollingPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (Erfan Rahmani, GPL-3.0), kept whole — see
			// modules/my-abstract-folder/NOTICE. Upstream history (161 commits) was
			// grafted into this repo, so `git log --follow
			// modules/my-abstract-folder` still works.
			id: "abstract-folder",
			name: "my Abstract Folder",
			summary:
				"动态虚拟文件夹：按父级关系把散落各处的笔记聚成虚拟文件夹，树形/列式两种版式、拖拽整理、文件夹结构生成与转换（冲突消解、分组管理）、图标与配色自定义。上游 Erfan Rahmani（GPL-3.0）。",
			desktopOnly: true,
			cls: AbstractFolderPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Two upstreams merged into one project (see modules/my-momentum/NOTICE):
			// Momentum Life (jnagase, MIT) is the base; WorkLife Calendar (atinss,
			// MIT, 145 commits grafted as a second parent) runs inside it as an
			// in-process sub-plugin — one manifest, one data.json, the calendar's
			// settings living under a "worklife" key of this module's slice.
			id: "momentum",
			name: "my Momentum",
			summary:
				"生活仪表盘：习惯/任务/健身/营养/学习看板、Google Tasks 与 Google Drive 同步、快速访问面板；并入 WorkLife Calendar 后另有日历/日程/看板/习惯分析/财务/天气视图与 dashboard、hello 代码块。上游 jnagase + atinss（均 MIT）。",
			desktopOnly: false,
			cls: MomentumPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// 库首页（ondreu/Hearth，MIT）——搜索/仪表盘/启动器三合一。
			id: "hearth",
			name: "my Hearth",
			summary:
				"库首页：全局搜索与快速切换器、仪表盘卡片（日记/任务/看板/日历/RSS 阅读/天气/书签/最近文件/画册/启动器/集成 Dataview 等）、工作区布局与壁纸外观，移动端可用。上游 ondreu/Hearth（MIT）。",
			desktopOnly: false,
			cls: HearthPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (DecafDev, MIT), kept whole — see
			// modules/my-vault-explorer/NOTICE. Wired through a require bridge like
			// media-extended: its `src/...` imports rely on the upstream baseUrl
			// convention and the host tsconfig's `src/*` alias already points at
			// obsidian-git.
			id: "vault-explorer",
			name: "my Vault Explorer",
			// manifest.version MUST be the upstream value: the module saves
			// manifest.version into its own data as pluginVersion, and on every
			// later boot preformMigrations() runs the whole 0.3.3 -> 1.46 chain
			// whenever isVersionLessThan(loadedVersion, to) is true — with the
			// host's 0.1.0 that mangles DEFAULT_SETTINGS into a shape whose
			// search filter has { isEnabled: true, value: undefined }, and the
			// view dies on its first effect (e.toLowerCase crash, empty view).
			// Same reason ARDH/CAL override their id/version.
			manifest: { version: "1.47.4" },
			summary:
				"可视化库浏览器：以 frontmatter 属性与文件元数据过滤、排序，网格/列表/表格/动态（feed）四种版式展示，自定义过滤器可保存复用，卡片支持封面图与正文预览。上游 DecafDev（MIT）。",
			desktopOnly: true,
			cls: VaultExplorerPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (Andreas Burger, MIT), kept whole — see
			// modules/my-latex-delimiter-renderer/LICENSE. Straight `import`, no
			// require bridge: it compiles clean under the host tsconfig.
			id: "latex-delimiter-renderer",
			name: "my LaTeX Delimiters",
			// `id` MUST be part of the override — a copy without it keeps the
			// HOST's id, and anything keyed on manifest.id (setting tabs,
			// cross-plugin lookups) would then collide with the host.
			manifest: { version: "1.0.4" },
			summary:
				"渲染标准 LaTeX 公式分隔符：行内 \\(…\\) 与独立 \\[...\\]，不改动笔记源文件。原生编辑器的实时预览与阅读模式、logseq 块编辑器（含库外文件）均可；公式里的下标不会把强调漏进正文。上游 Andreas Burger（MIT）。",
			desktopOnly: false,
			cls: LatexDelimiterRendererPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// 自研（无上游）：索引本体在 modules/my-index-core，本模块只是它的
			// Obsidian 消费层。设计见 docs/unified-index-design.md。
			id: "unified-search",
			name: "my Unified Search",
			summary:
				"统一索引搜索：node:sqlite（FTS5）磁盘索引，JS 堆零驻留；短语/排除/title:/tag:/path:/ext: 过滤与前缀语法，中文可选接入 cm-chs-patch 分词（缺席自动降级+LIKE 兜底）。库内 md/org，桌面端专用；与 Omnisearch 互不影响，可二选一启用。",
			desktopOnly: true,
			cls: UnifiedSearchPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (observerw, MIT), kept whole — see modules/my-code-link/NOTICE.
			// 独立版运行时从 CDN 拉 tree-sitter.wasm，聚合版构建期内嵌（同
			// wa-sqlite/jieba 先例）；语言级 wasm 仍按上游设计运行时下载。
			// manifest.id 覆盖同 latex-delimiter-renderer：设置页/命令命名空间隔离。
			id: "code-link",
			name: "my Code Link",
			summary:
				"笔记里链接代码文件：像链接笔记一样引用代码文件并悬停/嵌入预览，可按符号（类/函数/方法）创建链接，标签搜索由 tree-sitter 提供。上游 observerw（MIT）。",
			desktopOnly: false,
			manifest: { version: "1.0.4" },
			migrateFrom: "code-link",
			cls: CodeLinkPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// Third-party (Vinzent03, MIT), kept whole — see
			// modules/my-advanced-uri/NOTICE. Source-direct: only friction was the
			// stripMD/uuid dependencies (inlined) and one `src/main` alias import
			// (rewritten relative). Protocol handlers (obsidian://advanced-uri,
			// adv-uri) register globally by handler name, so URI semantics are
			// identical to the standalone plugin.
			id: "advanced-uri",
			name: "my Advanced URI",
			manifest: { version: "2.2.1" },
			migrateFrom: "obsidian-advanced-uri",
			summary:
				"Obsidian URI 增强：obsidian://advanced-uri / adv-uri 打开或新建文件并定位标题/块/行列、写入追加前置内容、执行命令、搜索替换、打开设置页、存取工作区、canvas 节点与视口、插件启停、UID/日记/剪贴板参数，配套各类 Copy URI 命令与 x-success/x-error 回调。上游 Vinzent03（MIT）。",
			desktopOnly: false,
			cls: AdvancedURIPlugin as unknown as ModuleDescriptor["cls"],
		},
		{
			// obsidian-terminal v3.28.0（polyipseity，AGPL-3.0）：控制台/shell/终端
			// 集成。xterm.js v6 多渲染器（webgl/canvas/dom），Windows 集成配置走
			// ConPTY（需要 Python 3.9+，运行时自检并安装依赖，见其 win32-doctor）。
			// manifest.id/version 覆盖同 ARDH/CAL 先例：设置页命名空间隔离，
			// 版本保持上游值（其内部语义读 manifest.version）。
			id: "terminal",
			name: "my Terminal",
			manifest: { version: "3.28.0" },
			migrateFrom: "terminal",
			summary:
				"库内终端：在编辑器/悬浮窗里开 PowerShell、CMD 或自定义 shell 会话（xterm.js），支持默认/选择/集成/外部四种配置，右键文件夹与终端互跳，Windows 走 ConPTY/Windows-PTY。上游 polyipseity（AGPL-3.0）。",
			desktopOnly: false,
			cls: TerminalPlugin as unknown as ModuleDescriptor["cls"],
		},
	];

	async onload(): Promise<void> {
		// Must precede every module load: the mnaoumov modules call these during
		// their own onload, and the second one to arrive used to throw.
		allowReentrantLibraryInit();
		await this.loadSettings();
		const hostTab = new MyObsidianSettingTab(this.app, this, {
			settings: this.settings,
			descriptors: this.descriptors,
			save: () => this.saveSettings(),
			reload: (id) => this.enableModule(id),
			capturedTabs: this.capturedTabs,
		});
		this.addSettingTab(hostTab);
		// 内层子插件实例（momentum 的 WorkLife、audio-player 的内嵌上游等）会
		// 用自己创建的 Plugin 实例调 addSettingTab——它们不在 startModule 的
		// 捕获范围内，且其 manifest.id 已统一成宿主 id，直接注册会与宿主标签
		// 撞 id（Obsidian 按 id 索引，其中一个会从侧栏消失）。垫片把这类
		// 「宿主 id 但非宿主标签」的注册截进 capturedTabs（inner: 前缀键），
		// 由设置页末尾的「其他」区渲染。
		const settingApi = (
			this.app as unknown as {
				setting?: { addTab?: (tab: unknown) => void };
			}
		).setting;
		if (settingApi?.addTab) {
			const origAddTab = settingApi.addTab.bind(settingApi);
			const hostId = this.manifest.id;
			settingApi.addTab = (tab: unknown) => {
				const t = tab as { id?: string };
				if (t?.id === hostId && tab !== hostTab) {
					this.capturedTabs.set(
						`inner:${this.capturedTabs.size}:${t.id ?? "unknown"}`,
						tab,
					);
					return;
				}
				origAddTab(tab);
			};
		}
		for (const d of this.descriptors) await this.bootModule(d);
		// 兜底清扫：内层实例若经 addTab 之外的路径把「宿主 id」标签塞进
		// pluginTabs（构造期注册等），这里统一摘除收编——否则与宿主标签撞 id，
		// openTabById 可能命中空壳导致设置页显示为空。hostTab 自己也是宿主
		// id（且在垫片装上之前注册，必然已在 pluginTabs 里），必须排除，
		// 否则清扫会把宿主标签一并摘走，宿主设置页从侧栏消失（实测踩坑：
		// 症状是 openTabById 无命中、宿主页 totalSections: 0）。
		{
			const tabs = (
				this.app as unknown as {
					setting?: { pluginTabs?: Array<Record<string, unknown>> };
				}
			).setting?.pluginTabs;
			if (Array.isArray(tabs)) {
				for (let i = tabs.length - 1; i >= 0; i--) {
					const t = tabs[i] as { id?: string };
					if (t?.id === this.manifest.id && t !== hostTab) {
						this.capturedTabs.set(
							`inner:${this.capturedTabs.size}:${t.id ?? "unknown"}`,
							t,
						);
						tabs.splice(i, 1);
					}
				}
			}
		}
		this.registerCodeFiles();
		// 库内代码块运行（原生编辑器 + 阅读模式）：执行层要 spawn 子进程，桌面端专属
		if (Platform.isDesktopApp) registerNativeCodeBlockRun(this);
		registerAtLinkSuggest(this);
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

		// 文件浏览器右键「运行代码文件」:banner 可被用户关掉,活动视图命令也
		// 要求文件已打开 —— 右键入口保证可运行扩展名(py/js/sh/ps1…)任何时候
		// 都有运行通道。行为 = 打开到 ExternalCodeView(库内/库外同一编辑器)
		// 并自动触发 ▶ 运行,输出落在视图底部的运行输出区。
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile)) return;
				if (!langFromExt(file.name)) return;
				menu.addItem((item) => {
					item
						.setTitle("运行代码文件")
						.setIcon("play")
						.onClick(async () => {
							const leaf = this.app.workspace.getLeaf("tab");
							await leaf.openFile(file);
							// 等视图挂载完成(挂载会 empty 重建内容,过早触发会把
							// 输出区一起抹掉);挂载完成标志 = host 容器出现在 DOM。
							for (let i = 0; i < 20; i++) {
								if (leaf.view instanceof ExternalCodeView && leaf.view.contentEl.querySelector(".logseq-external-code-host")) break;
								await new Promise((r) => setTimeout(r, 150));
							}
							const view = leaf.view;
							if (view instanceof ExternalCodeView) await view.runCurrentFile();
						});
				});
			}),
		);
	}

	/** Which modules actually came up. Used by the e2e probe and handy in the
	 *  console when a feature looks missing. */
	loadedModuleIds(): string[] {
		return Array.from(this.live.keys());
	}

	/**
	 * 单一插件 id 时代的跨模块实例访问。旧的 my-* 插件表别名已移除：
	 * 兄弟模块一律经由宿主实例查找——
	 *   `app.plugins.plugins["obsidian-my-obsidian"]?.moduleInstance("logseq")`
	 * 外部第三方插件的 id（dataview/iconize/tasknotes…）不受影响。
	 */
	moduleInstance(id: string): SubPluginLike | undefined {
		return this.live.get(id);
	}

	onunload(): void {
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
		await this.migrateDocTreeSettings();
		await this.migrateStandaloneSettings();
	}

	/**
	 * 一次性设置迁移：收编前作为独立插件装在库里的模块（descriptor 的
	 * migrateFrom），在其数据片为空且旧 data.json 仍存在时导入一次——合并
	 * 版首次启动即继承原独立版的设置。导入后随 saveSettings 落盘，此后以
	 * 数据片为准（删掉旧插件的 data.json 即可跳过迁移）。
	 */
	private async migrateStandaloneSettings(): Promise<void> {
		let touched = false;
		for (const d of this.descriptors) {
			const standalone = d.migrateFrom;
			if (!standalone) continue;
			const state = this.settings.modules[d.id];
			if (
				!state ||
				(state.data &&
					typeof state.data === "object" &&
					Object.keys(state.data as object).length > 0)
			) {
				continue;
			}
			try {
				const path = `${this.app.vault.configDir}/plugins/${standalone}/data.json`;
				if (!(await this.app.vault.adapter.exists(path))) continue;
				const parsed = JSON.parse(await this.app.vault.adapter.read(path)) as unknown;
				if (parsed && typeof parsed === "object") {
					state.data = parsed;
					touched = true;
					console.debug(`[my-obsidian] ${d.id}: migrated settings from ${standalone}`);
				}
			} catch (e) {
				console.warn(`[my-obsidian] ${d.id}: settings migration from ${standalone} failed`, e);
			}
		}
		if (touched) await this.saveSettings();
	}

	/**
	 * 一次性 guarded 迁移(2026-10-27 模块拆分):doc-tree 拆出时,挂载/查看器/
	 * 打开方式这批设置键从 logseq 的 data 片迁到 doc-tree 的 data 片。
	 *
	 * guarded 的含义:doc-tree 片里已经有同名键(拆分后保存过)就**不覆盖**——
	 * 以拆分后的新值为准;logseq 片里的旧键无论如何都删掉(本模块的读方已
	 * 随拆分搬走,留着只是死重)。迁完立刻落盘,保证只跑一次。
	 */
	private async migrateDocTreeSettings(): Promise<void> {
		const MOUNT_KEYS = [
			"mountFilterEnabled",
			"mountLinkEnabled",
			"mountShowLoadedCount",
			"mountDragMode",
			"mountTreeOrder",
			"mountPickDir",
			"mountNewNotePath",
			"externalMounts",
			"externalSplitView",
			"externalMarkdownEditor",
			"officeViewerEnabled",
			"imageViewerTakeOver",
			"videoPlayerTakeOver",
			"openWithApps",
		];
		const lgData = this.settings.modules["logseq"]?.data as Record<string, unknown> | undefined;
		const dtState = this.settings.modules["doc-tree"];
		if (!lgData || !dtState) return;
		const target = (dtState.data ?? {}) as Record<string, unknown>;
		let touched = false;
		for (const k of MOUNT_KEYS) {
			if (lgData[k] === undefined) continue;
			if (target[k] === undefined) {
				target[k] = lgData[k];
				touched = true;
			}
			delete lgData[k];
		}
		if (!touched) return;
		dtState.data = target;
		await this.saveSettings();
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
	 *    must stay the host's (单一插件 id 策略：d.manifest 只允许覆盖
	 *    `version` 这类语义字段，`id` 覆盖已随别名机制一并移除): logseq builds
	 *    its extension-store path from `manifest.id` and writes sidecar files
	 *    under `manifest.dir`, so changing either would point outside the real
	 *    plugin folder.
	 *  - 模块自己的 addSettingTab 被截获进 capturedTabs：单 id 下模块设置页
	 *    若照常全局注册会全部撞成宿主一个键，改由宿主设置页内嵌渲染。
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
		(inst as { addSettingTab?: (tab: unknown) => void }).addSettingTab = (
			tab: unknown,
		) => {
			host.capturedTabs.set(d.id, tab);
		};
		await inst.onload();
		this.live.set(d.id, inst);
	}
}
