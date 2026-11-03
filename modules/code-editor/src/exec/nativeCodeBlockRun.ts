/**
 * 原生 Markdown 编辑器（实时预览 / 源码模式）与阅读模式的代码块「▶ 运行」。
 *
 * 与 logseq 块编辑器侧的 exec/codeBlockRun.ts 平行：同一执行层（runCode，
 * 真子进程 + 临时文件，stdin 支持），不同的挂载面——这里挂的是 Obsidian
 * 自带的 markdown 管线：
 *
 * - 编辑器（实时预览/源码模式）：StateField 扫描全文档围栏代码块，可运行
 *   语言（python/js/shell）在开栅栏行尾挂「▶」按钮（行内 widget），闭栅栏
 *   行后挂输出面板（块级 widget——**必须走 StateField**,Obsidian 禁止
 *   ViewPlugin 提供 block 装饰,实测见下）。运行/输出状态按「文件#可运行块
 *   序号」存模块级 Map；输出分块只改面板 DOM（不走 CM effect,不打断用户
 *   选中文本）,docChanged 时才重算装饰。面板常驻装饰（无输出时
 *   display:none）,运行开始不需要触发 CM update。
 * - 阅读模式：registerMarkdownPostProcessor 给 pre>code 加按钮行与面板，
 *   键 = 文件 + 代码文本哈希（阅读模式拿不到块序号；同内容重渲染后面板能
 *   找回输出）。
 *
 * 思源侧「输出面板必须挂块外」的坑在这里不存在：widget 是渲染层、阅读模式
 * DOM 不写回 md，都不进文档正文。
 *
 * CM6 用 @codemirror/* 直连（esbuild external 约定 = Obsidian 自己的
 * CodeMirror 实例，与原生编辑器/其他社区插件共享同一份）；editorInfoField
 * 从 obsidian 取。widget 点击回调用 posAtDOM 现场重解析块——不持有易失效
 * 的行号，重跑永远执行当前编辑器里的代码。
 */
import type { MarkdownPostProcessor, Plugin } from "obsidian";
import { editorInfoField } from "obsidian";
import {
	Decoration,
	EditorView,
	WidgetType,
	type DecorationSet,
} from "@codemirror/view";
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { langFromTag, runCode, type RunLang } from "./runner";
import type { RunHandle } from "./pythonRunner";
import { parseFences, type FenceBlock } from "./nativeFence";

// ---------------------------------------------------------------------
// 运行状态：两个挂载面共用
// ---------------------------------------------------------------------

interface NativeRunState {
	output: string;
	running: boolean;
	exitCode: number | null;
	collapsed: boolean;
	handle: RunHandle | null;
}

/** 编辑面 = 文件#nb序号；阅读面 = md:文件:内容哈希 */
const states = new Map<string, NativeRunState>();
const MAX_STATES = 300;

function ensureState(key: string): NativeRunState {
	let st = states.get(key);
	if (!st) {
		// 容量兜底：淘汰最旧的非运行条目（Map 迭代按插入序）
		if (states.size >= MAX_STATES) {
			for (const [k, v] of states) {
				if (!v.running) {
					states.delete(k);
					break;
				}
			}
		}
		st = { output: '', running: false, exitCode: null, collapsed: false, handle: null };
		states.set(key, st);
	}
	return st;
}

/** 面板重跑时怎么拿到最新代码：CM 现场重解析，阅读面用渲染时快照 */
type RunSurface =
	| { kind: 'cm'; view: EditorView; file: string }
	| { kind: 'md'; code: string; lang: RunLang; cwd?: string };

interface RootEntry {
	key: string;
	root: HTMLElement;
	surface: RunSurface;
}

/** 面板 DOM 登记：状态分块到达时按 key 逐个改写 */
const roots = new Map<string, Set<RootEntry>>();

function registerRoot(key: string, entry: RootEntry): void {
	let set = roots.get(key);
	if (!set) {
		set = new Set();
		roots.set(key, set);
	}
	set.add(entry);
}

