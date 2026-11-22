/**
 * 文件属性浏览器视图：筛选器 + 结果表。
 *
 * 筛选（全部可选,组合 AND）：属性名(key 精确) / 属性值(子串) / 文件夹
 * (目录前缀) / 扩展名 / 路径子串。查询走 daemon propsQuery,结果按路径
 * 分组展示（同一路径多属性合并为一行,每条属性可单独删）。
 * 行操作:打开文件（库内文件/文件夹定位到文件管理器;库外仅展示路径）、
 * 编辑（弹编辑弹窗）、删除单条属性。
 */

import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type FilePropsPlugin from './main';
import { PropsEditModal } from './modal';

export const VIEW_TYPE_FILE_PROPS = 'file-props-browser';

export class FilePropsView extends ItemView {
	private queryInput: Record<'key' | 'value' | 'folder' | 'ext' | 'path', HTMLInputElement> | null = null;
	private resultEl: HTMLElement | null = null;
	private refreshTimer = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: FilePropsPlugin) {
		super(leaf);
		this.navigation = false;
		this.icon = 'list-plus';
	}

	getViewType(): string {
		return VIEW_TYPE_FILE_PROPS;
	}

	getDisplayText(): string {
		return '文件属性浏览器';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('lgp-fp-browser');

		if (!this.plugin.getDaemon()) {
			root.createDiv({
				cls: 'lgp-fp-unavailable',
				text: '索引内核未运行——文件属性由 MyKernel 的 SQLite 存储（md-editor 模块开启后自动可用）。当前无法读写。',
			});
			return;
		}

		// —— 筛选区 ——
		const filters = root.createDiv({ cls: 'lgp-fp-filters' });
		type FilterKey = 'key' | 'value' | 'folder' | 'ext' | 'path';
		const mk = (placeholder: string, _key: FilterKey): HTMLInputElement => {
			const el = filters.createEl('input', { cls: 'lgp-fp-filter', attr: { placeholder } });
			el.addEventListener('keydown', (ev) => {
				if ((ev as KeyboardEvent).key === 'Enter') {
					ev.preventDefault();
					void this.runQuery();
				}
			});
			return el;
		};
		this.queryInput = {
			key: mk('属性名（精确）', 'key'),
			value: mk('属性值（子串）', 'value'),
			folder: mk('文件夹（前缀,如 projects/）', 'folder'),
			ext: mk('扩展名（如 md）', 'ext'),
			path: mk('路径（子串）', 'path'),
		};
		const btns = filters.createDiv({ cls: 'lgp-fp-filter-btns' });
		const runBtn = btns.createEl('button', { text: '查询', cls: 'lgp-fp-btn mod-cta' });
		runBtn.addEventListener('click', () => void this.runQuery());
		const clearBtn = btns.createEl('button', { text: '清空', cls: 'lgp-fp-btn' });
		clearBtn.addEventListener('click', () => {
			if (!this.queryInput) return;
			for (const el of Object.values(this.queryInput)) el.value = '';
			void this.runQuery();
		});

		this.resultEl = root.createDiv({ cls: 'lgp-fp-results' });
		this.resultEl.createDiv({ cls: 'lgp-fp-empty', text: '输入筛选条件后点「查询」；全部留空 = 列出全部属性。' });
	}

	/** 执行查询并渲染结果（编辑弹窗保存后的 refresh() 也走这里）。 */
	async refresh(): Promise<void> {
		if (this.refreshTimer) return;
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = 0;
			void this.runQuery();
		}, 200);
	}

	private async runQuery(): Promise<void> {
		const daemon = this.plugin.getDaemon();
		if (!this.resultEl) return;
		if (!daemon) {
			this.resultEl.empty();
			this.resultEl.createDiv({ cls: 'lgp-fp-unavailable', text: '索引内核未运行。' });
			return;
		}
		const trim = (el: HTMLInputElement | null): string => (el ? el.value.trim() : '');
		this.resultEl.empty();
		const status = this.resultEl.createDiv({ cls: 'lgp-fp-status', text: '查询中…' });
		let rows: import('./main').FilePropsRow[] = [];
		try {
			const res = await daemon.propsQuery({
				key: trim(this.queryInput?.key ?? null),
				value: trim(this.queryInput?.value ?? null),
				folder: trim(this.queryInput?.folder ?? null),
				ext: trim(this.queryInput?.ext ?? null),
				path: trim(this.queryInput?.path ?? null),
				limit: 500,
			});
			rows = res.rows;
		} catch (e) {
			status.textContent = `查询失败：${String(e).slice(0, 160)}`;
			return;
		}
		status.textContent = `${rows.length} 条属性（上限 500）`;

		if (!rows.length) {
			this.resultEl.createDiv({ cls: 'lgp-fp-empty', text: '没有匹配的属性。' });
			return;
		}

		// 按路径分组:同路径多属性合并展示
		const byPath = new Map<string, import('./main').FilePropsRow[]>();
		for (const r of rows) {
			const arr = byPath.get(r.path) ?? [];
			arr.push(r);
			byPath.set(r.path, arr);
		}
		for (const [path, props] of byPath) {
			const group = this.resultEl.createDiv({ cls: 'lgp-fp-group' });
			const head = group.createDiv({ cls: 'lgp-fp-path' });
			head.createSpan({ cls: 'lgp-fp-path-text', text: (props[0]?.isDir ? '📁 ' : '📄 ') + path });
			const editBtn = head.createEl('button', { text: '编辑', cls: 'lgp-fp-btn' });
			editBtn.addEventListener('click', () => {
				new PropsEditModal(this.plugin, path, props[0]?.isDir ?? false).open();
			});
			const openBtn = head.createEl('button', { text: '打开', cls: 'lgp-fp-btn' });
			openBtn.addEventListener('click', () => void this.openPath(path, props[0]?.isDir ?? false));
			const propsEl = group.createDiv({ cls: 'lgp-fp-props' });
			for (const p of props) {
				const row = propsEl.createDiv({ cls: 'lgp-fp-prop-row' });
				row.createSpan({ cls: 'lgp-fp-key', text: p.key });
				row.createSpan({ cls: 'lgp-fp-val', text: p.value === '' ? '（空）' : p.value });
				const del = row.createEl('button', { text: '✕', cls: 'lgp-fp-btn lgp-fp-danger lgp-fp-del' });
				del.title = '删除这条属性';
				del.addEventListener('click', async () => {
					try {
						await this.plugin.getDaemon()?.propsDelete(path, p.key);
						new Notice(`已删除 ${p.key}`);
						void this.refresh();
					} catch (e) {
						new Notice(`删除失败：${String(e).slice(0, 120)}`);
					}
				});
			}
		}
	}

	/** 打开文件（库内 md 定位笔记;其他文件/文件夹尽力定位）。 */
	private async openPath(path: string, isDir: boolean): Promise<void> {
		if (isDir) {
			// 文件夹:靠 file-explorer reveal,失败仅提示
			const folder = this.app.vault.getAbstractFileByPath(path.replace(/\/+$/, ''));
			if (folder) {
				const explorer = (
					this.app as unknown as {
						internalPlugins?: { plugins?: { 'file-explorer'?: { instance?: { revealInFolder?: (folder: unknown) => void } } } };
					}
				).internalPlugins?.plugins?.['file-explorer']?.instance;
				explorer?.revealInFolder?.(folder);
				return;
			}
			new Notice('文件夹在当前库内不存在（可能已移动）');
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) {
			new Notice('文件不在当前库内（库外挂载文件请在文件管理器打开）');
			return;
		}
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file as never);
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
		this.contentEl.empty();
	}
}
