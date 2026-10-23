/**
 * my Unified Search — 统一索引搜索（消费 modules/index-core 的 SQLite 本体）。
 *
 * 与 omnisearch（minisearch/IndexedDB/常驻内存）是两条平行路线：本模块走
 * node:sqlite 磁盘库，JS 堆常驻 0，见 docs/unified-index-design.md。
 * M1 范围：库内 md/org 文件，整文件一个 item；ext 域与块级拆分（M2）。
 */
import { Notice, Plugin, TFile, type TAbstractFile } from "obsidian";
import type { FileSystemAdapter } from "obsidian";
import { SqliteService, vaultSlugOf } from "../../index-core/src/sqlite-service";
import { IndexWriter } from "../../index-core/src/index-writer";
import type { TokenizeOptions } from "../../index-core/src/tokenize";
import { readExternalText } from "./extfs";
import { DEFAULT_SETTINGS, type UnifiedSearchSettings } from "./settings";
import { UnifiedSearchSettingTab } from "./settings-tab";
import { fileToMeta, isIndexable } from "./indexer";
import { UnifiedSearchModal } from "./modal";

export class UnifiedSearchPlugin extends Plugin {
	settings: UnifiedSearchSettings = DEFAULT_SETTINGS;

	private svc: SqliteService | null = null;
	private writer: IndexWriter | null = null;
	/** 当前 service 对应的 dbDir（设置变更后下一次使用时重建连接） */
	private svcDir = "";
	private fingerprint = "";
	/** modify 事件去抖：2.5s 内的连击合并成一次重索引 */
	private dirty = new Set<string>();
	private dirtyTimer: number | null = null;
	private scanning = false;
	private unloaded = false;

	async onload(): Promise<void> {
		const raw = (await this.loadData()) as Partial<UnifiedSearchSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...raw };

		this.addSettingTab(new UnifiedSearchSettingTab(this.app, this));
		// id 不能用 "open"：无 manifest.id 覆盖的模块共用宿主命名空间
		// （obsidian-my-obsidian:open 已被 momentum 占用，vault-explorer 的
		// NOTICE.md 有记录）。open-search 避开。
		this.addCommand({
			id: "open-search",
			name: "统一索引搜索",
			callback: () => new UnifiedSearchModal(this).open(),
		});

