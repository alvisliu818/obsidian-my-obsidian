import type { WorkspaceLeaf } from 'obsidian';

/**
 * 给 leaf 立「用户编辑过」的旗标（open-tab-settings 的 touched，读方还包括
 * 本插件的 setViewState dirty 守卫）。
 *
 * open-tab-settings 的 reuseUnmodifiedTab 只认两路信号：touched 旗标
 * （editor-change 事件——只为原生 MarkdownView 触发）和 TextFileView.dirty
 * （只覆盖 TextFileView 系）。本插件的 Monaco/文本域视图（ExternalCodeView /
 * CodeDocView / ExternalFileView）两路都够不着——它们的防抖自动保存一落盘
 * dirty 就复位，tab 失去保护、被新打开的文件复用替换（2026-10-29 用户报：
 * 修改过的标签页能被新打开的文件替换）。BlockEditorView.markDirty 已内联
 * 同款补丁；这里抽成公共函数给 Monaco 系视图用。
 *
 * 语义对齐原生 md：编辑过即保持，落盘不清。
 */
export function markLeafTouched(leaf: WorkspaceLeaf | null): void {
	if (!leaf) return;
	const ex = leaf as unknown as { openTabSettings?: Record<string, unknown> | undefined };
	if (ex.openTabSettings?.touched) return;
	ex.openTabSettings = { ...ex.openTabSettings, touched: true };
}
