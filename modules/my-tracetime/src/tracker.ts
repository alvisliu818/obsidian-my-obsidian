import { App, MarkdownView, TFile } from "obsidian";
import type { ChangeSet, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { makeBlockId, parseBlocks } from "./blocks";
import { BlockIndex, BlockTimes, reconcileBlocks, seedHistory } from "./blockIndex";
import { applyEditToIndex } from "./editApply";
import { blocksToRecord, recordToBlocks } from "./record";
import { Storage } from "./storage";
import { nowMinutes } from "./format";
import { tracetimeRefreshEffect } from "./editorExtension";

const FLUSH_DELAY_MS = 2000; // 停止输入 2 秒后落盘

export interface FileState {
	path: string;
	index: BlockIndex;
	text: string; // 最近已知的完整文本（阅读模式定位用）
	latestDoc: Text | null; // 最近一次编辑后的 CM 文档（不可变结构，引用代价低）
	lineStarts: number[] | null; // 惰性缓存
	/** 会话级历史栈（内存态，定容 + 时间窗），撤销/重做时恢复块的历史时间 */
	history: Map<bigint, BlockTimes>;
	editCounter: number; // 已处理的内部 transaction 数
	handledModifyCounter: number; // 上次 modify 事件时已见的 counter
	dirty: boolean;
}

export class Tracker {
	private states = new Map<string, FileState>();
	private storage: Storage;
	private flushTimer: number | null = null;

	constructor(private app: App, pluginDir: string) {
		this.storage = new Storage(app, pluginDir);
	}

	async init(): Promise<void> {
		await this.storage.ensureDir();
	}

	getState(path: string): FileState | undefined {
		return this.states.get(path);
	}

	/** 打开文件：解析全文建立索引，并用持久化记录回迁时间戳。 */
	async openFile(file: TFile): Promise<void> {
		if (this.states.has(file.path)) return;
		const text = await this.app.vault.cachedRead(file);
		const initialMin = Math.floor(file.stat.mtime / 60000);
		let blocks = parseBlocks(text, 0, initialMin, makeBlockId);

		const history: FileState["history"] = new Map();
		const record = await this.storage.load(file.path);
		if (record) {
			const recordBlocks = recordToBlocks(record);
			blocks = reconcileBlocks(recordBlocks, blocks, nowMinutes()).blocks;
			// 记录里的历史内容也进记忆：撤销回“关闭前的状态”同样能恢复时间
			seedHistory(history, recordBlocks);
		}
		seedHistory(history, blocks);

		const st: FileState = {
			path: file.path,
			index: new BlockIndex(blocks),
			text,
			latestDoc: null,
			lineStarts: null,
			history,
			editCounter: 0,
			handledModifyCounter: 0,
			dirty: false,
		};
		this.states.set(file.path, st);
		if (!record) this.markDirty(st); // 首次索引，建立初始记录
		this.refreshViews();
	}

	ensureFile(path: string): void {
		if (this.states.has(path)) return;
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile && f.extension === "md") {
			void this.openFile(f);
		}
	}

	/**
	 * 文件关闭即清理：丢弃不再打开的文件的全部内存状态
	 * （索引 / 历史栈 / 文本快照），与编辑器撤销栈的生命周期对齐。
	 * 重新打开时从持久化记录重建。清理前先把脏数据落盘。
	 */
	retainOnly(openPaths: Set<string>): void {
		void this.flushDirty(); // 先把所有脏状态落盘，再丢弃关闭文件的状态
		for (const path of [...this.states.keys()]) {
			if (!openPaths.has(path)) this.states.delete(path);
		}
	}

	/**
	 * 编辑器内增量更新入口（每次按键走这里）：纯计算在 editApply.ts。
	 * editCounter 在成功之后才自增——若中途抛异常，modify 事件会走
	 * 全文恢复兜底，而不是把损坏的索引当成“已处理的内部编辑”。
	 */
	applyEdit(path: string, startDoc: Text, doc: Text, changes: ChangeSet): void {
		const st = this.states.get(path);
		if (!st) {
			this.ensureFile(path);
			return;
		}
		const changed = applyEditToIndex(st, startDoc, doc, changes, nowMinutes());
		st.latestDoc = doc;
		st.editCounter++;
		if (changed) this.markDirty(st);
	}

	/**
	 * 内部修改会产生对应的 transaction（editCounter 变化）；
	 * 没有对应 transaction 的 modify 事件视为外部修改，走全文恢复。
	 */
	async onVaultModify(file: TFile): Promise<void> {
		const st = this.states.get(file.path);
		if (st && st.editCounter !== st.handledModifyCounter) {
			st.handledModifyCounter = st.editCounter;
			return;
		}
		await this.reconcileExternal(file);
	}

	/** 外部修改恢复路径：允许 O(n)，前后缀 + 唯一 hash 匹配回迁时间戳。 */
	private async reconcileExternal(file: TFile): Promise<void> {
		const text = await this.app.vault.cachedRead(file);
		const nowMin = nowMinutes();
		const parsed = parseBlocks(text, 0, Math.floor(file.stat.mtime / 60000), makeBlockId);

		const st = this.states.get(file.path);
		if (st) {
			const merged = reconcileBlocks(st.index.blocks, parsed, nowMin, st.history);
			st.index = new BlockIndex(merged.blocks);
			st.text = text;
			st.latestDoc = null;
			st.lineStarts = null;
			seedHistory(st.history, merged.blocks);
			this.markDirty(st);
		} else {
			// 文件未打开但有历史记录：静默更新记录，等打开时生效
			const record = await this.storage.load(file.path);
			if (record) {
				const merged = reconcileBlocks(recordToBlocks(record), parsed, nowMin);
				this.storage.save(file.path, blocksToRecord(file.path, merged.blocks));
			}
		}
		this.refreshViews();
	}

	async onRename(file: TFile, oldPath: string): Promise<void> {
		const st = this.states.get(oldPath);
		if (st) {
			this.states.delete(oldPath);
			st.path = file.path;
			this.states.set(file.path, st);
			this.markDirty(st);
			this.storage.remove(oldPath);
		} else {
			await this.storage.move(oldPath, file.path);
		}
	}

	onDelete(path: string): void {
		this.states.delete(path);
		this.storage.remove(path);
	}

	async reindexFile(file: TFile): Promise<void> {
		this.states.delete(file.path);
		this.storage.remove(file.path);
		await this.openFile(file);
	}

	/**
	 * 用上一代备份记录回滚当前文件的时间戳。
	 * hash 匹配的块恢复备份中的时间；对不上的块（备份之后新增/大改的）记为当前时间。
	 * 回滚本身也是一次写入，会把被回滚掉的版本留成新的备份，可再滚回来。
	 */
	async restoreFromBackup(file: TFile): Promise<boolean> {
		const record = await this.storage.loadBackup(file.path);
		if (!record) return false;

		const text = await this.app.vault.cachedRead(file);
		const nowMin = nowMinutes();
		const parsed = parseBlocks(text, 0, Math.floor(file.stat.mtime / 60000), makeBlockId);
		const recordBlocks = recordToBlocks(record);
		const merged = reconcileBlocks(recordBlocks, parsed, nowMin).blocks;

		let st = this.states.get(file.path);
		if (st) {
			st.index = new BlockIndex(merged);
			st.text = text;
			st.latestDoc = null;
			st.lineStarts = null;
			seedHistory(st.history, recordBlocks);
			seedHistory(st.history, merged);
		} else {
			const history: FileState["history"] = new Map();
			seedHistory(history, recordBlocks);
			seedHistory(history, merged);
			st = {
				path: file.path,
				index: new BlockIndex(merged),
				text,
				latestDoc: null,
				lineStarts: null,
				history,
				editCounter: 0,
				handledModifyCounter: 0,
				dirty: false,
			};
			this.states.set(file.path, st);
		}
		this.markDirty(st);
		this.refreshViews();
		return true;
	}

	/** 阅读模式定位用的行起始偏移表（惰性计算并缓存）。 */
	getLineStarts(st: FileState): number[] | null {
		if (st.lineStarts) return st.lineStarts;
		if (st.latestDoc) {
			const d = st.latestDoc;
			const arr = new Array<number>(d.lines);
			for (let i = 1; i <= d.lines; i++) arr[i - 1] = d.line(i).from;
			st.lineStarts = arr;
			return arr;
		}
		const starts = [0];
		for (let i = 0; i < st.text.length; i++) {
			if (st.text[i] === "\n") starts.push(i + 1);
		}
		st.lineStarts = starts;
		return starts;
	}

	markDirty(st: FileState): void {
		st.dirty = true;
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		this.flushTimer = window.setTimeout(() => void this.flushDirty(), FLUSH_DELAY_MS);
	}

	/** 落盘：只写脏文件，同一文件的连续写入由防抖合并。 */
	flushDirty(): void {
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		for (const st of this.states.values()) {
			if (!st.dirty) continue;
			st.dirty = false;
			if (st.latestDoc) st.text = st.latestDoc.toString();
			st.lineStarts = null;
			// 存活内容重刷 seenAt：只有离开文档的内容才会被 TTL 遗忘
			seedHistory(st.history, st.index.blocks);
			this.storage.save(st.path, blocksToRecord(st.path, st.index.blocks));
		}
	}

	dispose(): void {
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		void this.flushDirty();
	}

	/** 状态变化后刷新所有视图：编辑器标签重绘 + 阅读模式重渲染。 */
	refreshViews(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				const cm = (leaf.view.editor as { cm?: EditorView }).cm;
				cm?.dispatch({ effects: tracetimeRefreshEffect.of(null) });
				leaf.view.previewMode.rerender(true);
			}
		});
	}
}
