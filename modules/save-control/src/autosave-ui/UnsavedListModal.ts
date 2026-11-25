/**
 * 未保存文件列表弹窗（用户 2026-11-20：底部状态栏的保存状态图标可以点击，
 * 点击打开一个标签页，显示未保存的文件列表）。
 *
 * 数据源（main.ts 组装 ctx 传入）：
 *   - 库内待保存：AutoSaveController.getPendingPaths()（逐条 flushPath/
 *     discardPath——关闭提示同款决策面）
 *   - 库外脏视图：iterateAllLeaves 里 isDirty 的 external handle（逐条 save）
 * 条目动作后重绘（列表与状态栏图标同步）。
 */
import { Modal, setIcon, type App } from 'obsidian';

export interface UnsavedExternalEntry {
	/** 展示用路径（库外文件的真实路径）。 */
	path: string;
	save: () => Promise<void>;
}

export interface UnsavedListCtx {
	vaultPending: string[];
	externalEntries: UnsavedExternalEntry[];
	flushVaultPath: (path: string) => Promise<void>;
	discardVaultPath: (path: string) => void;
	refresh: () => void;
}

export class UnsavedListModal extends Modal {
	private readonly ctx: UnsavedListCtx;

	constructor(app: App, ctx: UnsavedListCtx) {
		super(app);
		this.ctx = ctx;
	}

	onOpen(): void {
		this.render();
	}

	/** 动作后重绘（列表与状态栏图标同步——main.ts 的 refresh 回调也走这里）。 */
	render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: '未保存的文件' });

		const hasVault = this.ctx.vaultPending.length > 0;
		const hasExternal = this.ctx.externalEntries.length > 0;
		if (!hasVault && !hasExternal) {
			contentEl.createEl('div', { cls: 'sc-unsaved-empty', text: '没有未保存的更改。' });
			return;
		}

		if (hasVault) {
			contentEl.createEl('div', { cls: 'sc-unsaved-section', text: '库内待保存' });
			const list = contentEl.createDiv({ cls: 'sc-unsaved-list' });
			for (const path of this.ctx.vaultPending) {
				const row = list.createDiv({ cls: 'sc-unsaved-row' });
				row.createSpan({ cls: 'sc-unsaved-path', text: path });
				const save = row.createEl('span', { cls: 'sc-unsaved-act', attr: { 'aria-label': '立即保存' } });
				setIcon(save, 'save');
				save.addEventListener('click', () => {
					void this.ctx.flushVaultPath(path).then(() => this.render());
				});
				const discard = row.createEl('span', { cls: 'sc-unsaved-act is-danger', attr: { 'aria-label': '放弃更改' } });
				setIcon(discard, 'x');
				discard.addEventListener('click', () => {
					this.ctx.discardVaultPath(path);
					this.render();
				});
			}
		}

		if (hasExternal) {
			contentEl.createEl('div', { cls: 'sc-unsaved-section', text: '库外文件' });
			const list = contentEl.createDiv({ cls: 'sc-unsaved-list' });
			for (const entry of this.ctx.externalEntries) {
				const row = list.createDiv({ cls: 'sc-unsaved-row' });
				row.createSpan({ cls: 'sc-unsaved-path', text: entry.path });
				const save = row.createEl('span', { cls: 'sc-unsaved-act', attr: { 'aria-label': '立即保存' } });
				setIcon(save, 'save');
				save.addEventListener('click', () => {
					void entry.save().then(() => this.render());
				});
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
