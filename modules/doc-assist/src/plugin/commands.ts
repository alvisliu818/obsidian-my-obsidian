/**
 * 场景二 剪藏清洗 — 编辑器命令注册。
 *
 * 对应 siyuan-doc-assist 的剪藏清洗动作组（action-runner + delete-range-handlers），
 * 适配差异：
 * - 思源块选择 -> Obsidian 选区/光标：清洗类命令作用域 = 有选区用选区，否则全文档；
 * - 替换统一走 replaceRange / replaceSelection，保持单个撤销步（Ctrl+Z 可整体回退）；
 * - 删区间命令不依赖确认弹窗服务，用内置 ConfirmModal。
 */

import { App, Editor, Modal, Notice, Setting } from 'obsidian';
import {
	addCjkLatinSpaces,
	cleanupAiOutputArtifacts,
	convertParagraphBreaksToLines,
	convertSingleLineBreaksToParagraphs,
	countSingleLineBreaks,
	removeClippedListPrefixes,
	removeExtraBlankLines,
	removeTrailingWhitespace,
	splitBilingualParagraphsInText,
} from '../core/cleanup-text';
import {
	countByType,
	formatKeyInfo,
	scanKeyInfo,
	SUMMARY_CALLOUT_PREFIX,
	type KeyInfoType,
} from '../core/key-info';
import {
	buildDeleteFromCurrentToEnd,
	buildDeleteFromStartToCurrent,
	type DeleteRangeResult,
} from '../core/delete-range';
import { mergeSelectionIntoList } from '../core/list-merge';
import { toggleChineseEnglishPunctuationOutsideFences } from '../core/punctuation';
import type DocAssistPlugin from '../main';

type TextTransformResult = {
	text: string;
	summary: string;
};

class ConfirmModal extends Modal {
	private message: string;
	private onConfirm: () => void;