// ---------------------------------------------------------------------
// 面板 DOM（class 与 logseq 侧 codeBlockRun 同名，共用根 styles.css 的样式）
// ---------------------------------------------------------------------

function renderPanelInto(entry: RootEntry): void {
	const { key, root } = entry;
	const st = states.get(key);
	if (!st || (!st.running && st.exitCode === null && st.output === '')) {
		// 没跑过/已清除：空壳留着，display:none（装饰不用重建）
		root.style.display = 'none';
		root.innerHTML = '';
		return;
	}
	root.style.display = '';
	root.innerHTML = '';

	const head = document.createElement('div');
	head.className = 'lgp-cb-run__head';
	const label = document.createElement('span');
	label.className = 'lgp-cb-run__label';
	label.textContent = st.running
		? '运行中…'
		: st.exitCode === 0
			? '完成'
			: st.exitCode === null
				? '输出'
				: `退出码 ${st.exitCode}`;
	head.appendChild(label);

	const actions = document.createElement('span');
	actions.className = 'lgp-cb-run__actions';
	const mkBtn = (text: string, title: string, onClick: () => void): HTMLElement => {
		const b = document.createElement('span');
		b.className = 'lgp-cb-run__btn';
		b.textContent = text;
		b.title = title;
		b.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			onClick();
		});
		return b;
	};
	actions.appendChild(
		mkBtn(st.collapsed ? '展开' : '折叠', '收起或展开输出', () => {
			st.collapsed = !st.collapsed;
			syncPanels(key);
		}),
	);
	if (st.running) {
		actions.appendChild(mkBtn('停止', '中断运行（杀掉子进程）', () => st.handle?.interrupt()));
	} else {
		actions.appendChild(mkBtn('重跑', '重新执行此代码块（取编辑器里的最新代码）', () => rerun(entry)));
	}
	actions.appendChild(
		mkBtn('复制', '复制全部输出（纯文本）', () => {
			void navigator.clipboard.writeText(st.output);
		}),
	);
	actions.appendChild(
		mkBtn('清除', '清空输出并复位', () => {
			if (st.running) st.handle?.interrupt();
			states.delete(key);
			syncPanels(key);
		}),
	);
	head.appendChild(actions);
	root.appendChild(head);

	if (st.collapsed) return;

	const out = document.createElement('pre');
	out.className = 'lgp-cb-run__output';
	out.textContent = st.output || (st.running ? '' : '(无输出)');
	root.appendChild(out);

	// stdin 输入框跟着运行态走（程序 input() 等输入时才有）；先渲染后登记
	// 的顺序错误会让它永远出不来——startRun 里先置 running 再 syncPanels。
	if (st.running) {
		const wrap = document.createElement('div');
		wrap.className = 'lgp-cb-run__stdin';
		const field = document.createElement('input');
		field.type = 'text';
		field.placeholder = '程序在等输入,在这里输入后回车';
		field.addEventListener('keydown', (ev) => {
			if ((ev as KeyboardEvent).key !== 'Enter') return;
			ev.preventDefault();
			const v = field.value;
			field.value = '';
			if (v) {
				// 回显必须写进 st.output,不能只改 DOM——后续输出分块会用
				// st.output 整体覆盖面板文本,只改 DOM 的回显下一瞬间就被抹掉
				// (思源侧踩过的坑)。默认让输入独占一行:悬空的提示行(如
				// "who? ")后面补一个换行,不把输入粘在提示后面。
				const nl = st.output === '' || st.output.endsWith('\n') ? '' : '\n';
				st.output += `${nl}${v}\n`;
				appendOutput(key);
			}
			st.handle?.sendInput(v);
		});
		wrap.appendChild(field);
		root.appendChild(wrap);
		window.setTimeout(() => field.focus(), 0);
	}
}

