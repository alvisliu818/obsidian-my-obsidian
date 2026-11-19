/**
 * 库记录共享渲染层(2026-11-19):HOME 的「库记录」节与独立的库记录面板
 * (life-vaultlog)共用同一套行/明细/设置渲染——状态由调用方持有(展开集/
 * 明细视图模式),变更后由调用方整体重绘。
 *
 * 类名沿用 life-home-*(样式同一套,视觉一致)。
 */
import { changeSummary } from '../vaultLog';
import type { VaultLogRecord, VaultLogSettings } from '../types';

export interface VaultLogUiState {
	/** 明细展开的记录 id 集合 */
	expandedIds: Set<string>;
	/** 明细视图:总体平铺 / 按顶级文件夹分组 */
	detailMode: 'overall' | 'folder';
	/** 设置节是否展开 */
	settingsOpen: boolean;
}

export interface VaultLogUiHandlers {
	/** 记录行点击(展开/收起明细) */
	onToggleRecord: (id: string) => void;
	/** 明细视图切换(overall/folder) */
	onModeChange: (mode: 'overall' | 'folder') => void;
	/** 手动打点 */
	onManualRecord: () => void | Promise<void>;
	/** 设置变更(开关/输入);设置节独立渲染,记录列表不需要 */
	onSettingsChange?: () => void;
}

/** 记录行摘要(+N · ~M · -K + 时间 + 触发方式)。 */
export function renderRecordSummaryRow(container: HTMLElement, rec: VaultLogRecord): void {
	const row = container.createDiv({ cls: 'life-home-rec-summary' });
	row.createSpan({
		cls: 'life-home-rec-counts',
		text: `+${rec.added.length} 新增 · ~${rec.modified.length} 修改 · -${rec.deleted.length} 删除`,
	});
	row.createSpan({
		cls: 'life-home-rec-meta',
		text: `${rec.at.slice(11, 16)} · ${rec.trigger === 'manual' ? '手动' : rec.trigger === 'daily' ? '每日' : '周期'}`,
	});
}

/** 记录列表(摘要行 + 点击展开明细 + 总体/按文件夹切换)。 */
export function renderRecordListInto(
	container: HTMLElement,
	records: VaultLogRecord[],
	state: VaultLogUiState,
	handlers: VaultLogUiHandlers,
): void {
	if (records.length === 0) {
		container.createDiv({ cls: 'life-home-muted', text: '暂无记录。' });
		return;
	}
	const modeRow = container.createDiv({ cls: 'life-home-mode-row' });
	for (const [label, mode] of [
		['总体', 'overall'],
		['按文件夹', 'folder'],
	] as const) {
		const btn = modeRow.createEl('button', { cls: 'life-home-mode-btn', text: label });
		if (state.detailMode === mode) btn.addClass('is-active');
		btn.addEventListener('click', (ev) => {
			ev.stopPropagation();
			handlers.onModeChange(mode);
		});
	}
	for (const rec of records) {
		const isExpanded = state.expandedIds.has(rec.id);
		const row = container.createDiv({ cls: 'life-home-rec-row' });
		row.createSpan({
			cls: 'life-home-rec-time',
			text: rec.date.slice(5) + ' ' + rec.at.slice(11, 16),
		});
		row.createSpan({ cls: 'life-home-rec-counts', text: changeSummary(rec) });
		row.createSpan({ cls: 'life-home-rec-trigger', text: rec.trigger === 'manual' ? '手动' : '自动' });
		row.addEventListener('click', () => handlers.onToggleRecord(rec.id));
		if (!isExpanded) continue;
		const detail = container.createDiv({ cls: 'life-home-rec-detail' });
		renderDiffListsInto(detail, rec, state.detailMode);
	}
}