		this.registerEvent(this.app.vault.on("create", (f) => this.queueReindex(f)));
		this.registerEvent(this.app.vault.on("modify", (f) => this.queueReindex(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => {
			this.writer?.removeFile(f.path);
		}));
		this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
			this.writer?.removeFile(oldPath);
			this.queueReindex(f);
		}));

		// 首建让路启动：等一拍再扫全库（DB 懒打开 + beginBulk 疾速档）
		window.setTimeout(() => void this.initialScan(), 0);
	}

	onunload(): void {
		this.unloaded = true;
		if (this.dirtyTimer !== null) window.clearTimeout(this.dirtyTimer);
		this.svc?.close();
		this.svc = null;
		this.writer = null;
	}

	// ------------------------------------------------------------------

	getTokenizerOpts(): TokenizeOptions {
		return { chsSegmenter: this.getChsSegmenter(), splitCamel: this.settings.splitCamel };
	}

	/** cm-chs-patch 是可选外部插件，缺席即降级（整块 token + LIKE 兜底） */
	getChsSegmenter(): TokenizeOptions["chsSegmenter"] {
		return (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins
			?.plugins?.["cm-chs-patch"] as TokenizeOptions["chsSegmenter"] ?? null;
	}

	/** 懒建/懒换连接：dbDir 变更或分词配置变更（指纹）都在首次使用时生效 */
	getWriter(): IndexWriter {
		const dir = this.settings.sqliteDbDir || DEFAULT_SETTINGS.sqliteDbDir;
		const chs = this.getChsSegmenter() != null;
		const fp = `usc1|chs=${chs ? 1 : 0}|camel=${this.settings.splitCamel ? 1 : 0}`;
		if (!this.writer || this.svcDir !== dir || this.fingerprint !== fp) {
			this.svc?.close();
			this.svc = new SqliteService({
				dbDir: dir,
				vaultSlug: vaultSlugOf(this.vaultBasePath()),
				fingerprint: fp,
				onEvent: (e) => {
					if (e.type === "rebuild") {
						console.warn(`[unified-search] 索引库重建：${e.reason}（${e.path}）`);
					}
				},
			});
			this.writer = new IndexWriter(this.svc, this.getTokenizerOpts());
			this.svcDir = dir;
			this.fingerprint = fp;
		}
		return this.writer;
	}

	getService(): SqliteService {
		this.getWriter();
		return this.svc!;
	}

	/** 全量重建：清库重扫（设置页按钮入口） */
	async rebuild(): Promise<void> {
		this.getWriter().clearAll();
		await this.initialScan();
		new Notice("统一索引已重建");
	}

	// ------------------------------------------------------------------

	private vaultBasePath(): string {
		const adapter = this.app.vault.adapter as Partial<FileSystemAdapter>;
		return adapter.basePath ?? this.app.vault.getName();
	}

	private queueReindex(f: TAbstractFile): void {
		if (!(f instanceof TFile) || !isIndexable(f)) return;
		this.dirty.add(f.path);
		if (this.dirtyTimer !== null) return;
		this.dirtyTimer = window.setTimeout(() => {
			this.dirtyTimer = null;
			const paths = [...this.dirty];
			this.dirty.clear();
			void this.reindexPaths(paths);
		}, 2500);
	}

	private async reindexPaths(paths: string[]): Promise<void> {
		if (this.unloaded) return;
		try {
			const writer = this.getWriter();
			for (const p of paths) {
				const file = this.app.vault.getAbstractFileByPath(p);
				if (file instanceof TFile && isIndexable(file)) {
					const raw = await this.app.vault.cachedRead(file);
					writer.upsertFile(fileToMeta(file), raw);
				}
			}
		} catch (e) {
			console.error("[unified-search] 增量索引失败", e);
		}
	}

	private async initialScan(): Promise<void> {
		if (this.unloaded || this.scanning) return;
		this.scanning = true;
		const t0 = Date.now();
		try {
			const files = this.app.vault.getFiles().filter((f) => isIndexable(f));
			console.debug(`[unified-search] 全量索引 ${files.length} 个文件…`);
			const svc = this.getService();
			// v2 升级一次性补齐存量 items 的 links/names（幂等；hash 门跳过的老文件靠它）
			this.getWriter().backfillLinks();
			svc.beginBulk();
			await this.reindexFiles(files);
			await this.reindexExtFiles();
			svc.commitBulk();
			console.debug(`[unified-search] 全量索引完成，${Date.now() - t0}ms`);
		} catch (e) {
			console.error("[unified-search] 全量索引失败", e);
		} finally {
			this.scanning = false;
		}
	}

	/**
	 * 库外挂载文件（ext 域）：清单元数据来自 logseq 模块的 listExternalSearchFiles
	 * （已剔除 vault 根、应用挂载 include/exclude）。M1 只在全量扫描时刷新
	 * （挂载树无 vault 事件，fs.watch 不做——索引是可重建投影）。
	 */
	private async reindexExtFiles(): Promise<void> {
		if (!this.settings.indexExt || this.unloaded) return;
		type ExtEntry = { abs: string; name: string; mtime: number };
		const logseq = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } })
			.plugins?.plugins?.["obsidian-logseq"] as
			| { listExternalSearchFiles?: () => ExtEntry[] }
			| undefined;
		const list = logseq?.listExternalSearchFiles?.() ?? [];
		if (!list.length) return;
		console.debug(`[unified-search] ext 域 ${list.length} 个文件…`);
		const CHUNK = 200;
		let indexed = 0;
		for (let i = 0; i < list.length; i += CHUNK) {
			if (this.unloaded) return;
			const slice = list.slice(i, i + CHUNK);
			await Promise.all(
				slice.map(async (entry) => {
					const read = readExternalText(entry.abs);
					if (!read) return;
					this.getWriter().upsertFile(
						{
							path: entry.abs.replace(/\\/g, "/"),
							domain: "ext",
							mtime: read.mtime || entry.mtime,
							size: read.size,
							ext: (entry.name.split(".").pop() ?? "").toLowerCase(),
							title: entry.name.replace(/\.\w+$/, ""),
						},
						read.content,
					);
					indexed++;
				}),
			);
			await new Promise((resolve) => window.setTimeout(resolve, 0));
		}
		console.debug(`[unified-search] ext 域完成：${indexed}/${list.length}`);
	}

	/** 灌库：300/批流式（读一批→索引一批→让出主线程一拍） */
	private async reindexFiles(files: TFile[]): Promise<void> {
		const CHUNK = 300;
		for (let i = 0; i < files.length; i += CHUNK) {
			if (this.unloaded) return;
			const slice = files.slice(i, i + CHUNK);
			await Promise.all(
				slice.map(async (file) => {
					const raw = await this.app.vault.cachedRead(file);
					this.getWriter().upsertFile(fileToMeta(file), raw);
				}),
			);
			await new Promise((resolve) => window.setTimeout(resolve, 0));
		}
	}
}

export default UnifiedSearchPlugin;
export type { UnifiedSearchSettings } from "./settings";
export { DEFAULT_SETTINGS } from "./settings";
