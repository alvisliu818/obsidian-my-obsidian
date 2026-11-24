/**
 * file-props —— 用户自定义文件属性。
 *
 * 给**任意文件和文件夹**（含虚拟文档树挂载的库外文件）添加 key/value 属性，
 * 权威数据存在索引守护进程的 SQLite（file_props 表，全量重建不清——见
 * md-editor/src/index/sqliteSchema.ts）。由 md-editor 模块拉起的 MyKernel
 * 提供 CRUD 通道（propsSet/propsDelete/propsList/propsQuery，daemonMain op）。
 *
 * UI 两块：
 *   1. 文件管理器右键「文件属性」→ 编辑弹窗（列出+增删改该路径全部属性）；
 *   2. 「文件属性浏览器」视图：按属性名/属性值/文件夹/扩展名/路径筛选，
 *      结果行可直接跳转、编辑、删除。
 *
 * daemon 不在（内核未起/移动端）时功能不可用——菜单项弹 Notice，视图显示
 * 提示行。数据不落 Obsidian 设置或笔记，卸载模块不会丢属性（在 SQLite 里）。
 */

import { App, Menu, Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { PropsEditModal } from './modal';
import { FilePropsView, VIEW_TYPE_FILE_PROPS } from './view';
import { formatTagValue, parseTagValue, TAGS_PROP_KEY, TagsPromptModal } from './tags';

/** 属性变更广播（其他模块据此刷新自己的属性缓存，如虚拟文档树的标签徽标）。 */
export const FILE_PROPS_CHANGED_EVENT = 'my-obsidian:file-props-changed';

export interface FilePropsRow {
	path: string;
	isDir: boolean;
	key: string;
	value: string;
	updatedAt: number;
}

/** 守护进程客户端的最小面（结构化类型,避免与 md-editor 强耦合）。 */
interface DaemonLike {
	propsSet(path: string, key: string, value: string, isDir?: boolean): Promise<{ ok: true }>;
	propsDelete(path: string, key: string): Promise<{ ok: true }>;
	propsList(path: string): Promise<{ path: string; props: { key: string; value: string; updatedAt: number }[] }>;
	propsQuery(query: {
		key?: string;
		value?: string;
		folder?: string;
		ext?: string;
		path?: string;
		limit?: number;
	}): Promise<{ rows: FilePropsRow[] }>;
}

/**
 * 取 md-editor 模块拉起的守护进程客户端（宿主 live map → 模块实例 →
 * daemonIndex）。模块 id 2026-11 从 logseq 改名 md-editor——两个键都试,
 * 兼容新旧宿主构建。桌面端专用;不在即 null。
 */
export function getDaemon(plugin: Plugin): DaemonLike | null {
	if (!plugin.app.vault.adapter) return null;
	try {
		const host = (
			plugin.app as unknown as {
				plugins?: { plugins?: Record<string, { live?: Map<string, unknown> }> };
			}
		).plugins?.plugins?.['obsidian-my-obsidian'];
		if (!host?.live) return null;
		for (const id of ['md-editor', 'logseq']) {
			const mod = host.live.get(id) as { daemonIndex?: DaemonLike | null } | undefined;
			if (mod?.daemonIndex) return mod.daemonIndex;
		}
		return null;
	} catch {
		return null;
	}
}

export default class FilePropsPlugin extends Plugin {
	getDaemon(): DaemonLike | null {
		return getDaemon(this);
	}

	/**
	 * 跨模块入口（虚拟文档树等）：直接打开某个路径的属性编辑弹窗。
	 * 路径语义由调用方决定——库内文件用库内相对路径，库外挂载用绝对路径，
	 * 远端挂载用虚拟路径；file_props 表按字符串存，三者互不冲突。
	 */
	openPropsEditor(path: string, isDir: boolean): void {
		new PropsEditModal(this, path, isDir).open();
	}

	/**
	 * 跨模块入口（虚拟文档树等）：编辑某个路径的 `tags` 属性。
	 *
	 * 标签就是属性（用户 2026-11-24 定调）——不另立存储，直接读写 file_props 的
	 * `tags` 行；空列表 = 删除该行。`onDone` 拿到最新标签名，调用方负责刷新自己
	 * 的缓存/视图（虚拟文档树刷新树行徽标）。
	 */
	async openTagEditor(
		path: string,
		isDir: boolean,
		onDone?: (names: string[]) => void,
		extraSuggestions?: string[],
	): Promise<void> {
		const daemon = this.getDaemon();
		if (!daemon) {
			new Notice('索引内核未运行（md-editor 模块未开启或非桌面端）——标签写在文件属性里，暂不可用');
			return;
		}
		let current: string[] = [];
		try {
			const res = await daemon.propsList(path);
			const hit = res.props.find((p) => p.key === TAGS_PROP_KEY);
			current = parseTagValue(hit?.value ?? '');
		} catch (e) {
			new Notice(`读取标签失败：${String(e).slice(0, 120)}`);
			return;
		}
		const known = await this.allTagNames(daemon);
		// 调用方还可以带自己的标签名进来（虚拟文档树的 TagDef 调色板里可能有
		// 还没有任何文件用到的历史标签，属性表里查不到，但用户点选得到）
		const suggestions = [...known];
		for (const n of extraSuggestions ?? []) {
			const name = String(n ?? '').trim().replace(/^#+/, '');
			if (name && !suggestions.includes(name)) suggestions.push(name);
		}
		new TagsPromptModal(this.app, {
			path,
			isDir,
			current,
			suggestions,
			onSubmit: async (names) => {
				try {
					if (names.length) await daemon.propsSet(path, TAGS_PROP_KEY, formatTagValue(names), isDir);
					else await daemon.propsDelete(path, TAGS_PROP_KEY);
				} catch (e) {
					new Notice(`保存标签失败：${String(e).slice(0, 120)}`);
					throw e;
				}
				this.refreshViews();
				onDone?.(names);
			},
		}).open();
	}

	/** 全库已知标签名（跨路径汇总 `tags` 属性的值），做录入建议。 */
	async allTagNames(daemon?: DaemonLike | null): Promise<string[]> {
		const d = daemon ?? this.getDaemon();
		if (!d) return [];
		try {
			const res = await d.propsQuery({ key: TAGS_PROP_KEY, limit: 5000 });
			const set = new Set<string>();
			for (const r of res.rows) for (const n of parseTagValue(r.value)) set.add(n);
			return [...set].sort((a, b) => a.localeCompare(b));
		} catch {
			return [];
		}
	}

	async onload(): Promise<void> {
		// 文件管理器右键（文件与文件夹都触发 file-menu）：加「文件属性」入口。
		// 只认真正的库内 TFile/TFolder：虚拟文档树会把库外文件以 TExternalFile /
		// 适配器形状转发同一条事件，路径不是库内相对路径，交给它在树菜单里的
		// 「文件属性…」显式入口处理，避免重复项与错误主键。
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file) => {
				if (!(file instanceof TFile) && !(file instanceof TFolder)) return;
				const isDir = file instanceof TFolder;
				menu.addItem((item) => {
					item
						.setTitle('文件属性')
						.setIcon('list-plus')
						.onClick(() => {
							new PropsEditModal(this, file.path, isDir).open();
						});
				});
				// 标签 = tags 属性（用户 2026-11-24）：原生右键也给同一入口，
				// 与虚拟文档树里的「添加标签…」写同一行 file_props。
				menu.addItem((item) => {
					item
						.setTitle('添加标签…')
						.setIcon('tags')
						.onClick(() => void this.openTagEditor(file.path, isDir));
				});
			}),
		);

		this.registerView(VIEW_TYPE_FILE_PROPS, (leaf: WorkspaceLeaf) => new FilePropsView(leaf, this));

		this.addRibbonIcon('list-plus', '文件属性浏览器', () => void this.openView());

		this.addCommand({
			id: 'open-file-props-browser',
			name: '打开文件属性浏览器',
			callback: () => void this.openView(),
		});
	}

	async openView(): Promise<void> {
		const { workspace } = this.app;
		// 右侧栏已有本视图 → 复用；否则在右侧栏**新开一个标签**（getRightLeaf(true)），
		// 不顶掉用户当前那一格（反链/大纲等）。
		const leaf =
			workspace.getLeavesOfType(VIEW_TYPE_FILE_PROPS)[0] ??
			workspace.getRightLeaf(true) ??
			workspace.getLeaf(true);
		await leaf.setViewState({ type: VIEW_TYPE_FILE_PROPS, active: true });
		// 右侧栏折叠时 setViewState 只把视图挂进叶子、**不展开侧栏**——视图量到
		// 0×0，用户观感就是「点了没反应/打不开」（2026-11-24 实报：工具栏
		// 「更多 → 文件属性浏览器」点了没有任何界面出现）。revealLeaf 的契约
		// 是「叶子在 sidedock 里就把 sidedock 展开」，兜底再显式 toggle 一次。
		await workspace.revealLeaf(leaf);
		const root = leaf.getRoot() as unknown as { collapsed?: boolean; toggle?: () => void };
		if (root?.collapsed && typeof root.toggle === 'function') root.toggle();
	}

	/** 属性变更后刷新所有打开的浏览器视图（编辑弹窗保存回调走这里）。 */
	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FILE_PROPS)) {
			const view = leaf.view as FilePropsView;
			if (typeof view.refresh === 'function') void view.refresh();
		}
		// 跨模块广播：属性表变了（可能是 tags 行）——虚拟文档树的树行徽标/标签
		// 筛选缓存是另一份内存快照，靠这个事件跟着刷新，不必重开面板。
		try {
			window.dispatchEvent(new CustomEvent(FILE_PROPS_CHANGED_EVENT));
		} catch {
			/* ignore */
		}
	}

	onunload(): void {
		// 视图随 leaf 生命周期由 Obsidian 处理;无全局副作用需要摘除
	}
}

export { PropsEditModal, FilePropsView, VIEW_TYPE_FILE_PROPS };
export { TagsPromptModal, parseTagValue, formatTagValue, TAGS_PROP_KEY } from './tags';

/**
 * 取当前宿主里已启用的 file-props 模块实例（未启用/未加载时 null）。
 * 虚拟文档树的右键入口与工具栏按钮经此调用，不直接依赖模块生命周期。
 */
export function filePropsOf(app: App): FilePropsPlugin | null {
	try {
		const host = (
			app as unknown as {
				plugins?: { plugins?: Record<string, { live?: Map<string, unknown> }> };
			}
		).plugins?.plugins?.['obsidian-my-obsidian'];
		const inst = host?.live?.get('file-props') as FilePropsPlugin | undefined;
		return inst && typeof inst.openPropsEditor === 'function' ? inst : null;
	} catch {
		return null;
	}
}