/** 变化清单:overall = 平铺三类;folder = 按顶级文件夹分组(路径→条目)。 */
export function renderDiffListsInto(container: HTMLElement, rec: VaultLogRecord, mode: 'overall' | 'folder'): void {
	const empty = rec.added.length + rec.modified.length + rec.deleted.length === 0;
	if (empty) {
		container.createDiv({ cls: 'life-home-muted', text: '(无变化)' });
		return;
	}
	if (mode === 'overall') {
		const kinds: [string, string[], string][] = [
			['新增', rec.added, 'is-added'],
			['修改', rec.modified, 'is-modified'],
			['删除', rec.deleted, 'is-deleted'],
		];
		for (const [label, list, cls] of kinds) {
			if (list.length === 0) continue;
			container.createDiv({ cls: 'life-home-rec-kind-title', text: `${label}(${list.length})` });
			for (const p of list.slice(0, 30)) {
				container.createDiv({ cls: `life-home-rec-item ${cls}`, text: p });
			}
			if (list.length > 30) container.createDiv({ cls: 'life-home-muted', text: `…还有 ${list.length - 30} 条` });
		}
		return;
	}
	const groups = new Map<string, { label: string; kind: 'added' | 'modified' | 'deleted' }[]>();
	const put = (path: string, kind: 'added' | 'modified' | 'deleted') => {
		const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '(根)';
		const list = groups.get(dir) ?? [];
		list.push({ label: path.slice(dir === '(根)' ? 0 : dir.length + 1), kind });
		groups.set(dir, list);
	};
	for (const p of rec.added) put(p, 'added');
	for (const p of rec.modified) put(p, 'modified');
	for (const p of rec.deleted) put(p, 'deleted');
	for (const [dir, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const g = container.createDiv({ cls: 'life-home-rec-group' });
		g.createDiv({ cls: 'life-home-rec-group-title', text: dir });
		for (const it of items) {
			const cls = it.kind === 'added' ? 'is-added' : it.kind === 'modified' ? 'is-modified' : 'is-deleted';
			g.createDiv({ cls: `life-home-rec-item ${cls}`, text: (it.kind === 'added' ? '+ ' : it.kind === 'modified' ? '~ ' : '- ') + it.label });
		}
	}
}

/** 库记录设置节(开关/每日时间/周期/记录后提醒/每日提醒时间)。 */
export function renderVaultLogSettingsInto(
	container: HTMLElement,
	vl: VaultLogSettings,
	onChange: () => void,
): void {
	const toggleRow = (label: string, value: boolean, cb: (v: boolean) => void): void => {
		const row = container.createDiv({ cls: 'life-home-setting-row' });
		row.createSpan({ cls: 'life-home-setting-label', text: label });
		const btn = row.createEl('button', { cls: 'life-home-mode-btn', text: value ? '开' : '关' });
		btn.addEventListener('click', () => {
			cb(!value);
			btn.setText(!value ? '开' : '关');
			onChange();
		});
	};
	const textRow = (label: string, value: string, placeholder: string, cb: (v: string) => void): void => {
		const row = container.createDiv({ cls: 'life-home-setting-row' });
		row.createSpan({ cls: 'life-home-setting-label', text: label });
		const input = row.createEl('input', { cls: 'life-home-setting-input', attr: { placeholder } });
		input.value = value;
		input.addEventListener('change', () => {
			cb(input.value.trim());
			onChange();
		});
	};
	toggleRow('自动记录', vl.enabled, (v) => {
		vl.enabled = v;
	});
	textRow('每日记录时间', vl.dailyTime, '21:00', (v) => {
		vl.dailyTime = v;
	});
	textRow('周期记录(分钟,0=关)', String(vl.periodMin || ''), '如 30', (v) => {
		vl.periodMin = Math.max(0, Math.floor(Number(v) || 0));
	});
	toggleRow('记录后提醒', vl.remind, (v) => {
		vl.remind = v;
	});
	textRow('每日提醒时间', vl.remindTime, '09:00', (v) => {
		vl.remindTime = v;
	});
}
