/**
 * 库记录修改对比弹窗(2026-11-21 用户):点「对比」/编辑器装点标记打开——
 * 行级 diff(删除红/新增绿/修改蓝,行号+符号),底部「撤回此文件到该记录前」
 * (写回修改前内容,对比数据源见 LifePlugin.recordSnapshots)。
 */
import { Modal, Notice, type App } from 'obsidian';
import type LifePlugin from './main';

export class VaultLogDiffModal extends Modal {
	constructor(
		app: App,
		private plugin: LifePlugin,
		private path: string,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText('修改对比');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('vl-diff-modal');
		contentEl.createDiv({ cls: 'vl-diff-path', text: this.path });

		const diff = await this.plugin.getRecordDiff(this.path);
		if (!diff) {
			contentEl.createDiv({
				cls: 'vl-diff-empty',
				text: '该文件当前与上次提交(HEAD)一致(可能已撤回/已提交)。',
			});
			return;
		}

		const events: Array<{ line: number; kind: 'add' | 'mod' | 'del'; text: string }> = [
			...diff.added.map((l) => ({ line: l, kind: 'add' as const, text: '' })),
			...diff.modified.map((l) => ({ line: l, kind: 'mod' as const, text: '' })),
			...diff.deleted.map((d) => ({ line: d.line, kind: 'del' as const, text: d.text })),
		].sort((x, y) => x.line - y.line || (x.kind === 'del' ? -1 : 1));

		const list = contentEl.createDiv({ cls: 'vl-diff-list' });
		for (const ev of events) {
			const row = list.createDiv({ cls: `vl-diff-row is-${ev.kind}` });
			row.createSpan({ cls: 'vl-diff-lineno', text: String(ev.kind === 'del' ? Math.max(0, ev.line - 1) : ev.line) });
			row.createSpan({ cls: 'vl-diff-sign', text: ev.kind === 'add' ? '+' : ev.kind === 'mod' ? '~' : '-' });
			row.createSpan({ cls: 'vl-diff-text', text: ev.text });
		}
		if (events.length === 0) {
			list.createDiv({ cls: 'vl-diff-empty', text: '无差异。' });
		}

		const foot = contentEl.createDiv({ cls: 'vl-diff-foot' });
		// 「打开原文件」(2026-11-22 用户):对比看完直接跳原文件编辑。装点已在
		// openModifiedFileWithDiff 登记,编辑器里仍能看到行级差异标记。
		const openBtn = foot.createEl('button', { cls: 'life-home-rec-btn', text: '打开原文件' });
		openBtn.addEventListener('click', () => {
			void this.app.workspace.openLinkText(this.path, '', false);
			this.close();
		});
		const btn = foot.createEl('button', { cls: 'life-home-rec-btn', text: '撤回此文件到上次提交' });
		btn.addEventListener('click', async () => {
			const ok = await this.plugin.revertRecordFile(this.path);
			if (ok) {
				new Notice(`已撤回:${this.path} → 上次提交(HEAD)的内容`);
				this.close();
			} else {
				new Notice('撤回失败:git 模块未启用或文件不在仓库中');
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