/** 结构性重绘：运行态翻转、折叠、清除、退出。纯文本追加走 appendOutput。 */
function syncPanels(key: string): void {
	const set = roots.get(key);
	if (!set) return;
	for (const entry of Array.from(set)) {
		if (!entry.root.isConnected) {
			set.delete(entry);
			continue;
		}
		renderPanelInto(entry);
	}
	if (set.size === 0) roots.delete(key);
}

/** 输出分块：只改 textContent 与滚动，不动结构（面板上正在选中的文本/正在输入的 stdin 不受扰） */
function appendOutput(key: string): void {
	const st = states.get(key);
	const set = roots.get(key);
	if (!st || !set) return;
	for (const entry of set) {
		if (!entry.root.isConnected) {
			set.delete(entry);
			continue;
		}
		if (st.collapsed) continue;
		const out = entry.root.querySelector<HTMLElement>('.lgp-cb-run__output');
		if (out) {
			out.textContent = st.output;
			out.scrollTop = out.scrollHeight;
		}
	}
}

function rerun(entry: RootEntry): void {
	const s = entry.surface;
	if (s.kind === 'md') {
		startRun(entry.key, s.code, s.lang, s.cwd);
		return;
	}
	// CM 面：从面板位置现场重解析块（代码可能已被编辑，行号也可能漂移）
	const view = s.view;
	const pos = view.posAtDOM(entry.root);
	const line = view.state.doc.lineAt(pos).number;
	const blk = scanBlocks(view.state).find((b) => b.runnable && b.close === line);
	if (!blk) return;
	const file = fileOf(view.state) || s.file;
	startRunForBlock(view.state, file, blk, entry.key);
}

function startRun(key: string, code: string, lang: RunLang, cwd?: string): void {
	const st = ensureState(key);
	if (st.running) return;
	st.running = true;
	st.exitCode = null;
	st.output = '';
	st.collapsed = false;
	try {
		st.handle = runCode({
			code,
			lang,
			cwd,
			onOutput: (chunk) => {
				st.output += chunk;
				if (st.output.length > 200_000) st.output = st.output.slice(-100_000);
				appendOutput(key);
			},
			onExit: (exit) => {
				st.handle = null;
				st.running = false;
				st.exitCode = exit;
				syncPanels(key);
			},
		});
	} catch (err) {
		st.running = false;
		st.handle = null;
		st.exitCode = -1;
		st.output += `\n[启动失败] ${err instanceof Error ? err.message : String(err)}\n`;
	}
	// 顺序要紧：先登记运行态再渲染面板，stdin 输入框才会出现
	syncPanels(key);
}

// ---------------------------------------------------------------------
// CM6 面（实时预览 + 源码模式）
// ---------------------------------------------------------------------

function scanBlocks(state: EditorState): FenceBlock[] {
	const doc = state.doc;
	const lines: string[] = new Array(doc.lines);
	for (let i = 1; i <= doc.lines; i++) lines[i - 1] = doc.line(i).text;
	return parseFences(lines);
}

function fileOf(state: EditorState): string | null {
	return state.field(editorInfoField, false)?.file?.path ?? null;
}

const keyOf = (file: string, ordinal: number): string => `${file}#nb${ordinal}`;

/** 代码块工作目录 = 所在文件夹（与思源侧「文档目录」同理，相对路径资源可达） */
function cwdForFile(state: EditorState, filePath: string): string | undefined {
	const info = state.field(editorInfoField, false);
	const app = info?.app;
	if (!app) return undefined;
	const dir = filePath.includes('/') ? filePath.replace(/\/[^/]*$/, '') : '';
	const adapter = app.vault.adapter as unknown as { getFullPath?: (p: string) => string };
	if (typeof adapter.getFullPath === 'function') {
		try {
			return adapter.getFullPath(dir);
		} catch {
			/* fall through */
		}
	}
	return undefined;
}