	constructor(app: App, message: string, onConfirm: () => void) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.contentEl.createEl('p', { text: this.message });
		new Setting(this.contentEl)
			.addButton((btn) => btn.setButtonText('取消').onClick(() => this.close()))
			.addButton((btn) =>
				btn.setButtonText('确定删除').setWarning().onClick(() => {
					this.close();
					this.onConfirm();
				}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function documentEndPosition(editor: Editor): { line: number; ch: number } {
	const lastLine = editor.lineCount() - 1;
	return { line: lastLine, ch: editor.getLine(lastLine).length };
}

/** 选区（或全文档）文本变换 + 单撤销步替换 + Notice 汇报。 */
function runTextCommand(
	editor: Editor,
	label: string,
	transform: (text: string) => TextTransformResult,
	options: { requireSelection?: boolean } = {},
): void {
	if (editor.listSelections().length > 1) {
		new Notice('Doc Assist：暂不支持多选区，请合并为一个选区后重试');
		return;
	}
	const selection = editor.getSelection();
	const hasSelection = selection.length > 0;
	if (options.requireSelection && !hasSelection) {
		new Notice(`Doc Assist ${label}：请先选中要处理的内容`);
		return;
	}
	const source = hasSelection ? selection : editor.getValue();
	const result = transform(source);
	if (result.text === source) {
		new Notice(`Doc Assist ${label}：没有需要处理的内容`);
		return;
	}
	if (hasSelection) {
		editor.replaceSelection(result.text);
	} else {
		editor.replaceRange(result.text, { line: 0, ch: 0 }, documentEndPosition(editor));
	}
	new Notice(`Doc Assist ${label}：${result.summary}`);
}

// ---------------------------------------------------------------------------
// 场景一 关键信息提炼
//
// 与场景二不同，这里**不原地改写文档**——摘要是额外信息，覆盖原文就丢了内容。
// 统一做法是在文档顶部插入一个 `> [!info]` 摘要区块（frontmatter 之后），
// 走一次 replaceRange，所以 Ctrl+Z 能整体撤回。
// ---------------------------------------------------------------------------

/** 在文档顶部（frontmatter 之后）插入摘要区块，保持单个撤销步。 */
function insertSummaryAtTop(editor: Editor, label: string, body: string): void {
	const text = editor.getValue();
	const lines = text.split('\n');
	let at = 0;
	if (lines[0]?.trim() === '---') {
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === '---') {
				at = i + 1;
				break;
			}
		}
	}
	// callout 的内容行也必须带 `>` 前缀，否则渲染时会在 callout 外面散开
	const quoted = body
		.split('\n')
		.map((l) => `> ${l}`)
		.join('\n');
	const block = `${SUMMARY_CALLOUT_PREFIX}：${label}\n${quoted}\n\n`;
	editor.replaceRange(block, { line: at, ch: 0 }, { line: at, ch: 0 });
}

/** 扫描 + 格式化 + 插入。typeFilter 为空表示全要素。 */
function runKeyInfoCommand(
	editor: Editor,
	label: string,
	typeFilter: KeyInfoType[] | null,
): void {
	const items = scanKeyInfo(editor.getValue());
	const filtered = typeFilter
		? items.filter((it) => it.types.some((t) => typeFilter.includes(t)))
		: items;
	if (!filtered.length) {
		new Notice(`Doc Assist ${label}：没有找到关键内容`);
		return;
	}
	const body = formatKeyInfo(filtered);
	const counts = countByType(filtered);
	insertSummaryAtTop(editor, label, body);
	new Notice(`Doc Assist ${label}：已插入 ${filtered.length} 条（${counts}）`);
}

/** 删区间命令：按行范围删除（单撤销步），删除后光标定位到删除点。 */
function runDeleteRangeCommand(
	plugin: DocAssistPlugin,
	editor: Editor,
	label: string,
	build: (text: string, cursorLine: number) => DeleteRangeResult,
): void {
	const result = build(editor.getValue(), editor.getCursor('head').line);
	if (result.deletedLineCount <= 0) {
		new Notice(`Doc Assist ${label}：没有可删除的内容`);
		return;
	}
	new ConfirmModal(
		plugin.app,
		`${label}将删除 ${result.deletedLineCount} 行（删除后可用 Ctrl+Z 撤销）。确定执行？`,
		() => {
			const lastLine = editor.lineCount() - 1;
			let from;
			let to;
			if (result.deletedToLine >= lastLine) {
				// 删到文档末：from 提前到删除首行上一行的行尾（吞掉其终止换行），
				// 否则 CM 会残留一个由终止换行造成的尾幽灵空行
				from =
					result.deletedFromLine > 0
						? { line: result.deletedFromLine - 1, ch: editor.getLine(result.deletedFromLine - 1).length }
						: { line: 0, ch: 0 };
				to = documentEndPosition(editor);
			} else {
				from = { line: result.deletedFromLine, ch: 0 };
				to = { line: result.deletedToLine + 1, ch: 0 };
			}
			editor.replaceRange('', from, to);
			editor.setCursor(from);
			new Notice(`Doc Assist ${label}：已删除 ${result.deletedLineCount} 行`);
		},
	).open();
}

export function registerDocAssistCommands(plugin: DocAssistPlugin): void {
	const add = plugin.addCommand.bind(plugin);

	// ---- 基础清洗 ----
	add({
		id: 'cleanup-blank-lines',
		name: '清洗：去除多余空行（连续空行合并为一行）',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runTextCommand(
				editor,
				'去除多余空行',
				(text) => {
					const r = removeExtraBlankLines(text);
					return { text: r.text, summary: `移除 ${r.removedLines} 个多余空行` };
				},
			);
		},
	});

