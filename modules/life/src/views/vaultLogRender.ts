/**
 * 库记录共享渲染层(2026-11-19;2026-11-20 改进):HOME 的「库记录」节与独立
 * 的库记录面板(life-vaultlog)共用同一套行/明细/设置渲染——状态由调用方
 * 持有(展开集/明细视图模式/折叠目录集),变更后由调用方整体重绘。
 *
 * 2026-11-20(用户:文件点击能跳转/像目录树一样展开折叠/识别不准):
 * - 明细条目可点击打开文件(新增/修改/重命名目标;删除只有路径,不可点);
 * - 「按文件夹」升级为真目录树(逐级展开折叠,默认全展开,点击目录行收起);
 * - 重命名/移动单独一类展示(签名配对,识别在 vaultLog.diffWithRenames)。
 *
 * 类名沿用 life-home-*(样式同一套,视觉一致)。
 */
import { changeSummary } from '../vaultLog';
import { Setting } from 'obsidian';
import type { VaultLogRecord, VaultLogSettings } from '../types';

export interface VaultLogUiState {
	/** 明细展开的记录 id 集合 */
	expandedIds: Set<string>;
	/** 明细视图:总体平铺 / 按文件夹树 */
	detailMode: 'overall' | 'folder';
	/** 设置节是否展开 */
	settingsOpen: boolean;
	/** 目录树里被收起的目录(键 `记录id::目录路径`;缺省 = 全展开) */
	collapsedDirs?: Set<string>;
}

export interface VaultLogUiHandlers {
	/** 记录行点击(展开/收起明细) */
	onToggleRecord: (id: string) => void;
	/** 明细视图切换(overall/folder) */
	onModeChange: (mode: 'overall' | 'folder') => void;
	/** 手动打点 */
	onManualRecord: () => void | Promise<void>;
	/** 打开文件(新增/修改/重命名目标条目点击;缺省 = 条目不可点) */
	onOpenFile?: (path: string) => void;
	/** 修改条目点击(2026-11-21 用户,基线=上次 git 提交):打开文件并登记修改
	 * 装点(行号右侧绿/蓝标志);缺省回落 onOpenFile。 */
	onOpenModified?: (path: string) => void;
	/** 「对比」小钮(修改条目):打开修改对比弹窗(与上次提交比),可撤回。 */
	onCompareFile?: (path: string) => void;
	/** 设置变更(开关/输入);设置节独立渲染,记录列表不需要 */
	onSettingsChange?: () => void;
}

/** 记录行摘要(+N · ~M · -K [+ 重命名 R] + 时间 + 触发方式)。 */
export function renderRecordSummaryRow(container: HTMLElement, rec: VaultLogRecord): void {
	const row = container.createDiv({ cls: 'life-home-rec-summary' });
	row.createSpan({
		cls: 'life-home-rec-counts',
		text: `+${rec.added.length} 新增 · ~${rec.modified.length} 修改 · -${rec.deleted.length} 删除${rec.renames?.length ? ` · ⇄${rec.renames.length}` : ''}`,
	});
	row.createSpan({
		cls: 'life-home-rec-meta',
		text: `${rec.at.slice(11, 16)} · ${rec.trigger === 'manual' ? '手动' : rec.trigger === 'daily' ? '每日' : '周期'}`,
	});
}

/** 明细条目(可点击打开——删除条目只有路径,不可点)。返回元素供追加按钮。 */
function renderDiffItem(
	container: HTMLElement,
	text: string,
	cls: string,
	path: string | null,
	handlers: VaultLogUiHandlers,
	compare?: () => void,
): HTMLElement {
	const el = container.createDiv({ cls: `life-home-rec-item ${cls}`, text });
	if (path && handlers.onOpenFile) {
		el.addClass('is-openable');
		el.addEventListener('click', (ev) => {
			ev.stopPropagation();
			handlers.onOpenFile?.(path);
		});
	}
	if (compare) {
		const btn = el.createEl('button', {
			cls: 'life-home-rec-compare',
			text: '对比',
			attr: { 'aria-label': '查看修改对比,可撤回' },
		});
		btn.addEventListener('click', (ev) => {
			ev.stopPropagation();
			compare();
		});
	}
	return el;
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
		row.createSpan({
			cls: 'life-home-rec-counts',
			text: changeSummary(rec, rec.renames?.length ?? 0) + (rec.first ? ' · 基线' : ''),
		});
		row.createSpan({ cls: 'life-home-rec-trigger', text: rec.trigger === 'manual' ? '手动' : '自动' });
		row.addEventListener('click', () => handlers.onToggleRecord(rec.id));
		if (!isExpanded) continue;
		const detail = container.createDiv({ cls: 'life-home-rec-detail' });
		renderDiffListsInto(detail, rec, state.detailMode, state, handlers);
	}
}