function startRunForBlock(state: EditorState, file: string, blk: FenceBlock, key: string): void {
	const doc = state.doc;
	const parts: string[] = [];
	for (let n = blk.open + 1; n < blk.close; n++) parts.push(doc.line(n).text);
	const lang = langFromTag(blk.lang) ?? 'python';
	startRun(key, parts.join('\n'), lang, cwdForFile(state, file));
}

class RunBtnWidget extends WidgetType {
	constructor(
		readonly key: string,
		readonly lang: string,
	) {
		super();
	}

	// 运行时只会传入同类实例（基类签名的锅，参数收宽再收窄）
	eq(other: WidgetType): boolean {
		return other instanceof RunBtnWidget && other.key === this.key && other.lang === this.lang;
	}

	// widget 内的事件 CM 一律不处理：按钮点击不会挪光标，stdin 输入不进编辑器
	ignoreEvent(): boolean {
		return true;
	}

		toDOM(view: EditorView): HTMLElement {
			const btn = document.createElement('span');
			btn.className = 'lgp-code-run';
			btn.textContent = '▶';
			btn.setAttribute('aria-label', `运行此${this.lang || ''}代码块`);
			btn.addEventListener('mousedown', (e) => e.preventDefault());
			btn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				// 不持有行号：点击时从按钮位置反查所在块
				const pos = view.posAtDOM(btn);
				const line = view.state.doc.lineAt(pos).number;
				const blk = scanBlocks(view.state).find((b) => b.runnable && b.open === line);
				if (!blk) return;
				const file = fileOf(view.state);
				if (!file) return;
				startRunForBlock(view.state, file, blk, keyOf(file, blk.ordinal));
			});
			return btn;
		}
}

class OutWidget extends WidgetType {
	/** toDOM 时捕获的视图：destroy 只有 dom 参数，按 view 身份清理登记 */
	private attachedView: EditorView | null = null;

	constructor(readonly key: string) {
		super();
	}

	eq(other: WidgetType): boolean {
		return other instanceof OutWidget && other.key === this.key;
	}

	ignoreEvent(): boolean {
		return true;
	}

	toDOM(view: EditorView): HTMLElement {
		this.attachedView = view;
		const root = document.createElement('div');
		root.className = 'lgp-cb-run lgp-md-cb-run';
		const file = fileOf(view.state) ?? '';
		const entry: RootEntry = { key: this.key, root, surface: { kind: 'cm', view, file } };
		registerRoot(this.key, entry);
		renderPanelInto(entry);
		return root;
	}

	destroy(_dom: HTMLElement): void {
		const view = this.attachedView;
		if (!view) return;
		this.attachedView = null;
		const set = roots.get(this.key);
		if (!set) return;
		for (const entry of Array.from(set)) {
			const s = entry.surface;
			if (s.kind === 'cm' && s.view === view) set.delete(entry);
		}
		if (set.size === 0) roots.delete(this.key);
	}
}

/**
 * 装饰构建 + 注册。
 *
 * 为什么是 StateField 而不是 ViewPlugin:Obsidian 的 CM6 fork **禁止插件经
 * ViewPlugin 的 decorations 提供 block 装饰**——运行时报
 * `RangeError: Block decorations may not be specified via plugins`
 * (e2e 探针 2026-11-01 实测;官方文档也写明 block widget 必须走 StateField)。
 * StateField 没有 viewport 概念,所以全文档建装饰(块多时也只是轻量对象,
 * toDOM 只对可视区调用),docChanged 时整体重算;纯选择/滚动变化不动。
 */
function buildRunDecos(state: EditorState): DecorationSet {
	const file = fileOf(state);
	if (!file) return Decoration.none;
	const doc = state.doc;
	const blocks = scanBlocks(state);
	const builder = new RangeSetBuilder<Decoration>();
	let added = false;
	for (const blk of blocks) {
		if (!blk.runnable) continue;
		const openLine = doc.line(blk.open);
		const closeLine = doc.line(blk.close);
		const key = keyOf(file, blk.ordinal);
		builder.add(openLine.to, openLine.to, Decoration.widget({ widget: new RunBtnWidget(key, blk.lang), side: 1 }));
		builder.add(closeLine.to, closeLine.to, Decoration.widget({ widget: new OutWidget(key), block: true, side: 1 }));
		added = true;
	}
	return added ? builder.finish() : Decoration.none;
}

