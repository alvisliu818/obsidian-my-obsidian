/**
 * 标签筛选独立面板(用户 2026-11-19 三轮演进:单独一栏 → 工具栏按钮+弹窗 →
 * **独立面板**)。激活的标签 id 存在插件实例(activeTagFilterIds,运行态不落盘),
 * 挂载树 flattenHost 按它过滤:命中任一激活标签的文件保留、目录一律保留。
 *
 * 结构与 recentOpenPanel 同款:标题 + 清除 + chips;chips 点击即时生效
 * (自绘 + 挂载面板重绘);TAGS_CHANGED_EVENT 时跟随重绘(树行菜单新建标签后
 * chips 不陈旧)。
 */
import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type VirtualTreePlugin from '../main';
import { allTags } from '../features/tagStore';
import { TAGS_CHANGED_EVENT, type TagDef } from '../types';

export const VIEW_TYPE_TAG_FILTER_PANEL = 'vt-tag-filter-panel';

export class TagFilterPanelView extends ItemView {
	plugin: VirtualTreePlugin;
	private chipHostEl: HTMLElement | null = null;
	private hintEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: VirtualTreePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_TAG_FILTER_PANEL;
	}

	getDisplayText(): string {
		return '标签筛选';
	}

	getIcon(): string {
		return 'tags';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('vt-tag-filter-panel');

		const bar = this.contentEl.createDiv({ cls: 'logseq-mount-section' });
		bar.style.display = 'flex';
		bar.style.alignItems = 'center';
		bar.createSpan({ cls: 'logseq-mount-name', text: '标签筛选' });
		const clear = bar.createEl('button', { text: '清除' });
		clear.style.cssText =
			'border:none;background:transparent;cursor:pointer;color:var(--text-faint);font-size:11px;margin-left:auto';
		clear.addEventListener('click', () => this.setActive([]));

		this.chipHostEl = this.contentEl.createDiv();
		this.chipHostEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:2px 8px 6px';
		this.hintEl = this.contentEl.createDiv();
		this.hintEl.style.cssText = 'font-size:12px;color:var(--text-muted);padding:0 10px';
		this.render();
		// 树行菜单新建/删除标签后 chips 跟手(不重开面板也不陈旧)。
		// registerDomEvent 的 typings 只收 HTMLElementEventMap 键名,自定义事件名
		// 过不了——直接 addEventListener + register 卸载。
		const onTagsChanged = (): void => this.render();
		window.addEventListener(TAGS_CHANGED_EVENT, onTagsChanged);
		this.register(() => window.removeEventListener(TAGS_CHANGED_EVENT, onTagsChanged));
	}

	render(): void {
		if (!this.chipHostEl || !this.hintEl) return;
		const tags = allTags(this.plugin.settings);
		const active = this.plugin.activeTagFilterIds;
		this.chipHostEl.empty();
		if (!tags.length) {
			this.chipHostEl.hide();
			this.hintEl.show();
			this.hintEl.setText('还没有标签。右键树行 →「标签…」→「+ 新建标签…」先建一个。');
			return;
		}
		this.hintEl.hide();
		this.chipHostEl.show();
		for (const td of tags) {
			const on = active.includes(td.id);
			const chip = this.chipHostEl.createEl('button', { text: '#' + td.name });
			chip.style.cssText = TagFilterPanelView.chipCss(td, on);
			chip.addEventListener('click', () =>
				this.setActive(on ? active.filter((x) => x !== td.id) : [...active, td.id]),
			);
		}
		if (active.length) {
			const note = this.chipHostEl.createSpan({ text: `${active.length} 个激活` });
			note.style.cssText = 'font-size:10px;color:var(--text-faint);margin-left:auto';
		}
	}

	/** 面板与挂载树共用的激活集合变更入口。 */
	private setActive(next: string[]): void {
		this.plugin.activeTagFilterIds = next;
		this.render();
		for (const leaf of this.app.workspace.getLeavesOfType('logseq-mount-panel')) {
			(leaf.view as { render?: () => void }).render?.();
		}
		// vaultVirtualExplorer 接管:挂载面板长在 file-explorer 里,按类型再刷一遍
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view?.getViewType?.() === 'file-explorer') {
				(leaf.view as unknown as { renderMountPanel?: () => void }).renderMountPanel?.();
				(leaf.view as unknown as { render?: () => void }).render?.();
			}
		});
	}

	/** chip 皮肤:激活=标签色底白字(与旧筛选区/弹窗同款)。 */
	private static chipCss(td: TagDef, on: boolean): string {
		return (
			'font-size:11px;border:1px solid ' +
			(on ? 'transparent' : 'var(--background-modifier-border)') +
			';border-radius:10px;padding:2px 10px;cursor:pointer;background:' +
			(on ? td.color ?? 'var(--color-accent)' : 'var(--background-secondary)') +
			';color:' +
			(on ? '#fff' : 'var(--text-muted)')
		);
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}