// ---------------------------------------------------------------------------
// 目录树(「按文件夹」视图):逐级展开折叠
// ---------------------------------------------------------------------------

interface PathTreeNode {
	/** 显示名(路径末段;根节点 = '') */
	name: string;
	/** 完整库内目录路径(根 = '';收起状态的 key 用) */
	fullPath: string;
	/** 子目录 */
	dirs: Map<string, PathTreeNode>;
	/** 挂在本目录下的文件条目(不递归) */
	files: Array<{ label: string; kind: 'added' | 'modified' | 'deleted' | 'renamed'; openPath: string | null }>;
}

function emptyNode(name: string, fullPath: string): PathTreeNode {
	return { name, fullPath, dirs: new Map(), files: [] };
}

/** 变化路径集 → 目录树(重命名条目挂在目标路径下,显示 ← 原路径)。 */
function buildPathTree(rec: VaultLogRecord): PathTreeNode {
	const root = emptyNode('', '');
	const nodeAt = (dir: string): PathTreeNode => {
		let node = root;
		if (dir === '') return node;
		for (const seg of dir.split('/')) {
			let next = node.dirs.get(seg);
			if (!next) {
				next = emptyNode(seg, node.fullPath === '' ? seg : `${node.fullPath}/${seg}`);
				node.dirs.set(seg, next);
			}
			node = next;
		}
		return node;
	};
	const put = (path: string, kind: 'added' | 'modified' | 'deleted' | 'renamed', openPath: string | null, label?: string) => {
		const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		const name = dir === '' ? path : path.slice(dir.length + 1);
		nodeAt(dir).files.push({ label: label ?? name, kind, openPath });
	};
	for (const p of rec.added) put(p, 'added', p);
	for (const p of rec.modified) put(p, 'modified', p);
	for (const p of rec.deleted) put(p, 'deleted', null);
	for (const r of rec.renames ?? []) put(r.to, 'renamed', r.to, `${r.to.split('/').pop()} ← ${r.from}`);
	return root;
}

const KIND_PREFIX: Record<PathTreeNode['files'][number]['kind'], string> = {
	added: '+ ',
	modified: '~ ',
	deleted: '- ',
	renamed: '⇄ ',
};
const KIND_CLASS: Record<PathTreeNode['files'][number]['kind'], string> = {
	added: 'is-added',
	modified: 'is-modified',
	deleted: 'is-deleted',
	renamed: 'is-renamed',
};