const runDecosField: StateField<DecorationSet> = StateField.define<DecorationSet>({
	create: (state) => buildRunDecos(state),
	update: (value, tr) => (tr.docChanged ? buildRunDecos(tr.state) : value),
	provide: (f) => EditorView.decorations.compute([f], (state) => state.field(f)),
});

const nativeRunExtension: Extension = runDecosField;

// ---------------------------------------------------------------------
// 阅读模式（registerMarkdownPostProcessor）
// ---------------------------------------------------------------------

/** djb2 变体 + 长度：阅读面状态键（内容不变则键不变） */
function shortHash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36) + '-' + s.length.toString(36);
}

/** vault 相对路径 → 所在文件夹的绝对路径（runner 的工作目录） */
function cwdForVaultPath(plugin: Plugin, sourcePath: string): string | undefined {
	const adapter = plugin.app.vault.adapter as unknown as {
		getFullPath?: (p: string) => string;
	};
	const dir = sourcePath.includes('/') ? sourcePath.replace(/\/[^/]*$/, '') : '';
	if (typeof adapter.getFullPath === 'function') {
		try {
			return adapter.getFullPath(dir);
		} catch {
			/* fall through */
		}
	}
	return undefined;
}

function nativeRunPostProcessor(plugin: Plugin): MarkdownPostProcessor {
	return (el, ctx) => {
		el.querySelectorAll('pre').forEach((pre) => {
			const code = pre.querySelector('code');
			if (!code) return;
			const langClass = Array.from(code.classList).find((c) => c.startsWith('language-'));
			if (!langClass) return;
			const tag = langClass.slice('language-'.length);
			const lang = langFromTag(tag);
			if (!lang) return;
			const codeText = code.textContent ?? '';
			if (!codeText.trim()) return;
			const key = `md:${ctx.sourcePath}:${shortHash(codeText)}`;
			const cwd = cwdForVaultPath(plugin, ctx.sourcePath);

			const bar = document.createElement('div');
			bar.className = 'lgp-md-run-bar';
			// 语言标签居左、运行按钮居右（样式在 styles.css 的 flex bar 上）
			const langTag = document.createElement('span');
			langTag.className = 'lgp-md-run-bar__lang';
			langTag.textContent = tag;
			bar.appendChild(langTag);
			const btn = document.createElement('span');
			btn.className = 'lgp-code-run';
			btn.textContent = '▶ 运行';
			btn.setAttribute('aria-label', `运行此${tag}代码块`);
			btn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				startRun(key, codeText, lang, cwd);
			});
			bar.appendChild(btn);

			const root = document.createElement('div');
			root.className = 'lgp-cb-run lgp-md-cb-run';
			const entry: RootEntry = { key, root, surface: { kind: 'md', code: codeText, lang, cwd } };
			registerRoot(key, entry);
			renderPanelInto(entry);

			const parent = pre.parentNode;
			if (parent) {
				parent.insertBefore(bar, pre);
				parent.insertBefore(root, pre.nextSibling);
			}
		});
	};
}

// ---------------------------------------------------------------------
// 注册入口
// ---------------------------------------------------------------------

/**
 * 注册到宿主插件（桌面端）。onload 里调用一次；插件卸载时中断所有子进程
 * 并清空状态。
 */
export function registerNativeCodeBlockRun(plugin: Plugin): void {
	plugin.registerEditorExtension(nativeRunExtension);
	plugin.registerMarkdownPostProcessor(nativeRunPostProcessor(plugin));
	plugin.register(() => {
		states.forEach((st) => {
			try {
				st.handle?.interrupt();
			} catch {
				/* 已退出 */
			}
		});
		states.clear();
		roots.clear();
	});
}
