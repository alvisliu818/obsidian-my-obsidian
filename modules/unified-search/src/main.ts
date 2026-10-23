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
import { fileToMeta, isAttachment, isIndexable } from "./indexer";
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
	/** 本次扫描实际写入的文件数（日志用；0 = stat 门下全程免读免写） */
	private scanWritten = 0;

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
		// delete/rename 一律进 dirty 去抖（flush 时按磁盘真相收敛）：外部 CRUD
		// （网盘同步）会风暴式触发，同步 removeFile 每事件一个 SQLite 事务会卡死主线程
		this.registerEvent(this.app.vault.on("delete", (f) => {
			this.dirty.add(f.path);
			this.armFlush();
		}));
		this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
			this.dirty.add(oldPath);
			this.queueReindex(f);
		}));

		// 首建让路启动（设计 §7）：等布局就绪 + 10s 空闲再扫全库。vault 在网盘上时
		// 启动期 Obsidian 自身要过 metadata cache，扫描立刻开跑会抢满磁盘队列，
		// 表现为「一直加载中」。延迟期间搜索照常可用（查的是库内已有数据）。
		this.registerEvent(this.app.workspace.on("layout-change", this.onLayoutSettle, this));
		this.app.workspace.onLayoutReady(() => {
			this.scanArmedAt = Date.now();
			this.scanTimer = window.setTimeout(() => {
				this.scanTimer = null;
				void this.initialScan();
			}, 10_000);
		});
	}

	private scanTimer: number | null = null;
	/** 本次启动首次布防时间：layout-change 顺延有 60s 硬上限，防持续变动下永不扫描 */
	private scanArmedAt = 0;

	private onLayoutSettle(): void {
		// 布局仍频繁变动（启动中/切工作区）→ 顺延空闲计时，真正安定后才扫；
		// 但距首次布防超 60s 就不再顺延（stat 门下扫描很轻，晚扫不如扫）
		if (this.scanTimer === null) return;
		if (Date.now() - this.scanArmedAt > 60_000) return;
		window.clearTimeout(this.scanTimer);
		this.scanTimer = window.setTimeout(() => {
			this.scanTimer = null;
			void this.initialScan();
		}, 10_000);
	}

	onunload(): void {
		this.unloaded = true;
		if (this.dirtyTimer !== null) window.clearTimeout(this.dirtyTimer);
		if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
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
		if (!(f instanceof TFile) || (!isIndexable(f) && !isAttachment(f))) return;
		this.dirty.add(f.path);
		this.armFlush();
	}

	/** 2.5s 去抖：窗口内事件合并，flush 一次按磁盘真相收敛。flushing 防两轮并发交错 */
	private flushing = false;
	private flushQueued = false;

	private armFlush(): void {
		if (this.flushing) {
			this.flushQueued = true;
			return;
		}
		if (this.dirtyTimer !== null) return;
		this.dirtyTimer = window.setTimeout(() => {
			this.dirtyTimer = null;
			void this.flushDirty();
		}, 2500);
	}

	private async flushDirty(): Promise<void> {
		if (this.flushing) return;
		this.flushing = true;
		try {
			do {
				this.flushQueued = false;
				const paths = [...this.dirty];
				this.dirty.clear();
				await this.reindexPaths(paths);
			} while (this.flushQueued && !this.unloaded);
		} finally {
			this.flushing = false;
		}
		if (this.dirty.size) this.armFlush();
	}

	/**
	 * 去抖 flush：对 dirty 快照逐个收敛到磁盘真相（设计 §4.1 权威=磁盘）——
	 * 可索引文件 upsert（stat 门免读未变）、附件 upsertAttachment（自带 size 门）、
	 * 其余（已删除/文件夹/不可索引）removeFile 清理旧行（无旧行时空转，幂等）。
	 * 时间预算让出：外部同步几千文件时，同步事务每 ≤24ms 让 8ms——单块不卡帧，
	 * UI/输入始终可响应，整体只是慢（可让路给 Obsidian 自身的 metadata cache）。
	 */
	private async reindexPaths(paths: string[]): Promise<void> {
		if (this.unloaded || !paths.length) return;
		try {
			const writer = this.getWriter();
			let lastYield = performance.now();
			for (const p of paths) {
				if (this.unloaded) return;
				const file = this.app.vault.getAbstractFileByPath(p);
				if (file instanceof TFile && isIndexable(file)) {
					const meta = fileToMeta(file);
					if (!writer.statUnchanged(meta.path, meta.mtime, meta.size)) {
						const raw = await this.app.vault.cachedRead(file);
						if (this.unloaded) return;
						writer.upsertFile(meta, raw);
					}
				} else if (file instanceof TFile && isAttachment(file)) {
					writer.upsertAttachment(fileToMeta(file));
				} else {
					writer.removeFile(p);
				}
				if (performance.now() - lastYield >= 24) {
					await new Promise((resolve) => window.setTimeout(resolve, 8));
					lastYield = performance.now();
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
			const files: TFile[] = [];
			const attachments: TFile[] = [];
			for (const f of this.app.vault.getFiles()) {
				if (isIndexable(f)) files.push(f);
				else if (isAttachment(f)) attachments.push(f);
			}
			console.debug(`[unified-search] 全量索引 ${files.length} 个文件 + ${attachments.length} 个附件…`);
			const svc = this.getService();
			// v2 升级一次性补齐存量 items 的 links/names（幂等；hash 门跳过的老文件靠它）
			this.getWriter().backfillLinks();
			// 疾速档只服务真首建（空库）。增量扫描走常规 WAL：否则每次启动都对
			// 1GB 库跑 ANALYZE（全索引扫描+统计写回）——启动期磁盘风暴的写侧元凶。
			const fileCount = (svc.prepare("SELECT count(*) AS c FROM files").get() as { c: number }).c;
			const firstBuild = fileCount === 0;
			if (firstBuild) svc.beginBulk();
			this.scanWritten = 0;
			await this.reindexFiles(files);
			await this.reindexAttachments(attachments);
			await this.reindexExtFiles();
			if (firstBuild) {
				svc.commitBulk();
			}
			console.debug(
				`[unified-search] 扫描完成：写入 ${this.scanWritten}，${Date.now() - t0}ms` +
					(firstBuild ? "（首建疾速档）" : "（增量，stat 门免读未变文件）"),
			);
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
					const norm = entry.abs.replace(/\\/g, "/");
					// stat 门：mtime 未变免读（ext 清单只有 mtime，没有 size）
					if (this.getWriter().statUnchanged(norm, entry.mtime)) return;
					const read = readExternalText(entry.abs);
					if (!read) return;
					const done = this.getWriter().upsertFile(
						{
							path: norm,
							domain: "ext",
							mtime: read.mtime || entry.mtime,
							size: read.size,
							ext: (entry.name.split(".").pop() ?? "").toLowerCase(),
							title: entry.name.replace(/\.\w+$/, ""),
						},
						read.content,
					);
					if (!done.skipped) this.scanWritten++;
					indexed++;
				}),
			);
			await new Promise((resolve) => window.setTimeout(resolve, 0));
		}
		console.debug(`[unified-search] ext 域完成：${indexed}/${list.length}`);
	}

	/** 灌库：300/批流式（读一批→索引一批→让出主线程一拍）。stat 门免读未变文件 */
	private async reindexFiles(files: TFile[]): Promise<void> {
		const CHUNK = 300;
		for (let i = 0; i < files.length; i += CHUNK) {
			if (this.unloaded) return;
			const slice = files.slice(i, i + CHUNK);
			await Promise.all(
				slice.map(async (file) => {
					const meta = fileToMeta(file);
					// stat 门（size→mtime 先于 hash，设计 §4.3）：未变文件不读盘。
					// cachedRead 首读必然落磁盘（网盘 1.2 万文件），这是启动读风暴主力。
					if (this.getWriter().statUnchanged(meta.path, meta.mtime, meta.size)) return;
					const raw = await this.app.vault.cachedRead(file);
					const done = this.getWriter().upsertFile(meta, raw);
					if (!done.skipped) this.scanWritten++;
				}),
			);
			await new Promise((resolve) => window.setTimeout(resolve, 0));
		}
	}

	/**
	 * 附件灌库（M2-1）：不读内容，纯元数据行。upsertAttachment 自带 size 门，
	 * stat 未变的附件连事务都不开（只有一次 SELECT）。时间预算让出同 reindexPaths。
	 */
	private async reindexAttachments(files: TFile[]): Promise<void> {
		let lastYield = performance.now();
		for (const file of files) {
			if (this.unloaded) return;
			const done = this.getWriter().upsertAttachment(fileToMeta(file));
			if (!done.skipped) this.scanWritten++;
			if (performance.now() - lastYield >= 24) {
				await new Promise((resolve) => window.setTimeout(resolve, 8));
				lastYield = performance.now();
			}
		}
	}
}

export default UnifiedSearchPlugin;
export type { UnifiedSearchSettings } from "./settings";
export { DEFAULT_SETTINGS } from "./settings";