/** 目录树递归渲染(收起状态存 state.collapsedDirs,键 `记录id::路径`)。 */
function renderPathTree(
	container: HTMLElement,
	node: PathTreeNode,
	recId: string,
	state: VaultLogUiState,
	handlers: VaultLogUiHandlers,
	depth: number,
	leafBudget: { n: number },
): void {
	for (const [name, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const key = `${recId}::${child.fullPath}`;
		const collapsed = state.collapsedDirs?.has(key) ?? false;
		const row = container.createDiv({ cls: 'life-home-rec-dir-row', attr: { style: `padding-left:${depth * 14}px` } });
		row.createSpan({ cls: 'life-home-rec-dir-chevron', text: collapsed ? '▸' : '▾' });
		row.createSpan({ cls: 'life-home-rec-dir-name', text: name });
		row.addEventListener('click', (ev) => {
			ev.stopPropagation();
			const set = state.collapsedDirs ?? (state.collapsedDirs = new Set<string>());
			if (set.has(key)) set.delete(key);
			else set.add(key);
			handlers.onModeChange(state.detailMode); // 借道重绘(视图模式没变,调用方整体重绘)
		});
		if (!collapsed) {
			const box = container.createDiv({ cls: 'life-home-rec-dir-box' });
			renderPathTree(box, child, recId, state, handlers, depth + 1, leafBudget);
		}
	}
	for (const f of node.files) {
		if (leafBudget.n <= 0) {
			container.createDiv({ cls: 'life-home-muted', text: '…条目过多,已截断' });
			node.files = [];
			return;
		}
		leafBudget.n--;
		const item = container.createDiv({
			cls: `life-home-rec-item ${KIND_CLASS[f.kind]}`,
			attr: { style: `padding-left:${(depth + 1) * 14}px` },
			text: KIND_PREFIX[f.kind] + f.label,
		});
		if (f.openPath && handlers.onOpenFile) {
			item.addClass('is-openable');
			item.addEventListener('click', (ev) => {
				ev.stopPropagation();
				handlers.onOpenFile?.(f.openPath as string);
			});
		}
	}
}

// ---------------------------------------------------------------------------
// 明细视图
// ---------------------------------------------------------------------------

/** 变化清单:overall = 平铺四类;folder = 目录树(逐级展开折叠)。 */
export function renderDiffListsInto(
	container: HTMLElement,
	rec: VaultLogRecord,
	mode: 'overall' | 'folder',
	state: VaultLogUiState,
	handlers: VaultLogUiHandlers,
): void {
	if (rec.first) {
		container.createDiv({ cls: 'life-home-muted', text: '(首次记录:已建立基线快照,下次记录起对比变化)' });
		return;
	}
	const empty = rec.added.length + rec.modified.length + rec.deleted.length + (rec.renames?.length ?? 0) === 0;
	if (empty) {
		container.createDiv({ cls: 'life-home-muted', text: '(无变化)' });
		return;
	}
	if (mode === 'overall') {
		if (rec.renames?.length) {
			container.createDiv({ cls: 'life-home-rec-kind-title', text: `重命名/移动(${rec.renames.length})` });
			for (const r of rec.renames.slice(0, 30)) {
				renderDiffItem(container, `${r.from} ⇄ ${r.to}`, 'is-renamed', r.to, handlers);
			}
			if (rec.renames.length > 30) container.createDiv({ cls: 'life-home-muted', text: `…还有 ${rec.renames.length - 30} 条` });
		}
		const kinds: [string, string[], string][] = [
			['新增', rec.added, 'is-added'],
			['修改', rec.modified, 'is-modified'],
			['删除', rec.deleted, 'is-deleted'],
		];
		for (const [label, list, cls] of kinds) {
			if (list.length === 0) continue;
			container.createDiv({ cls: 'life-home-rec-kind-title', text: `${label}(${list.length})` });
			for (const p of list.slice(0, 30)) {
				if (label === '修改') {
					// 修改条目(2026-11-21 用户,基线=上次 git 提交):点击 = 打开
					// 文件并画修改装点(行号右侧绿/蓝标志);「对比」小钮 = 直接看
					// 对比并可撤回到上次提交。
					const modHandlers: VaultLogUiHandlers = {
						...handlers,
						onOpenFile: (pp) =>
							handlers.onOpenModified
								? handlers.onOpenModified(pp)
								: handlers.onOpenFile?.(pp),
					};
					const item = renderDiffItem(container, p, cls, p, modHandlers, handlers.onCompareFile ? () => handlers.onCompareFile?.(p) : undefined);
					void item;
				} else {
					renderDiffItem(container, p, cls, p, handlers);
				}
			}
			if (list.length > 30) container.createDiv({ cls: 'life-home-muted', text: `…还有 ${list.length - 30} 条` });
		}
		return;
	}
	// 目录树视图:逐级展开折叠,叶子可点击打开
	const tree = buildPathTree(rec);
	renderPathTree(container, tree, rec.id, state, handlers, 0, { n: 200 });
}

/** 库记录设置节(开关/每日时间/周期/记录后提醒/每日提醒时间)。 */
export function renderVaultLogSettingsInto(
	container: HTMLElement,
	vl: VaultLogSettings,
	onChange: () => void,
): void {
	// 修改对比基线(2026-11-21 用户改成设置项):编辑器修改装点/对比视图与
	// 「撤回」的对比基准。
	new Setting(container)
		.setName('修改对比基线')
		.setDesc(
			'编辑器里修改装点/对比视图与「撤回」的对比基准。' +
				'上次 git 提交 = 需要 Git 模块(推荐,数据在 git 里持久);' +
				'上次库记录时点 = 与最近一次库记录时的内容比(内存快照,重启后不可用)。',
		)
		.addDropdown((d) => {
			d.addOption('git', '上次 git 提交(HEAD)');
			d.addOption('record', '上次库记录时点');
			d.setValue(vl.diffBaseline === 'record' ? 'record' : 'git');
			d.onChange(async (v) => {
				vl.diffBaseline = v === 'record' ? 'record' : 'git';
				onChange?.();
			});
		});
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
