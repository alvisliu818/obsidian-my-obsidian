/**
 * Vault virtual explorer — the file-explorer view replacement.
 *
 * Why it exists: the native explorer builds one DOM row per vault file at
 * load (heap snapshot 2026-11-04: 55,153 detached rows ≈ 165k nodes + a
 * 58k-entry item registry, permanent). This view renders a virtualised band
 * of ~viewport rows instead, so a 55k-file vault costs the same as a 500-file
 * one: O(expanded subtree) rows in a transient array, ~132 live DOM rows.
 *
 * Selector compatibility is deliberate: rows keep the native classes
 * (.tree-item/.nav-file/.nav-file-title, `data-path` on the self element) so
 * sibling code that targets explorer rows — logseq dnd.ts drop highlighting
 * reads `.nav-file-title/.nav-folder-title[data-path]`, theme snippets —
 * keeps working unchanged.
 *
 * Core interop surface (each verified against app.js 1.15):
 *  - `revealInFolder(file)` — the core command host resolves the leaf then
 *    calls `leaf.view.revealInFolder(file)`.
 *  - `getSortedFolderItems(folder)` — hearth's explorerorder reads the
 *    explorer's display order through it.
 *  - `getState()/setState()` — the `file-explorer:new-folder` command lands
 *    the created folder via `ensureSideLeaf(..., { state: { newFile: path } })`.
 */

