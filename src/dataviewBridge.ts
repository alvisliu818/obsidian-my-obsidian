/**
 * dataview 索引归一桥（2026-11-23 收编 · 解析归一，用户选定 B 方案）。
 *
 * dataview 渲染端的解析/缓存两条链路在这里被接管，宿主源码零改动：
 *
 *  1. **解析**：`FileImporter.prototype.reload`（上游 = 2 个 web worker 读盘
 *     + parsePage）改经 daemon `dvPage` op 取现成页面数据——daemon 在
 *     sync/turbo 时已用 dataview 自家 parsePage（dvImport.ts require 桥）把
 *     全库解析进 dv_pages 表，这里是取数不是解析。命中失败/daemon 不可达
 *     （移动端、内核停机、排除目录）→ 逐文件回落上游 worker 路径。
 *  2. **缓存**：`LocalStorageCache.prototype.*`（上游 = localforage IndexedDB）
 *     改走 daemon dv_pages：冷启动一次性 `dvPages` 拉全量快照（loadFile 变
 *     纯内存查找），写回/清扫/recreate 转发 daemon；daemon 不可达时回落
 *     IndexedDB。
 *
 * 数据保真：dv_pages 行 = Transferable.transferable(parsePage(...)) 的
 * dehydrate JSON（shared/dvSerialize 处理 Map/Set 的 JSON 标记——上游走
 * postMessage/IndexedDB 结构化克隆不受此影响）；取回时 hydrate →
 * Transferable.value 还原成与 worker 通道完全一致的形状，再交给上游的
 * finish()/canonicalize()（链接解析仍用渲染端 metadataCache，正确性不变）。
 *
 * 客户端发现：daemon 客户端由 md-editor 模块持有（`daemonIndex`），经宿主
 * moduleInstance("md-editor") 取；启动窗口内轮询等待（CLIENT_WAIT_MS），
 * 超时判 null 走回落——之后 daemon 若起来仍按次现取。
 */
import type { App, TFile } from "obsidian";
import { dehydrateValue, hydrateValue } from "../modules/shared/dvSerialize";
import type { BlockIndexDaemonClient } from "../modules/unified-search/src/daemon/daemonClient";

const HOST_PLUGIN_ID = "obsidian-my-obsidian";
/** daemon 客户端的持有模块（BlockIndexDaemonClient 在它的实例上）。 */
const DAEMON_OWNER_MODULE = "md-editor";
/** 启动等待窗：md-editor 的 daemonIndex 是异步赋值（spawn + ping），轮询等它。 */
const CLIENT_WAIT_MS = 5_000;
const CLIENT_POLL_MS = 250;
/** dvPage 按需取数的并发上限（首启冷库全量 miss 时的洪峰削峰）。 */
const DV_FETCH_CONCURRENCY = 8;

// ---- require 桥：dataview 的两个可拦截类 + Transferable ----
// 与 main.ts 的模块桥同款：不进宿主 tsc 程序，运行时打进主 bundle。
/* eslint-disable @typescript-eslint/no-var-requires */
const importerMod = require("../modules/dataview/src/data-import/web-worker/import-manager") as {
	FileImporter: unknown;
};
const persisterMod = require("../modules/dataview/src/data-import/persister") as {
	LocalStorageCache: unknown;
};
const transferableMod = require("../modules/dataview/src/data-model/transferable") as {
	Transferable: {
		value(v: unknown): unknown;
		transferable(v: unknown): unknown;
	};
};
/* eslint-enable @typescript-eslint/no-var-requires */

type CachedEntry = { version: string; time: number; data: unknown };

interface SnapshotRow {
	version: string;
	time: number;
	dataJson: string;
}

const FileImporterProto = importerMod.FileImporter as {
	prototype: { reload(file: TFile): Promise<unknown> };
};
const LocalStorageCacheProto = persisterMod.LocalStorageCache as {
	prototype: {
		version: string;
		loadFile(path: string): Promise<CachedEntry | null | undefined>;
		storeFile(path: string, data: unknown): Promise<void>;
		synchronize(existing: string[] | Set<string>): Promise<Set<string>>;
		recreate(): Promise<void>;
	};
};
const Transferable = transferableMod.Transferable;

