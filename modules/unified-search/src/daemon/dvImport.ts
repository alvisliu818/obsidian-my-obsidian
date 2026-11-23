/**
 * dataview 页面解析胶水（dataview 收编 · 解析归一，2026-11-23）。
 *
 * daemon 侧唯一的 dataview 数据生产点：
 *   CachedMetadata 形状（dvMeta.ts，js-yaml + 行扫描）
 *   → dataview 自家 parsePage（require 桥——不进任何 tsc 程序，运行时打进
 *     MyKernel.cjs；parsimmon 文法/luxon 类型化与上游一字不差）
 *   → Transferable.transferable()（DateTime/Link/Duration → 标记对象）
 *   → dehydrateValue()（Map/Set → JSON 标记，见 shared/dvSerialize）
 *   → dv_pages 表（JSON 文本）。
 *
 * 渲染端 dataviewBridge 取数后按原链路还原：JSON.parse → hydrateValue() →
 * Transferable.value() → FullIndex.finish()——与上游 worker 通道到达
 * finish() 的对象形状一致。
 *
 * obsidian 在 dataview 解析链里只有类型引用（CachedMetadata/FileStats/
 * FrontMatterCache/HeadingCache），esbuild 擦除后 daemon bundle 无 obsidian
 * 依赖（fileFacts 纯净性判据同款）。parsePage 依赖链里的 npm 包
 * （parsimmon/luxon/emoji-regex/remove-markdown）已进根 dependencies。
 */
import type { Stmt } from "../../../md-editor/src/index/sqliteIndex";
import { dehydrateValue } from "../../../shared/dvSerialize";
import { extractCachedMetadata, type DvCachedMetadata } from "./dvMeta";

/**
 * dv_pages 行的 version 戳（sync/turbo 全量解析时未知渲染端版本，先盖本
 * 常量；渲染端 dvPage 按需取数时会带自己的版本覆写）。必须与宿主 descriptor
 * 的 manifest.version 一致（modules/dataview/NOTICE.md 有一条改双处的约定）。
 */
export const DV_PARSE_VERSION = "0.5.70";

type DvFileStats = { ctime: number; mtime: number; size: number };
type ParsePageFn = (
	path: string,
	contents: string,
	stat: DvFileStats,
	metadata: DvCachedMetadata,
) => unknown;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const markdownFile = require("../../../dataview/src/data-import/markdown-file") as {
	parsePage: ParsePageFn;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const transferableMod = require("../../../dataview/src/data-model/transferable") as {
	Transferable: { transferable(value: unknown): unknown };
};

export interface DvPageRow {
	path: string;
	mtime: number;
	size: number;
	version: string;
	time: number;
	/** JSON 文本：transferable + dehydrate 后的页面数据。 */
	data: string;
}

/** 一次性把一个 markdown 文件解析成 dv_pages 行（纯函数，无副作用）。 */
export function parseDvPage(path: string, content: string, stat: DvFileStats): DvPageRow {
	const metadata = extractCachedMetadata(content);
	const page = markdownFile.parsePage(path, content, stat, metadata);
	const transferable = transferableMod.Transferable.transferable(page);
	return {
		path,
		mtime: stat.mtime,
		size: stat.size,
		version: DV_PARSE_VERSION,
		time: Date.now(),
		data: JSON.stringify(dehydrateValue(transferable)),
	};
}

export function dvStoreStatements(row: DvPageRow): Stmt[] {
	return [
		{
			sql: "INSERT OR REPLACE INTO dv_pages (path, mtime, size, version, time, data) VALUES (?, ?, ?, ?, ?, ?)",
			params: [row.path, row.mtime, row.size, row.version, row.time, row.data],
		},
	];
}
