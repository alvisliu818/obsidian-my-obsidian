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

/** 提醒文案(变化摘要:N 新增 · M 修改 · K 删除)。 */
export function changeSummary(d: VaultDiff): string {
	return `新增 ${d.added.length} · 修改 ${d.modified.length} · 删除 ${d.deleted.length}`;
}
