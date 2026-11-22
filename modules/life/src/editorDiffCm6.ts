/**
 * 原生编辑器的库记录修改装点(2026-11-21 用户:VSCode 那样——行号右侧文本
 * 左侧的绿(新增)/蓝(修改)行首竖条;2026-11-22 用户:点击竖条弹出 VSCode 式
 * 对比覆盖层(红删/绿增/双行号),头部可撤回/关闭)。
 *
 * 数据源 = LifePlugin 的编辑器对比登记表(库内相对路径 → { diff, open })。
 * 库记录点击修改文件时登记(open=true,覆盖层自动展开);点击竖条开/收;
 * 撤回走 LifePlugin.revertRecordFile(按基线设置)。文件路径经 editorInfoField
 * 读取(块编辑器的 CM state 不带 file → 装点只在原生编辑器生效)。
 */
import { Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import { buildDiffOverlayDom } from '../../virtual-tree/src/features/diffOverlayDom';
import type { LineDiff } from './vaultLog';

export interface VaultDiffEntry {
	diff: LineDiff;
	/** 覆盖层展开与否(登记时 true;点击竖条切换)。 */
	open: boolean;
}

const registry = new Map<string, VaultDiffEntry>();

export function setVaultDiffEntry(path: string, entry: VaultDiffEntry | null): void {
	if (entry === null) registry.delete(path);
	else registry.set(path, entry);
}

export function getVaultDiffEntry(path: string): VaultDiffEntry | null {
	return registry.get(path) ?? null;
}

const setVaultDiffEffect = StateEffect.define<VaultDiffEntry | null>();

const vaultDiffField = StateField.define<VaultDiffEntry | null>({
	create: () => null,
	update(value, tr) {
		let next = value;
		for (const e of tr.effects) if (e.is(setVaultDiffEffect)) next = e.value;
		return next;
	},
});

const addMark = Decoration.line({ class: 'lgp-vault-diff-add' });
const modMark = Decoration.line({ class: 'lgp-vault-diff-mod' });

/** 覆盖层块 widget(行高 = 行数×18 + 头部 34)。 */
class DiffOverlayWidget extends WidgetType {
	constructor(
		private readonly path: string,
		private readonly entry: VaultDiffEntry,
		private readonly onRevert: (path: string) => void,
	) {
		super();
	}

	eq(other: DiffOverlayWidget): boolean {
		return other.entry === this.entry && other.path === this.path;
	}

	get height(): number {
		return this.entry.diff.rows.length * 18 + 34;
	}

	toDOM(): HTMLElement {
		return buildDiffOverlayDom({
			title: this.path,
			rows: this.entry.diff.rows.map((r) => ({ bl: r.beforeLine, al: r.afterLine, k: r.kind, t: r.text })),
			onRevert: () => this.onRevert(this.path),
			onClose: () => {
				// 收起 = 派发 open:false(与点击竖条同一通路)。
				this.entry.open = false;
			},
		});
	}

	ignoreEvent(): boolean {
		// 覆盖层内部按钮要能点(widget DOM 自管事件);CM 的 mousedown 处理器
		// 仍会收到冒泡,但按 target 类名过滤不会误触发行切换。
		return true;
	}
}

function buildDeco(entry: VaultDiffEntry | null, onRevert: (path: string) => void): DecorationSet {
	if (!entry) return Decoration.none;
	const firstDiff = Math.min(
		...(entry.diff.added.length ? entry.diff.added : [Infinity]),
		...(entry.diff.modified.length ? entry.diff.modified : [Infinity]),
	);
	const ranges: Array<{ deco: Decoration; pos: number }> = [];
	for (const l of entry.diff.added) ranges.push({ deco: addMark, pos: Math.max(0, l - 1) });
	for (const l of entry.diff.modified) ranges.push({ deco: modMark, pos: Math.max(0, l - 1) });
	if (entry.open) {
		ranges.push({
			deco: Decoration.widget({
				widget: new DiffOverlayWidget(fileOfKey(entry), entry, onRevert),
				block: true,
				side: 1,
			}),
			pos: Math.max(0, firstDiff - 1),
		});
	}
	ranges.sort((x, y) => x.pos - y.pos);
	return Decoration.set(ranges.map((r) => r.deco.range(r.pos)), true);
}

function fileOfKey(entry: VaultDiffEntry): string {
	// registry 反查路径(条目与路径一对一)
	for (const [p, e] of registry) if (e === entry) return p;
	return '';
}

/** 分发到打开中的同文件编辑器(库记录登记对比后调用)。 */
export function dispatchVaultDiffToCm(
	app: { workspace: { iterateAllLeaves(cb: (leaf: unknown) => void): void } },
	path: string,
): void {
	const entry = getVaultDiffEntry(path);
	app.workspace.iterateAllLeaves((leaf) => {
		const cm = (leaf as { view?: { editor?: { cm?: EditorView } } }).view?.editor?.cm;
		if (!cm) return;
		const file = cm.state.field(editorInfoField, false)?.file?.path ?? null;
		if (file !== path) return;
		cm.dispatch({ effects: setVaultDiffEffect.of(entry) });
	});
}

function fileOf(view: EditorView): string {
	return view.state.field(editorInfoField, false)?.file?.path ?? '';
}

export function vaultDiffExtension(onRevert: (path: string) => void): Extension {
	return [
		vaultDiffField,
		ViewPlugin.fromClass(
			class {
				decorations: DecorationSet = Decoration.none;
				constructor(private view: EditorView) {
					this.decorations = this.compute();
				}
				update(u: ViewUpdate) {
					const fileBefore = u.startState.field(editorInfoField, false)?.file?.path ?? null;
					const fileAfter = u.state.field(editorInfoField, false)?.file?.path ?? null;
					if (
						u.docChanged ||
						fileBefore !== fileAfter ||
						u.startState.field(vaultDiffField) !== u.state.field(vaultDiffField)
					) {
						this.decorations = this.compute();
					}
				}
				private compute(): DecorationSet {
					const file = fileOf(this.view);
					if (!file) return Decoration.none;
					return buildDeco(getVaultDiffEntry(file), onRevert);
				}
			},
			{ decorations: (v) => v.decorations },
		),
		EditorView.domEventHandlers({
			mousedown(ev, view) {
				const entry = view.state.field(vaultDiffField, false);
				if (!entry) return false;
				const el = ev.target as HTMLElement | null;
				const isBar =
					!!el?.classList?.contains('lgp-vault-diff-add') || !!el?.classList?.contains('lgp-vault-diff-mod');
				if (!isBar) return false;
				const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
				if (pos === null) return false;
				const line = view.state.doc.lineAt(pos).number;
				const near =
					entry.diff.added.includes(line) ||
					entry.diff.modified.includes(line) ||
					entry.diff.added.includes(line + 1) ||
					entry.diff.modified.includes(line + 1);
				if (!near) return false;
				view.dispatch({ effects: setVaultDiffEffect.of({ ...entry, open: !entry.open }) });
				ev.preventDefault();
				return true;
			},
		}),
	];
}
