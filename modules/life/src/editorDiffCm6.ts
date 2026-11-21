/**
 * 原生编辑器的库记录修改装点(2026-11-21 用户):VSCode 式行标记——新增绿/
 * 修改蓝,一条竖条画在行号右侧、文本左侧;点击标记打开对比弹窗(撤回入口)。
 *
 * 装点数据源 = LifePlugin 的编辑器对比登记表(库记录点击修改文件时登记,
 * 以库内相对路径为键)。扩展经 registerEditorExtension 全量注册,对原生
 * markdown 编辑器的 CM 实例生效;文件路径经 editorInfoField 读取。
 * 库记录登记后由 LifePlugin.dispatchVaultDiffToEditors 分发到打开中的同
 * 文件编辑器(setVaultDiffEffect);新开的编辑器在构造/文档变化时读登记表。
 */
import { Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import type { LineDiff } from './vaultLog';

export interface VaultDiffEntry {
	recordId: string;
	diff: LineDiff;
}

const registry = new Map<string, VaultDiffEntry>();

export function setVaultDiffEntry(path: string, entry: VaultDiffEntry): void {
	registry.set(path, entry);
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

function buildDeco(entry: VaultDiffEntry | null): DecorationSet {
	if (!entry) return Decoration.none;
	const ranges: Array<{ deco: Decoration; line: number }> = [];
	for (const l of entry.diff.added) ranges.push({ deco: addMark, line: l });
	for (const l of entry.diff.modified) ranges.push({ deco: modMark, line: l });
	ranges.sort((x, y) => x.line - y.line);
	return Decoration.set(
		ranges.map((r) => r.deco.range(Math.max(0, r.line - 1))),
		true,
	);
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

export function vaultDiffExtension(onOpenCompare: (path: string, recordId: string) => void): Extension {
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
					return buildDeco(getVaultDiffEntry(file));
				}
			},
			{ decorations: (v) => v.decorations },
		),
		EditorView.domEventHandlers({
			mousedown(ev, view) {
				const entry = view.state.field(vaultDiffField, false);
				if (!entry) return false;
				const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
				if (pos === null) return false;
				const line = view.state.doc.lineAt(pos).number;
				const inDiff = entry.diff.added.includes(line) || entry.diff.modified.includes(line);
				if (!inDiff) return false;
				const file = fileOf(view);
				if (!file) return false;
				onOpenCompare(file, entry.recordId);
				return true;
			},
		}),
	];
}