interface BridgeState {
	app: App;
	/** descriptor 的 manifest.version（dvPage 落库盖章用，须与 daemon 的
	 *  DV_PARSE_VERSION 一致才能命中快照行；不一致自愈为逐文件重解析）。 */
	version: string;
	clientWait: Promise<BlockIndexDaemonClient | null> | null;
	snapshot: Map<string, SnapshotRow> | null;
	snapshotVersion: number;
	snapshotWait: Promise<Map<string, SnapshotRow> | null> | null;
}

let state: BridgeState | null = null;
const originals: {
	reload?: (this: unknown, file: TFile) => Promise<unknown>;
	loadFile?: (this: { version: string }, path: string) => Promise<CachedEntry | null | undefined>;
	storeFile?: (this: { version: string }, path: string, data: unknown) => Promise<void>;
	synchronize?: (this: unknown, existing: string[] | Set<string>) => Promise<Set<string>>;
	recreate?: (this: unknown) => Promise<void>;
} = {};

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ---- dvPage 并发闸（简单信号量，不引依赖） ----
let dvActive = 0;
const dvQueue: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (dvActive >= DV_FETCH_CONCURRENCY) await new Promise<void>((r) => dvQueue.push(r));
	dvActive++;
	try {
		return await fn();
	} finally {
		dvActive--;
		dvQueue.shift()?.();
	}
}

/** 宿主插件实例 → md-editor 模块实例 → daemon 客户端（每调用现取，跟进重启换件）。 */
function currentClient(): BlockIndexDaemonClient | null | Promise<BlockIndexDaemonClient | null> {
	if (!state) return null;
	const host = state.app.plugins.plugins[HOST_PLUGIN_ID] as
		| { moduleInstance?: (id: string) => unknown }
		| undefined;
	const owner = host?.moduleInstance?.(DAEMON_OWNER_MODULE) as
		| { daemonIndex?: BlockIndexDaemonClient | null }
		| undefined;
	if (owner?.daemonIndex) return owner.daemonIndex;
	// 启动窗口：md-editor 还没把 daemonIndex 赋上——轮询等一段（缓存等待，
	// 超时判 null 走回落；此后 daemon 起来了仍会被上面的现取命中）。
	if (!state.clientWait) {
		state.clientWait = (async () => {
			const deadline = Date.now() + CLIENT_WAIT_MS;
			while (Date.now() < deadline) {
				const h = state?.app.plugins.plugins[HOST_PLUGIN_ID] as
					| { moduleInstance?: (id: string) => unknown }
					| undefined;
				const o = h?.moduleInstance?.(DAEMON_OWNER_MODULE) as
					| { daemonIndex?: BlockIndexDaemonClient | null }
					| undefined;
				if (o?.daemonIndex) return o.daemonIndex;
				await sleep(CLIENT_POLL_MS);
			}
			return null;
		})();
	}
	return state.clientWait;
}

/** 冷启动快照：一次性 dvPages 拉全量；daemon 广播 changed（version 变）即失效重拉。 */
function snapshotMap(): Promise<Map<string, SnapshotRow> | null> | null {
	if (!state) return null;
	const cached = state.snapshot;
	if (cached && state.snapshotVersion >= 0) {
		const client = currentClient();
		if (client && !(client instanceof Promise)) {
			if (client.version === state.snapshotVersion) return Promise.resolve(cached);
		} else {
			return Promise.resolve(cached);
		}
	}
	if (!state.snapshotWait) {
		state.snapshotWait = (async () => {
			const client = await currentClient();
			if (!client) return null;
			const res = await client.dvPages();
			const map = new Map<string, SnapshotRow>();
			for (const row of res.rows) {
				map.set(row.path, { version: row.version, time: row.time, dataJson: row.data });
			}
			state!.snapshot = map;
			state!.snapshotVersion = client.version;
			return map;
		})().finally(() => {
			if (state) state.snapshotWait = null;
		});
	}
	return state.snapshotWait;
}

