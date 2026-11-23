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

import { App, Menu, Plugin, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { PropsEditModal } from './modal';
import { FilePropsView, VIEW_TYPE_FILE_PROPS } from './view';

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
		const leaf =
			workspace.getLeavesOfType(VIEW_TYPE_FILE_PROPS)[0] ??
			workspace.getRightLeaf(false) ??
			workspace.getLeaf(true);
		await leaf.setViewState({ type: VIEW_TYPE_FILE_PROPS, active: true });
	}

	/** 属性变更后刷新所有打开的浏览器视图（编辑弹窗保存回调走这里）。 */
	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FILE_PROPS)) {
			const view = leaf.view as FilePropsView;
			if (typeof view.refresh === 'function') void view.refresh();
		}
	}

	onunload(): void {
		// 视图随 leaf 生命周期由 Obsidian 处理;无全局副作用需要摘除
	}
}

export { PropsEditModal, FilePropsView, VIEW_TYPE_FILE_PROPS };

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
