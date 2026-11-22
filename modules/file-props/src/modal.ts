/**
 * 属性编辑弹窗：单个路径（文件或文件夹）的属性 CRUD。
 *
 * 布局 = 现有属性行列表（key 只读 + value 输入 + 保存/删除）+ 新增行。
 * 保存走 propsSet（upsert）、删除走 propsDelete；daemon 不在时整个弹窗
 * 显示不可用提示（右键入口处已预检一次,这里再防并发关闭内核）。
 */

import { Modal, Notice } from 'obsidian';
import type FilePropsPlugin from './main';

interface PropRow {
	key: string;
	value: string;
	updatedAt: number;
}

export class PropsEditModal extends Modal {
	private dirty = false;

	constructor(
		private plugin: FilePropsPlugin,
		private path: string,
		private isDir: boolean,
	) {
		super(plugin.app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		const daemon = this.plugin.getDaemon();
		const title = this.isDir ? '文件夹属性' : '文件属性';
		this.titleEl.setText(`${title} · ${this.path}`);

		if (!daemon) {
			contentEl.createDiv({ cls: 'lgp-fp-unavailable', text: '索引内核未运行（需要 md-editor 模块开启且在桌面端）——无法读写文件属性。' });
			return;
		}

		let rows: PropRow[] = [];
		try {
			const res = await daemon.propsList(this.path);
			rows = res.props;
		} catch (e) {
			contentEl.createDiv({ text: `读取失败：${String(e).slice(0, 160)}` });
			return;
		}

		const list = contentEl.createDiv({ cls: 'lgp-fp-rows' });
		if (!rows.length) {
			list.createDiv({ cls: 'lgp-fp-empty', text: '还没有属性——在下方添加。' });
		}
		for (const row of rows) {
			const rowEl = list.createDiv({ cls: 'lgp-fp-row' });
			const keyEl = rowEl.createDiv({ cls: 'lgp-fp-key', text: row.key });
			keyEl.title = `更新于 ${new Date(row.updatedAt).toLocaleString()}`;
			const valueInput = rowEl.createEl('input', { cls: 'lgp-fp-value' });
			valueInput.value = row.value;
			valueInput.placeholder = '（空值）';
			const saveBtn = rowEl.createEl('button', { text: '保存', cls: 'lgp-fp-btn' });
			const delBtn = rowEl.createEl('button', { text: '删除', cls: 'lgp-fp-btn lgp-fp-danger' });
			// value 改动后保存按钮点亮（未改动时点击也无害,upsert 幂等）
			valueInput.addEventListener('input', () => {
				saveBtn.textContent = valueInput.value === row.value ? '保存' : '保存 •';
			});
			saveBtn.addEventListener('click', async () => {
				try {
					await daemon.propsSet(this.path, row.key, valueInput.value, this.isDir);
					row.value = valueInput.value;
					saveBtn.textContent = '保存';
					this.dirty = true;
					new Notice(`已保存 ${row.key}`);
					this.plugin.refreshViews();
				} catch (e) {
					new Notice(`保存失败：${String(e).slice(0, 120)}`);
				}
			});
			delBtn.addEventListener('click', async () => {
				try {
					await daemon.propsDelete(this.path, row.key);
					rowEl.remove();
					this.dirty = true;
					if (!list.querySelector('.lgp-fp-row')) list.createDiv({ cls: 'lgp-fp-empty', text: '还没有属性——在下方添加。' });
					new Notice(`已删除 ${row.key}`);
					this.plugin.refreshViews();
				} catch (e) {
					new Notice(`删除失败：${String(e).slice(0, 120)}`);
				}
			});
		}

		// 新增行
		const add = contentEl.createDiv({ cls: 'lgp-fp-add' });
		const keyInput = add.createEl('input', { cls: 'lgp-fp-value lgp-fp-new-key', attr: { placeholder: '属性名（如 项目 / 状态）' } });
		const valueInput = add.createEl('input', { cls: 'lgp-fp-value', attr: { placeholder: '属性值' } });
		const addBtn = add.createEl('button', { text: '添加', cls: 'lgp-fp-btn' });
		const commit = async (): Promise<void> => {
			const k = keyInput.value.trim();
			if (!k) {
				new Notice('属性名不能为空');
				return;
			}
			try {
				await daemon.propsSet(this.path, k, valueInput.value, this.isDir);
				this.dirty = true;
				new Notice(`已添加 ${k}`);
				// 重开整个弹窗内容（行排序/去重逻辑收敛到一处）
				await this.onOpen();
				this.plugin.refreshViews();
			} catch (e) {
				new Notice(`添加失败：${String(e).slice(0, 120)}`);
			}
		};
		addBtn.addEventListener('click', () => void commit());
		for (const input of [keyInput, valueInput]) {
			input.addEventListener('keydown', (ev) => {
				if ((ev as KeyboardEvent).key === 'Enter') {
					ev.preventDefault();
					void commit();
				}
			});
		}
		keyInput.focus();
	}

	onClose(): void {
		this.contentEl.empty();
		void this.dirty; // 变更即时落库,无需关闭确认
	}
}
