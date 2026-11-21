/**
 * 库记录引擎(2026-11-19 阶段 C):库内文件签名快照 + 相对上一次记录的
 * 变化对比 + 调度判定(每日时间点/固定周期)。
 *
 * 快照 = Record<路径, "mtime:size">——来源 app.vault.getFiles()(库内全部
 * 文件,含附件;stat 由 vault 元数据同步给出,零 IO)。签名串紧凑(主库万级
 * 文件 ≈ 1MB 级 JSON,存 data.json 可承受;若膨胀迁独立文件 store 一处改)。
 *
 * diff 语义:上一次记录的快照 vs 本次——两侧都有但签名变 = 修改;仅本次 =
 * 新增;仅上次 = 删除。路径用库内相对路径(与文件列表 UI 同源)。
 *
 * 调度:每日时间点(HH:mm,归属日防重)+ 固定周期(分钟);两者独立,命中即
 * 记录并提醒。纯函数 parseHHmm/dailyDue/periodDue 单测覆盖。
 */
import type { VaultLogRecord } from './types';

export interface FileSig {
	mtime: number;
	size: number;
}

/** 紧凑签名表:路径 → "mtime:size"。 */
export type SigTable = Record<string, string>;

export interface VaultDiff {
	added: string[];
	modified: string[];
	deleted: string[];
}

/** 带重命名识别的变化(用户 2026-11-20:库记录识别不准——重命名/移动此前拆成 删除+新增)。 */
export interface VaultDiffWithRenames extends VaultDiff {
	/** 签名(mtime:size)完全一致的 删除↔新增 配对 = 重命名/移动 */
	renames: Array<{ from: string; to: string }>;
}

export function sigKey(mtime: number, size: number): string {
	return `${mtime}:${size}`;
}

/** 库内全部文件的签名表(vault 元数据同步读取,零 IO)。 */
export function scanVaultSig(vault: {
	getFiles: () => { path: string; stat: { mtime: number; size: number } }[];
}): SigTable {
	const out: SigTable = {};
	for (const f of vault.getFiles()) {
		out[f.path] = sigKey(f.stat.mtime, f.stat.size);
	}
	return out;
}

/** 相对上一次快照的变化(路径升序,稳定输出)。 */
export function diffSigTable(prev: SigTable, cur: SigTable): VaultDiff {
	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];
	for (const p of Object.keys(cur)) {
		if (!(p in prev)) added.push(p);
		else if (prev[p] !== cur[p]) modified.push(p);
	}
	for (const p of Object.keys(prev)) {
		if (!(p in cur)) deleted.push(p);
	}
	const byPath = (a: string, b: string) => a.localeCompare(b);
	added.sort(byPath);
	modified.sort(byPath);
	deleted.sort(byPath);
	return { added, modified, deleted };
}

/**
 * 带重命名识别的变化:基础 diff 之后,把签名(mtime:size)完全一致的
 * 删除↔新增按路径序配对 = 重命名/移动(文件夹移动天然成对识别)。
 * 修改过内容的先改名后写 → 仍拆成 删除+新增(签名不一致,诚实降级)。
 */
export function diffWithRenames(prev: SigTable, cur: SigTable): VaultDiffWithRenames {
	const base = diffSigTable(prev, cur);
	const sigOfDeleted = new Map<string, string[]>();
	for (const p of base.deleted) {
		const sig = prev[p];
		const list = sigOfDeleted.get(sig);
		if (list) list.push(p);
		else sigOfDeleted.set(sig, [p]);
	}
	const renames: Array<{ from: string; to: string }> = [];
	const used = new Set<string>();
	const added: string[] = [];
	for (const p of base.added) {
		// added/deleted 均已按路径升序 → 配对确定(同签名多候选取字典序最小)
		const cands = (sigOfDeleted.get(cur[p]) ?? []).find((d) => !used.has(d));
		if (cands !== undefined) {
			used.add(cands);
			renames.push({ from: cands, to: p });
		} else {
			added.push(p);
		}
	}
	const deleted = base.deleted.filter((d) => !used.has(d));
	return { added, modified: base.modified, deleted, renames };
}

/** HH:mm → 当日分钟数;格式非法返回 null。 */
export function parseHHmm(s: string): number | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
	if (!m) return null;
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (h < 0 || h > 23 || min < 0 || min > 59) return null;
	return h * 60 + min;
}

/** 当日分钟数(now)。 */
export function nowMinutes(now = new Date()): number {
	return now.getHours() * 60 + now.getMinutes();
}

/** 今日 dateKey(yyyy-mm-dd 本地日)。 */
export function dayKeyOf(now = new Date()): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * 每日时间点是否到期:当日已过该分钟 且 归属日 ≠ 已记录日。
 * (跨天回绕:昨天 23:59 的点在今天 00:01 查——归属日不匹配即到期,
 * 由调用方记录后写 lastDailyDate 收敛。)
 */
export function dailyDue(now: Date, time: string, lastDailyDate: string): boolean {
	const target = parseHHmm(time);
	if (target === null) return false;
	const today = dayKeyOf(now);
	if (today === lastDailyDate) return false;
	return nowMinutes(now) >= target;
}

/**
 * 固定周期是否到期:距上次周期记录 ≥ periodMin(周期关/上次未知 = 不到期,
 * 上次未知由首次记录收敛)。
 */
export function periodDue(now: Date, periodMin: number, lastPeriodAt: number): boolean {
	if (periodMin <= 0 || lastPeriodAt <= 0) return false;
	return now.getTime() - lastPeriodAt >= periodMin * 60000;
}

/**
 * 记录列表按归属日倒序(2026-11-21 用户:最新在最上)。渲染侧排序——存储写入
 * 本就新在前(main.ts 记录头部插入),这里做显式保证并对旧数据兜底,不动存储。
 * 只比 rec.date(YYYY-MM-DD 定长 ASCII,字典序即时间序),不依赖 rec.at 的
 * 秒级字段;同日比较为 0 → 稳定排序保持传入次序(即存储序)。
 */
export function sortVaultLogRecordsDesc(records: VaultLogRecord[]): VaultLogRecord[] {
	return [...records].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * 按归属日筛选记录('' = 不过滤,原样返回)。纯函数;选中的日期由调用方
 * (视图 UI state)持有,不落盘。
 */
export function filterVaultLogRecordsByDate(records: VaultLogRecord[], date: string): VaultLogRecord[] {
	if (!date) return records;
	return records.filter((r) => r.date === date);
}

/** 提醒文案(变化摘要:N 新增 · M 修改 · K 删除 [+ 重命名 R])。 */
export function changeSummary(d: VaultDiff, renames = 0): string {
	const base = `新增 ${d.added.length} · 修改 ${d.modified.length} · 删除 ${d.deleted.length}`;
	return renames > 0 ? `${base} · 重命名 ${renames}` : base;
}