	add({
		id: 'cleanup-trailing-whitespace',
		name: '清洗：去除行尾空白',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runTextCommand(
				editor,
				'去除行尾空白',
				(text) => {
					const r = removeTrailingWhitespace(text);
					return { text: r.text, summary: `清理 ${r.changedLines} 行（移除 ${r.removedChars} 字符）` };
				},
			);
		},
	});

	add({
		id: 'cleanup-clipped-list-prefixes',
		name: '清洗：剪藏列表前缀（- • text / 1. 1. text）',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runTextCommand(
				editor,
				'剪藏列表前缀',
				(text) => {
					const r = removeClippedListPrefixes(text);
					return { text: r.text, summary: `移除 ${r.removedCount} 个冗余前缀` };
				},
			);
		},
	});

	add({
		id: 'cleanup-ai-output',
		name: '清洗：AI 报告残留（上标/引用标记/行尾来源链接/隐藏内容/分隔线）',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runTextCommand(
				editor,
				'AI 报告残留',
				(text) => {
					const r = cleanupAiOutputArtifacts(text);
					return { text: r.text, summary: `清理 ${r.removedCount} 处残留` };
				},
			);
		},
	});

	add({
		id: 'add-cjk-latin-spaces',
		name: '清洗：中英文之间加空格（盘古空格）',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runTextCommand(
				editor,
				'中英空格',
				(text) => {
					const r = addCjkLatinSpaces(text);
					return { text: r.text, summary: `补充 ${r.changedCount} 处空格` };
				},
			);
		},
	});

	// ---- 标点互转 ----
	add({
		id: 'toggle-punctuation',
		name: '清洗：中英文标点互转（按内容自动判向）',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runTextCommand(
				editor,
				'标点互转',
				(text) => {
					const r = toggleChineseEnglishPunctuationOutsideFences(text);
					const direction = r.mode === 'en-to-zh' ? '英文→中文' : '中文→英文';
					const skipped = r.fencesSkippedCount > 0 ? `（跳过代码块 ${r.fencesSkippedCount} 行）` : '';
					return { text: r.next, summary: `${direction} ${r.changedCount} 处${skipped}` };
				},
			);
		},
	});

	// ---- 列表 / 段落整理 ----
	add({
		id: 'merge-selection-into-list',
		name: '整理：合并选区为列表（段落行转列表项）',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runTextCommand(
				editor,
				'合并为列表',
				(text) => {
					const r = mergeSelectionIntoList(text);
					return {
						text: r.text,
						summary: `${r.resultItemCount} 项（新增 ${r.convertedParagraphGroups}、规范化 ${r.normalizedListLines}、删 ${r.removedLines} 行）`,
					};
				},
				{ requireSelection: true },
			);
		},
	});

	add({
		id: 'linebreaks-to-paragraphs',
		name: '整理：单换行转段落（选中范围）',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runTextCommand(
				editor,
				'换行转段落',
				(text) => {
					const count = countSingleLineBreaks(text);
					return {
						text: convertSingleLineBreaksToParagraphs(text),
						summary: `转换 ${count} 处换行为段落`,
					};
				},
				{ requireSelection: true },
			);
		},
	});

	add({
		id: 'paragraphs-to-linebreaks',
		name: '整理：段落转单换行（选中范围）',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runTextCommand(
				editor,
				'段落转换行',
				(text) => {
					const count = (text.replace(/\r\n/g, '\n').match(/\n{2,}/g) || []).length;
					return {
						text: convertParagraphBreaksToLines(text),
						summary: `合并 ${count} 处段落为换行`,
					};
				},
				{ requireSelection: true },
			);
		},
	});

	add({
		id: 'split-bilingual-paragraphs',
		name: '整理：中英双语段落拆分（一段拆两段）',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runTextCommand(
				editor,
				'双语拆分',
				(text) => {
					const r = splitBilingualParagraphsInText(text);
					return { text: r.text, summary: `拆分 ${r.splitCount} 个双语段落` };
				},
			);
		},
	});

	// ---- 删区间（带确认） ----
	add({
		id: 'delete-from-current-to-end',
		name: '删区间：断尾求真（从当前段落删到文末）',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runDeleteRangeCommand(plugin, editor, '断尾求真', buildDeleteFromCurrentToEnd);
		},
	});

	add({
		id: 'delete-from-start-to-current',
		name: '删区间：删前段（文首到当前段落，自动保护开篇分隔线前内容）',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runDeleteRangeCommand(plugin, editor, '删前段', buildDeleteFromStartToCurrent);
		},
	});

	// ---- 场景一 关键信息提炼（摘要插入文档顶部，不改写原文） ----
	add({
		id: 'key-info-summary',
		name: '关键内容：全要素摘要（标题/加粗/高亮/斜体/代码/标签/双链）',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runKeyInfoCommand(editor, '全要素摘要', null);
		},
	});

	add({
		id: 'key-info-outline',
		name: '关键内容：标题大纲',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runKeyInfoCommand(editor, '标题大纲', ['heading']);
		},
	});

	add({
		id: 'key-info-emphasis',
		name: '关键内容：重点句（加粗 / 高亮 / 斜体）',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runKeyInfoCommand(editor, '重点句', ['bold', 'highlight', 'italic']);
		},
	});

	add({
		id: 'key-info-keypoints',
		name: '关键内容：核心要点（加粗 / 高亮 / 代码块 / 引述块）',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runKeyInfoCommand(editor, '核心要点', ['bold', 'highlight', 'codeBlock', 'blockquote']);
		},
	});

	add({
		id: 'key-info-code',
		name: '关键内容：代码块清单',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runKeyInfoCommand(editor, '代码块清单', ['codeBlock', 'inlineCode']);
		},
	});

	add({
		id: 'key-info-links',
		name: '关键内容：标签与双链清单',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runKeyInfoCommand(editor, '标签与双链', ['tag', 'link']);
		},
	});

	add({
		id: 'key-info-quote',
		name: '关键内容：引述块清单',
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			runKeyInfoCommand(editor, '引述块', ['blockquote']);
		},
	});
}