import { ItemView, Menu, Notice, TFile, TFolder, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type VirtualTreePlugin from "../main";
import {
	vxExpandedForReveal,
	vxFlatten,
	vxIndexOf,
	vxRepathExpanded,
	vxSortChildren,
	type VxNode,
	type VxRow,
	type VxSortOrder,
} from "./model";

/** Must match the CSS row height so the spacer maths stays honest. */
const VX_ROW_HEIGHT = 25;
/** Rows drawn beyond the viewport on each side, so fast scrolling stays filled. */
const VX_OVERSCAN = 10;

const SORT_LABELS: Record<VxSortOrder, string> = {
	alphabetical: "文件名 A→Z",
	alphabeticalReverse: "文件名 Z→A",
	byModifiedTime: "修改时间 新→旧",
	byModifiedTimeReverse: "修改时间 旧→新",
};

const SORT_ICON: Record<VxSortOrder, string> = {
	alphabetical: "arrow-down-a-z",
	alphabeticalReverse: "arrow-up-z-a",
	byModifiedTime: "arrow-down-wide-narrow",
	byModifiedTimeReverse: "arrow-up-narrow-wide",
};

export const VIEW_TYPE_FILE_EXPLORER = "file-explorer";

export class VaultExplorerView extends ItemView {
	plugin: VirtualTreePlugin;
	/** Folders currently expanded. Root is implicitly expanded and never enters. */
	private expanded = new Set<string>();
	private sortOrder: VxSortOrder = "alphabetical";
	private autoReveal = false;
	/** Search query ("" = off). Non-empty switches the model into walk-all mode. */
	private query = "";
	/** The flattened draw list (transient, rebuilt on any state change). */
	private rows: VxRow[] = [];
	/** The ancestor that scrolls this view (the nav-files-container). */
	private scroller: HTMLElement | null = null;
	private spacer: HTMLElement | null = null;
	private band: HTMLElement | null = null;
	private searchInput: HTMLInputElement | null = null;
	/** Path pending a reveal after the next repaint (locate/reveal flows). */
	private pendingReveal: string | null = null;
	/** Drag sources (vault paths) captured at dragstart, consumed at drop. */
	private dragging: string[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: VirtualTreePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_FILE_EXPLORER;
	}

	getDisplayText(): string {
		return "文件";
	}

	getIcon(): string {
		return "lucide-files";
	}

	// ------------------------------------------------------------------
	// vault → model adapter (lazy, zero copying)
	// ------------------------------------------------------------------

	/** The live children of a vault folder as lazy model nodes. */
	private nodesOf(folder: TFolder): VxNode[] {
		return folder.children.map((child): VxNode => {
			if (child instanceof TFolder) {
				return { path: child.path, name: child.name, isDir: true, children: this.nodesOf(child) };
			}
			return { path: child.path, name: child.name, isDir: false, children: null };
		});
	}

	private mtimeOf(node: VxNode): number | undefined {
		const f = this.app.vault.getAbstractFileByPath(node.path);
		return f instanceof TFile ? f.stat.mtime : undefined;
	}

	private rebuild(): void {
		this.rows = vxFlatten(
			this.nodesOf(this.app.vault.getRoot()),
			this.expanded,
			this.sortOrder,
			(node) => this.mtimeOf(node),
			this.query,
		);
	}

	// ------------------------------------------------------------------
	// lifecycle
	// ------------------------------------------------------------------

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.buildHeader();
		const scroller = this.contentEl.createDiv({ cls: "nav-files-container lgp-vx" });
		scroller.setAttribute("data-type", "file-explorer");
		this.scroller = scroller;
		this.spacer = scroller.createDiv({ cls: "lgp-vx-spacer" });
		this.spacer.style.position = "relative";
		this.band = this.spacer.createDiv({ cls: "lgp-vx-band" });
		this.band.style.position = "absolute";
		this.band.style.left = "0";
		this.band.style.right = "0";
		this.registerDomEvent(scroller, "scroll", () => this.paint(), { passive: true });
		// Vault structure events: a debounced refresh covers create/delete;
		// rename must also repoint the expanded set before repainting.
		const refresh = this.debounce(() => this.refresh(), 200);
		this.registerEvent(this.app.vault.on("create", () => refresh()));
		this.registerEvent(this.app.vault.on("delete", () => refresh()));
		this.registerEvent(this.app.vault.on("modify", () => refresh()));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.expanded = vxRepathExpanded(this.expanded, oldPath, file.path);
				refresh();
			}),
		);
		// Auto-reveal the active file (mirrors core's autoRevealFile toggle).
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!file || !this.autoReveal) return;
				void this.revealInFolder(file);
			}),
		);
		this.rebuild();
		this.paint();
	}

	async onClose(): Promise<void> {
		this.scroller = null;
		this.spacer = null;
		this.band = null;
		this.rows = [];
	}

	/** View state: expanded folders + sort + auto-reveal (workspace-persisted). */
	getState(): Record<string, unknown> {
		return {
			expanded: [...this.expanded],
			sortOrder: this.sortOrder,
			autoReveal: this.autoReveal,
		};
	}

	async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
		const raw = state as {
			expanded?: unknown;
			sortOrder?: unknown;
			autoReveal?: unknown;
			newFile?: unknown;
		};
		if (Array.isArray(raw.expanded)) {
			this.expanded = new Set(raw.expanded.filter((p): p is string => typeof p === "string"));
		}
		if (typeof raw.sortOrder === "string" && raw.sortOrder in SORT_LABELS) {
			this.sortOrder = raw.sortOrder as VxSortOrder;
		}
		if (typeof raw.autoReveal === "boolean") this.autoReveal = raw.autoReveal;
		await super.setState(state, result);
		if (typeof raw.newFile === "string" && raw.newFile) {
			// The `file-explorer:new-folder` command lands here: reveal the
			// freshly created folder (core would start renaming it).
			this.pendingReveal = raw.newFile;
			this.revealPending();
		}
	}

	// ------------------------------------------------------------------
	// header
	// ------------------------------------------------------------------

	private buildHeader(): void {
		const header = this.contentEl.createDiv({ cls: "nav-header lgp-vx-header" });
		const btn = (icon: string, label: string, onClick: (ev: MouseEvent) => void): HTMLDivElement => {
			const b = header.createDiv({ cls: "clickable-icon nav-action-button", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.addEventListener("click", (ev) => onClick(ev));
			return b;
		};
		btn("lucide-edit", "新建笔记", () => void this.app.fileManager.createAndOpenMarkdownFile("", "tab"));
		btn("lucide-folder-plus", "新建文件夹", () => {
			void this.app.fileManager
				.createNewFolder(this.folderAt(this.lastClickedDir) ?? this.app.vault.getRoot())
				.then((folder) => {
					this.pendingReveal = folder.path;
					this.refresh();
				});
		});
		const sortBtn = btn(SORT_ICON[this.sortOrder], SORT_LABELS[this.sortOrder], (ev) => {
			const menu = new Menu();
			for (const order of Object.keys(SORT_LABELS) as VxSortOrder[]) {
				menu.addItem((item) =>
					item
						.setTitle(SORT_LABELS[order])
						.setIcon(SORT_ICON[order])
						.setChecked(order === this.sortOrder)
						.onClick(() => {
							this.sortOrder = order;
							setIcon(sortBtn, SORT_ICON[order]);
							sortBtn.setAttribute("aria-label", SORT_LABELS[order]);
							this.refresh();
						}),
				);
			}
			menu.showAtMouseEvent(ev);
		});
		const revealBtn = btn(
			"lucide-gallery-vertical",
			this.autoReveal ? "自动定位当前文件：开" : "自动定位当前文件：关",
			() => {
				this.autoReveal = !this.autoReveal;
				revealBtn.setAttribute("aria-label", this.autoReveal ? "自动定位当前文件：开" : "自动定位当前文件：关");
				revealBtn.toggleClass("is-active", this.autoReveal);
				const active = this.app.workspace.getActiveFile();
				if (this.autoReveal && active) void this.revealInFolder(active);
			},
		);
		revealBtn.toggleClass("is-active", this.autoReveal);
		btn("lucide-chevrons-down-up", "全部收起", () => {
			this.expanded.clear();
			this.refresh();
		});
		btn("lucide-search", "搜索文件名", () => {
			if (this.searchInput) {
				this.searchInput.focus();
				return;
			}
			const bar = this.contentEl.createDiv({ cls: "lgp-vx-search" });
			const input = bar.createEl("input", { cls: "lgp-vx-search-input", attr: { type: "text", placeholder: "文件名过滤…" } });
			this.searchInput = input;
			input.addEventListener("input", () => {
				this.query = input.value;
				this.refresh();
			});
			input.addEventListener("keydown", (ev) => {
				if (ev.key === "Escape") {
					input.value = "";
					this.query = "";
					this.searchInput = null;
					bar.remove();
					this.refresh();
					(ev.target as HTMLElement).blur?.();
				}
			});
			input.focus();
		});
		// 最近点击的目录：新建文件夹/笔记落点（空 = 根）。
		this.lastClickedDir = "";
	}

	/** 最近一次点击的目录路径（工具栏「新建」的落点）。 */
	private lastClickedDir = "";

	private debounce(fn: () => void, ms: number): () => void {
		let t: ReturnType<typeof setTimeout> | null = null;
		return () => {
			if (t !== null) clearTimeout(t);
			t = setTimeout(fn, ms);
		};
	}

	// ------------------------------------------------------------------
	// rendering
	// ------------------------------------------------------------------

	private refresh(): void {
		this.rebuild();
		this.paint();
	}

	/** Repaint the visible band into the absolutely positioned band element. */
	private paint(): void {
		const scroller = this.scroller;
		const spacer = this.spacer;
		const band = this.band;
		if (!scroller || !spacer || !band) return;
		spacer.style.height = `${this.rows.length * VX_ROW_HEIGHT}px`;
		let first = 0;
		let last = this.rows.length;
		const outer = scroller.getBoundingClientRect();
		if (outer.height > 0) {
			const above = Math.floor(scroller.scrollTop / VX_ROW_HEIGHT);
			first = Math.max(0, above - VX_OVERSCAN);
			const visible = Math.ceil(outer.height / VX_ROW_HEIGHT) + VX_OVERSCAN * 2;
			last = Math.min(this.rows.length, first + visible);
		}
		band.empty();
		band.style.transform = `translateY(${first * VX_ROW_HEIGHT}px)`;
		for (let i = first; i < last; i++) {
			this.renderRow(band, this.rows[i]);
		}
		this.consumePendingReveal();
	}

	private renderRow(parent: HTMLElement, row: VxRow): void {
		const item = parent.createDiv({ cls: `tree-item ${row.isDir ? "nav-folder" : "nav-file"}` });
		const self = item.createDiv({
			cls: `tree-item-self ${row.isDir ? "nav-folder-title" : "nav-file-title"} is-clickable`,
			attr: { "data-path": row.path, draggable: "true" },
		});
		self.style.paddingInlineStart = `${4 + row.depth * 17}px`;
		if (row.isDir) {
			const caret = self.createDiv({ cls: "tree-item-icon collapse-icon nav-action-icon" });
			setIcon(caret, "right-triangle");
			caret.toggleClass("is-collapsed", !this.expanded.has(row.path));
		}
		const inner = self.createDiv({ cls: "tree-item-inner" });
		inner.createDiv({ cls: "tree-item-inner-text nav-file-title-content", text: row.name });

		if (row.isDir) {
			self.addEventListener("click", () => this.toggleFolder(row.path));
		} else {
			self.addEventListener("click", () => this.openRow(row));
		}
		// 最近点击的目录（文件夹行点击/文件行取父目录）。
		if (row.isDir) {
			self.addEventListener("contextmenu", (ev) => {
				this.lastClickedDir = row.path;
				this.showMenu(ev, row);
			});
		}
		self.addEventListener("contextmenu", (ev) => {
			if (!row.isDir) this.showMenu(ev, row);
		});
		this.wireDrag(self, row);
	}

	private toggleFolder(path: string): void {
		if (this.expanded.has(path)) this.expanded.delete(path);
		else this.expanded.add(path);
		this.lastClickedDir = path;
		this.refresh();
	}

	private async openRow(row: VxRow): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(row.path);
		if (!(file instanceof TFile)) return;
		// 同文件已开 → 聚焦既有标签（2026-11-07 用户报:重复点击堆叠新标签）
		if (this.plugin.focusIfOpen(file)) return;
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		// 打开后聚焦（2026-11-07 用户报）：焦点留在侧栏的话编辑器没有光标
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	// ------------------------------------------------------------------
	// context menu / rename
	// ------------------------------------------------------------------

	private folderAt(path: string): TFolder | null {
		if (!path) return this.app.vault.getRoot();
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFolder ? f : null;
	}

	private showMenu(ev: MouseEvent, row: VxRow): void {
		ev.preventDefault();
		ev.stopPropagation();
		const target = this.app.vault.getAbstractFileByPath(row.path);
		if (!target) return;
		const isDir = target instanceof TFolder;
		const menu = new Menu();
		if (!isDir && target instanceof TFile) {
			menu.addItem((item) =>
				item.setTitle("打开").setIcon("file-text").onClick(() => void this.openRow(row)),
			);
			menu.addItem((item) =>
				item
					.setTitle("在新标签页打开")
					.setIcon("file-plus")
					.onClick(() => {
						const leaf = this.app.workspace.getLeaf("tab");
						void leaf.openFile(target).then(() => this.app.workspace.setActiveLeaf(leaf, { focus: true }));
					}),
			);
		} else {
			menu.addItem((item) =>
				item
					.setTitle("新建笔记")
					.setIcon("file-plus")
					.onClick(() => void this.app.fileManager.createAndOpenMarkdownFile(`${row.path}/`, "tab")),
			);
			menu.addItem((item) =>
				item
					.setTitle("新建文件夹")
					.setIcon("folder-plus")
					.onClick(() => void this.app.fileManager.createNewFolder(target as TFolder)),
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle("重命名").setIcon("text-cursor-input").onClick(() => this.startInlineRename(row)),
		);
		menu.addItem((item) =>
			item
				.setTitle("删除…")
				.setIcon("trash-2")
				.onClick(() => void this.app.fileManager.promptForDeletion(target)),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("复制路径")
				.setIcon("copy")
				.onClick(() => {
					void navigator.clipboard?.writeText(row.path);
					new Notice("已复制路径");
				}),
		);
		// 「取消链接到库内」：这一行若是外部文件/文件夹用 mklink 链接进库的
		// 结果，直接从库内侧拆链（虚拟树用 files-menu，不吃 file-menu 事件，
		// 所以这里显式补一次，与原生 file-explorer 共用插件上的同一个方法）。
		this.plugin.addUnlinkMenuItem(menu, [target]);
		// 与核心 explorer 同一入口：社区插件（git、标签管理等）在同一 trigger
		// 上往菜单里添项——菜单语义对齐原生。
		this.app.workspace.trigger("files-menu", menu, [target], "file-explorer-context-menu", null);
		menu.showAtMouseEvent(ev);
	}

	/** 行内重命名：inner 转 contenteditable，Enter/失焦提交，Escape 取消。 */
	private startInlineRename(row: VxRow): void {
		const inner = this.band?.querySelector<HTMLElement>(
			`.tree-item-self[data-path="${CSS.escape(row.path)}"] .tree-item-inner`,
		);
		if (!inner) return;
		const file = this.app.vault.getAbstractFileByPath(row.path);
		if (!file) return;
		const textEl = inner.querySelector<HTMLElement>(".nav-file-title-content") ?? inner;
		const original = row.name;
		textEl.setAttribute("contenteditable", "true");
		textEl.focus();
		// 选中主名（带扩展名的文件只选扩展名前的部分，与核心一致）。
		const sel = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(textEl);
		const dot = original.lastIndexOf(".");
		if (!file.hasOwnProperty("children") && dot > 0) {
			range.setStart(textEl.firstChild ?? textEl, 0);
			range.setEnd(textEl.firstChild ?? textEl, dot);
		}
		sel?.removeAllRanges();
		sel?.addRange(range);

		const commit = (): void => {
			textEl.removeAttribute("contenteditable");
			const typed = textEl.textContent?.trim() ?? "";
			if (!typed || typed === original) {
				textEl.textContent = original;
				return;
			}
			const slash = row.path.lastIndexOf("/");
			const dir = slash === -1 ? "" : row.path.slice(0, slash + 1);
			// 没写扩展名就沿用原扩展名（文件夹无此逻辑）。
			let newName = typed;
			if (!file.hasOwnProperty("children") && !typed.includes(".") && original.includes(".")) {
				newName = `${typed}${original.slice(original.lastIndexOf("."))}`;
			}
			void this.app.fileManager.renameFile(file, `${dir}${newName}`);
		};
		textEl.addEventListener("keydown", function handler(ev) {
			if (ev.key === "Enter") {
				ev.preventDefault();
				this.removeEventListener("keydown", handler);
				commit();
			} else if (ev.key === "Escape") {
				this.removeEventListener("keydown", handler);
				textEl.removeAttribute("contenteditable");
				textEl.textContent = original;
			}
		});
		textEl.addEventListener(
			"blur",
			() => commit(),
			{ once: true },
		);
	}

	// ------------------------------------------------------------------
	// drag & drop（移动到文件夹）
	// ------------------------------------------------------------------

	private wireDrag(self: HTMLElement, row: VxRow): void {
		self.addEventListener("dragstart", (ev) => {
			this.dragging = [row.path];
			ev.dataTransfer?.setData("text/plain", row.path);
			if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
			self.addClass("is-dragging-src");
		});
		self.addEventListener("dragend", () => {
			this.dragging = [];
			self.removeClass("is-dragging-src");
			this.band?.querySelectorAll(".lgp-vx-drop-target").forEach((el) => el.removeClass("lgp-vx-drop-target"));
		});
		if (!row.isDir) return;
		// 文件夹行是投放目标：拖入即移动（源不能是目标自身的后代）。
		self.addEventListener("dragover", (ev) => {
			if (this.dragging.length === 0) return;
			if (this.dragging.some((p) => p === row.path || p.startsWith(`${row.path}/`))) return;
			ev.preventDefault();
			if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
			self.addClass("lgp-vx-drop-target");
		});
		self.addEventListener("dragleave", () => self.removeClass("lgp-vx-drop-target"));
		self.addEventListener("drop", (ev) => {
			self.removeClass("lgp-vx-drop-target");
			if (this.dragging.length === 0) return;
			ev.preventDefault();
			const moved = this.dragging.filter(
				(p) => p !== row.path && !p.startsWith(`${row.path}/`),
			);
			this.dragging = [];
			for (const p of moved) {
				const f = this.app.vault.getAbstractFileByPath(p);
				if (!f) continue;
				const name = p.slice(p.lastIndexOf("/") + 1);
				void this.app.fileManager.renameFile(f, `${row.path}/${name}`);
			}
		});
	}

	// ------------------------------------------------------------------
	// reveal
	// ------------------------------------------------------------------

	/** Core command surface (`file-explorer:reveal-active-file` lands here). */
	async revealInFolder(file: TAbstractFileLike): Promise<void> {
		this.pendingReveal = file.path;
		this.expanded = vxExpandedForReveal(file.path, this.expanded);
		this.refresh();
	}

	private revealPending(): void {
		const path = this.pendingReveal;
		if (!path) return;
		this.expanded = vxExpandedForReveal(path, this.expanded);
		this.refresh();
	}

	private consumePendingReveal(): void {
		const path = this.pendingReveal;
		if (!path) return;
		const idx = vxIndexOf(this.rows, path);
		if (idx < 0) return;
		this.pendingReveal = null;
		const scroller = this.scroller;
		if (!scroller) return;
		const target = idx * VX_ROW_HEIGHT - scroller.clientHeight / 2 + VX_ROW_HEIGHT / 2;
		scroller.scrollTop = Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight));
		this.paint();
		const el = this.band?.querySelector<HTMLElement>(`.tree-item-self[data-path="${CSS.escape(path)}"]`);
		if (!el) return;
		el.addClass("lgp-vx-flash");
		window.setTimeout(() => el.removeClass("lgp-vx-flash"), 1600);
	}

	// ------------------------------------------------------------------
	// hearth compat：explorerorder 走 getSortedFolderItems 读显示序
	// ------------------------------------------------------------------

	getSortedFolderItems(folder: TFolder): { file: { path: string } }[] {
		const children = folder.children ?? [];
		return vxSortChildren(
			children.map((c): VxNode => ({ path: c.path, name: c.name, isDir: c instanceof TFolder, children: null })),
			this.sortOrder,
			(node) => this.mtimeOf(node),
		).map((n) => ({ file: { path: n.path } }));
	}

	/** 全部收起（工具栏与核心语义一致）。 */
	collapseAll(): void {
		this.expanded.clear();
		this.refresh();
	}
}

/** Minimal structural type so revealInFolder can accept TFile/TFolder without
 * importing their class identity into the method signature. */
interface TAbstractFileLike {
	path: string;
}
