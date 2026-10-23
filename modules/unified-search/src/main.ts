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
		this.addCommand({
			id: "refresh-ext",
			name: "刷新挂载文件索引（ext 域）",
			callback: () => {
				void this.withWriteLock(() => this.reindexExtFiles(true));
				new Notice("挂载文件索引刷新中");
			},
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
		// ext 域周期刷新（M2-3）：挂载树无 vault 事件，用周期重扫替代 fs.watch。
		// stat 门下未变文件免读，一轮开销只是清单 stat + 变文件重索引
		this.rearmExtRefresh();
	}

	private extTimer: number | null = null;

	/** ext 域刷新布防（设置变更时重排；间隔 0 或 ext 关 = 不布防） */
	rearmExtRefresh(): void {
		if (this.extTimer !== null) window.clearInterval(this.extTimer);
		this.extTimer = null;
		const minutes = this.settings.indexExt ? this.settings.extRefreshMinutes : 0;
		if (!minutes) return;
		this.extTimer = window.setInterval(() => {
			if (this.scanning || this.flushing || this.unloaded) return; // 首建扫描/flush 进行中让路
			void this.withWriteLock(() => this.reindexExtFiles());
		}, minutes * 60_000);
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
		if (this.extTimer !== null) window.clearInterval(this.extTimer);
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
		// usc2：降级分词从「CJK 整块」改为内置 bigram（M2-5），指纹升级触发旧库重建
		const fp = `usc2|chs=${chs ? 1 : 0}|camel=${this.settings.splitCamel ? 1 : 0}`;
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
		await this.withWriteLock(async () => {
			this.getWriter().clearAll();
			await this.runInitialScan();
			new Notice("统一索引已重建");
		});
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

	/** 写会话进行中（首建扫描/flush）：部分数据必然 FTS 落空，此时 LIKE 兜底
	 *  只会白扫大库卡死主线程（M2-5）——搜索侧据此临时关闭兜底 */
	get isWriteSession(): boolean {
		return this.scanning || this.flushing;
	}

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

	/**
	 * 写会话互斥：flush / 全量扫描 / ext 刷新串行化。批量事务跨 yield 持有，
	 * 两个写会话交错会让 begin/endBatch 深度计数互相踩（一方归零 COMMIT 时
	 * 另一方还以为在批内）。读路径不受影响——搜索走同一连接，WAL 快照语义。
	 */
	private writeLock: Promise<unknown> = Promise.resolve();

	private withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.writeLock.then(fn, fn);
		this.writeLock = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async flushDirty(): Promise<void> {
		if (this.flushing) return;
		this.flushing = true;
		try {
			await this.withWriteLock(async () => {
				do {
					this.flushQueued = false;
					const paths = [...this.dirty];
					this.dirty.clear();
					await this.reindexPaths(paths);
				} while (this.flushQueued && !this.unloaded);
			});
		} finally {
			this.flushing = false;
		}
		if (this.dirty.size) this.armFlush();
	}

	/**
	 * 去抖 flush：对 dirty 快照逐个收敛到磁盘真相（设计 §4.1 权威=磁盘）——
	 * 可索引文件 upsert（stat 门免读未变）、附件 upsertAttachment（自带 size 门）、
	 * 其余（已删除/文件夹/不可索引）removeFile 清理旧行（无旧行时空转，幂等）。
	 * 时间预算让出：外部同步几千文件时让出主线程，UI/输入始终可响应。
	 * 批量事务：64 项或 300ms 才 COMMIT 一轮。逐文件事务时 WAL 自动检查点随机
	 * 落进某次 COMMIT（1GB 库+网盘目录上是不可让出的长阻塞，新增文件卡死元凶），
	 * 批量化把检查点频率降到 1/N，也让单个 COMMIT 的 WAL 写量按批摊薄。
	 */
	private async reindexPaths(paths: string[]): Promise<void> {
		if (this.unloaded || !paths.length) return;
		const svc = this.getService();
		const writer = this.getWriter();
		const t0 = performance.now();
		let lastYield = t0;
		let batchAt = t0;
		let batchCount = 0;
		let written = 0;
		let slowest = 0;
		let slowPath = "";
		let failed = false;
		try {
			svc.beginBatch();
			for (const p of paths) {
				if (this.unloaded) return;
				const unitT0 = performance.now();
				const file = this.app.vault.getAbstractFileByPath(p);
				if (file instanceof TFile && isIndexable(file)) {
					const meta = fileToMeta(file);
					if (!writer.statUnchanged(meta.path, meta.mtime, meta.size)) {
						const raw = await this.app.vault.cachedRead(file);
						if (this.unloaded) return;
						writer.upsertFile(meta, raw);
						written++;
					}
				} else if (file instanceof TFile && isAttachment(file)) {
					writer.upsertAttachment(fileToMeta(file));
					written++;
				} else {
					writer.removeFile(p);
					written++;
				}
				batchCount++;
				const unitMs = performance.now() - unitT0;
				if (unitMs > slowest) {
					slowest = unitMs;
					slowPath = p;
				}
				const now = performance.now();
				if (now - lastYield >= 24) {
					if (batchCount >= 64 || now - batchAt >= 300) {
						svc.endBatch();
						svc.beginBatch();
						batchAt = performance.now();
						batchCount = 0;
					}
					await new Promise((resolve) => window.setTimeout(resolve, 8));
					lastYield = performance.now();
				}
			}
		} catch (e) {
			failed = true;
			console.error("[unified-search] 增量索引失败", e);
		} finally {
			if (svc.inBatch) {
				try {
					svc.endBatch(failed);
				} catch (e) {
					console.error("[unified-search] flush 事务收尾失败", e);
				}
			}
		}
		if (failed) {
			// 整批已回滚：路径回灌 dirty，等下轮按磁盘真相重收敛（stat 门免重复读）
			for (const p of paths) this.dirty.add(p);
		}
		console.debug(
			`[unified-search] flush ${paths.length} 项：落库 ${written}，${Math.round(performance.now() - t0)}ms` +
				(slowest > 100 ? `，最慢单项 ${Math.round(slowest)}ms（${slowPath}）` : ""),
		);
	}

	/** 全量扫描（写锁串行化入口：与 flush / ext 刷新互斥） */
	private async initialScan(): Promise<void> {
		await this.withWriteLock(() => this.runInitialScan());
	}

	private async runInitialScan(): Promise<void> {
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
			// 重建判定（含续建）：vault 域已建可索引数 < 待索引数 = 重建未完。续建也走
			// 疾速档——WAL 档下续建实测比 MEMORY journal 慢 20 倍（2026-10-23 实证）。
			// 重建可弃（崩溃大不了重扫），疾速档的代价为零。ext 域行不计（排除干扰）。
			const builtCount = (
				svc
					.prepare(
						`SELECT count(*) AS c FROM files
					 WHERE domain='vault' AND ext IN ('md','org') AND path IN (SELECT path FROM sync_state)`,
					)
					.get() as { c: number }
			).c;
			const rebuilding = builtCount < files.length;
			if (rebuilding) {
				svc.beginBulk();
				svc.metaSet("analyze_pending", "1");
			}
			this.scanWritten = 0;
			// 块级回填只服务「存量库升级」（M2-2 之前的库）：重建路径的 upsertFile
			// 本来就产块 item，回填是全量重解析白烧 CPU——重建中跳过，完成时补门。
			if (!rebuilding) {
				await this.getWriter().backfillBlocks();
			}
			await this.reindexFiles(files);
			await this.reindexAttachments(attachments);
			await this.reindexExtFiles(true);
			if (rebuilding) {
				svc.commitBulk();
				// 重建库自带块级 item，回填门直接置位（防下次启动全量重解析）
				svc.metaSet("blocks_m2", "1");
				svc.metaSet("analyze_pending", "0");
			}
			// 存量升级路径的补 ANALYZE（analysis_limit 让大库秒级）
			if (!rebuilding && svc.metaGet("analyze_pending") === "1") {
				const tA = Date.now();
				svc.prepare("PRAGMA analysis_limit=1000").run();
				svc.prepare("ANALYZE").run();
				svc.metaSet("analyze_pending", "0");
				console.debug(`[unified-search] ANALYZE 完成 ${Date.now() - tA}ms`);
			}
			console.debug(
				`[unified-search] 扫描完成：写入 ${this.scanWritten}，${Date.now() - t0}ms` +
					(rebuilding ? "（重建疾速档完成）" : "（增量，stat 门免读未变文件）"),
			);
		} catch (e) {
			console.error("[unified-search] 全量索引失败", e);
		} finally {
			this.scanning = false;
		}
	}

	/**
	 * 库外挂载文件（ext 域）：清单元数据来自 logseq 模块的 listExternalSearchFiles
	 * （已剔除 vault 根、应用挂载 include-exclude）。无挂载树事件：initialScan 强制
	 * 刷 + 周期重扫（extTimer）+ 命令手动刷。force 越过 scanning 门（initialScan/
	 * 手动命令持有方各自保证语义，周期路径不带 force 会被门挡住让路）。
	 */
	private async reindexExtFiles(force = false): Promise<void> {
		if (!this.settings.indexExt || this.unloaded) return;
		if (!force && this.scanning) return;
		type ExtEntry = { abs: string; name: string; mtime: number };
		const logseq = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } })
			.plugins?.plugins?.["obsidian-logseq"] as
			| { listExternalSearchFiles?: () => ExtEntry[] }
			| undefined;
		const list = logseq?.listExternalSearchFiles?.() ?? [];
		if (!list.length) return;
		console.debug(`[unified-search] ext 域 ${list.length} 个文件…`);
		const svc = this.getService();
		const CHUNK = 200;
		let indexed = 0;
		for (let i = 0; i < list.length; i += CHUNK) {
			if (this.unloaded) return;
			const slice = list.slice(i, i + CHUNK);
			svc.beginBatch();
			try {
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
			} finally {
				if (svc.inBatch) svc.endBatch();
			}
			await new Promise((resolve) => window.setTimeout(resolve, 0));
		}
		console.debug(`[unified-search] ext 域完成：${indexed}/${list.length}`);
	}

	/** 灌库：64/批流式（读一批→索引一批→让出主线程一拍）。stat 门免读未变文件。
	 *  每批一个批量事务：COMMIT/WAL 检查点成本按批摊薄（reindexExtFiles 同理） */
	private async reindexFiles(files: TFile[]): Promise<void> {
		const svc = this.getService();
		// 64/批 + 批间 24ms 让步：批量内 upsertFile（分词+FTS 写）是同步 CPU 段，
		// 300/批的首建会让主线程冻结秒级（usc2 重建白屏风险），小批+让步换 UI 呼吸
		const CHUNK = 64;
		for (let i = 0; i < files.length; i += CHUNK) {
			if (this.unloaded) return;
			const slice = files.slice(i, i + CHUNK);
			svc.beginBatch();
			try {
				await Promise.all(
					slice.map(async (file) => {
						const meta = fileToMeta(file);
						// stat 门（size→mtime 先于 hash，设计 §4.3）：未变文件不读盘。
						// cachedRead 首读必然落磁盘（网盘 1.2 万文件），这是启动读风暴主力。
						if (this.getWriter().statUnchanged(meta.path, meta.mtime, meta.size)) return;
						// adapter.read 绕过 Obsidian 文件缓存：cachedRead 把全部内容驻留在
						// TFile 缓存里，7.5 万文件全量重建 = 内存涨到 GB 级（2026-10-23 实证
						// 3.5GB 且持续增长）。重建/增量反正每次真读，缓存只有害处。
						try {
							const raw = await this.app.vault.adapter.read(file.path);
							const done = this.getWriter().upsertFile(meta, raw);
							if (!done.skipped) this.scanWritten++;
						} catch (e) {
							// 网盘云占位/文件锁定：单文件失败跳过，不中断整轮重建
							console.warn(`[unified-search] 读取失败跳过 ${meta.path}`, e);
						}
					}),
				);
			} finally {
				if (svc.inBatch) svc.endBatch();
			}
			await new Promise((resolve) => window.setTimeout(resolve, 24));
		}
	}

	/**
	 * 附件灌库（M2-1）：不读内容，纯元数据行。upsertAttachment 自带 size 门，
	 * stat 未变的附件连事务都不开（只有一次 SELECT）。批量事务 + 时间预算让出
	 * 同 reindexPaths——首启扫描要灌几千附件行，逐文件 COMMIT 会让启动卡很久。
	 */
	private async reindexAttachments(files: TFile[]): Promise<void> {
		const svc = this.getService();
		let lastYield = performance.now();
		let batchAt = lastYield;
		let batchCount = 0;
		svc.beginBatch();
		try {
			for (const file of files) {
				if (this.unloaded) return;
				const done = this.getWriter().upsertAttachment(fileToMeta(file));
				if (!done.skipped) this.scanWritten++;
				batchCount++;
				const now = performance.now();
				if (now - lastYield >= 24) {
					if (batchCount >= 64 || now - batchAt >= 300) {
						svc.endBatch();
						svc.beginBatch();
						batchAt = performance.now();
						batchCount = 0;
					}
					await new Promise((resolve) => window.setTimeout(resolve, 8));
					lastYield = performance.now();
				}
			}
		} finally {
			if (svc.inBatch) svc.endBatch();
		}
	}
}

export default UnifiedSearchPlugin;
export type { UnifiedSearchSettings } from "./settings";
export { DEFAULT_SETTINGS } from "./settings";