export function installDataviewIndexBridge(app: App, version: string): void {
	if (state) return;
	state = {
		app,
		version,
		clientWait: null,
		snapshot: null,
		snapshotVersion: -1,
		snapshotWait: null,
	};

	// ---- 解析链：reload → daemon dvPage（miss/失败逐文件回落 worker） ----
	originals.reload = FileImporterProto.prototype.reload;
	FileImporterProto.prototype.reload = async function (file: TFile): Promise<unknown> {
		try {
			const maybe = currentClient();
			const client = maybe instanceof Promise ? await maybe : maybe;
			if (client) {
				const res = await withSlot(() => client.dvPage(file.path, state!.version));
				if (res) {
					return Transferable.value(hydrateValue(JSON.parse(res.data)));
				}
				// daemon 没有这个文件（排除目录/非 md）→ 回落上游 worker 解析
			}
		} catch {
			/* daemon 忙/挂 → 回落上游路径 */
		}
		return originals.reload!.call(this, file);
	};

	// ---- 缓存链：LocalStorageCache → daemon dv_pages（快照 + 回落 IndexedDB） ----
	originals.loadFile = LocalStorageCacheProto.prototype.loadFile;
	LocalStorageCacheProto.prototype.loadFile = async function (
		this: { version: string },
		path: string,
	): Promise<CachedEntry | null | undefined> {
		try {
			const snap = await snapshotMap();
			if (snap) {
				const row = snap.get(path);
				if (!row) return null;
				return {
					version: row.version,
					time: row.time,
					data: Transferable.value(hydrateValue(JSON.parse(row.dataJson))),
				};
			}
		} catch {
			/* daemon 忙/挂 → 回落 IndexedDB */
		}
		return originals.loadFile!.call(this, path);
	};

	originals.storeFile = LocalStorageCacheProto.prototype.storeFile;
	LocalStorageCacheProto.prototype.storeFile = async function (
		this: { version: string },
		path: string,
		data: unknown,
	): Promise<void> {
		try {
			const snap = await snapshotMap();
			if (snap) {
				// daemon 模式下 dvPage 已落库，这里只让本会话快照保持新鲜
				snap.set(path, {
					version: this.version,
					time: Date.now(),
					dataJson: JSON.stringify(dehydrateValue(Transferable.transferable(data))),
				});
				return;
			}
		} catch {
			/* 回落 IndexedDB */
		}
		await originals.storeFile!.call(this, path, data);
	};

	originals.synchronize = LocalStorageCacheProto.prototype.synchronize;
	LocalStorageCacheProto.prototype.synchronize = async function (
		this: unknown,
		existing: string[] | Set<string>,
	): Promise<Set<string>> {
		try {
			const maybe = currentClient();
			const client = maybe instanceof Promise ? await maybe : maybe;
			if (client) {
				void client.dvPrune([...existing]).catch(() => {});
				if (state) state.snapshot = null;
				return new Set<string>();
			}
		} catch {
			/* 回落 */
		}
		return originals.synchronize!.call(this, existing);
	};

	originals.recreate = LocalStorageCacheProto.prototype.recreate;
	LocalStorageCacheProto.prototype.recreate = async function (this: unknown): Promise<void> {
		try {
			const maybe = currentClient();
			const client = maybe instanceof Promise ? await maybe : maybe;
			if (client) {
				await client.dvRecreate();
				if (state) state.snapshot = null;
				return;
			}
		} catch {
			/* 回落 */
		}
		await originals.recreate!.call(this);
	};

	console.info(`[my-obsidian] dataview index bridge installed (daemon parse, version=${version})`);
}

export function uninstallDataviewIndexBridge(): void {
	if (!state) return;
	if (originals.reload) FileImporterProto.prototype.reload = originals.reload;
	if (originals.loadFile) LocalStorageCacheProto.prototype.loadFile = originals.loadFile;
	if (originals.storeFile) LocalStorageCacheProto.prototype.storeFile = originals.storeFile;
	if (originals.synchronize) LocalStorageCacheProto.prototype.synchronize = originals.synchronize;
	if (originals.recreate) LocalStorageCacheProto.prototype.recreate = originals.recreate;
	state = null;
	console.info("[my-obsidian] dataview index bridge removed");
}
