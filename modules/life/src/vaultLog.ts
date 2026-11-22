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

// ---------------------------------------------------------------------------
// 修改对比(2026-11-21 用户):行级 diff——库记录里点修改的文件,在编辑器
// (原生/monaco)里画 VSCode 式装点(新增绿/修改蓝),点标记可看对比并可撤回。
// ---------------------------------------------------------------------------

export interface LineDiff {
	/** after 行号(1-based):纯新增行 */
	added: number[];
	/** after 行号(1-based):修改行(与删除配对的替换行) */
	modified: number[];
	/** 删除行:line = 在 after 中的插入点(1-based),text = 内容 */
	deleted: Array<{ line: number; text: string }>;
	beforeLines: number;
	afterLines: number;
	/** 合并序列(全文:公共前后缀上下文 + 增删改,按 after 位置序):对比视图
	 * 渲染数据源。beforeLine/afterLine = null 表示该侧不存在(新增/删除)。 */
	rows: Array<{ beforeLine: number | null; afterLine: number | null; kind: 'ctx' | 'add' | 'mod' | 'del'; text: string }>;
}

/**
 * 行级 LCS diff(VSCode 语义):LCS 匹配行 = 上下文;after 中未匹配行按其
 * 所在删/增块与删除行位置配对 → 修改(蓝),无配对的 → 新增(绿);
 * before 未匹配行 = 删除。公共前后缀先裁掉;中段 DP(m*n ≤ 4M 内精确,
 * 超出退化为中段整体按位置配对,避免大文件 O(n²) 卡死)。
 */
export function diffLines(before: string, after: string): LineDiff {
	const a = before ? before.split('\n') : [];
	const b = after ? after.split('\n') : [];
	const n = a.length;
	const m = b.length;
	let pre = 0;
	while (pre < n && pre < m && a[pre] === b[pre]) pre++;
	let endA = n;
	let endB = m;
	while (endA > pre && endB > pre && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const midA = a.slice(pre, endA);
	const midB = b.slice(pre, endB);
	const M = midA.length;
	const N = midB.length;
	type Op = [kind: 0 | 1 | 2, i: number, j: number];
	const ops: Op[] = [];
	if (M > 0 || N > 0) {
		if (M * N <= 4_000_000) {
			const width = N + 1;
			const dp = new Int32Array((M + 1) * width);
			for (let i = M - 1; i >= 0; i--) {
				const rowBase = i * width;
				const nextBase = (i + 1) * width;
				for (let j = N - 1; j >= 0; j--) {
					dp[rowBase + j] =
						midA[i] === midB[j]
							? dp[nextBase + j + 1] + 1
							: Math.max(dp[nextBase + j], dp[rowBase + j + 1]);
				}
			}
			let i = 0;
			let j = 0;
			while (i < M && j < N) {
				if (midA[i] === midB[j]) {
					ops.push([0, i, j]);
					i++;
					j++;
				} else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
					ops.push([1, i, j]);
					i++;
				} else {
					ops.push([2, i, j]);
					j++;
				}
			}
			while (i < M) {
				ops.push([1, i, j]);
				i++;
			}
			while (j < N) {
				ops.push([2, i, j]);
				j++;
			}
		} else {
			// 大文件退化:中段整体按位置配对成交替删/增块(全部 → 修改)
			for (let i = 0; i < Math.max(M, N); i++) {
				if (i < M) ops.push([1, i, i]);
				if (i < N) ops.push([2, Math.min(i, M), i]);
			}
		}
	}
	const afterLineOf = (j: number): number => pre + j + 1;
	const added: number[] = [];
	const modified: number[] = [];
	const deleted: Array<{ line: number; text: string }> = [];
	const rows: LineDiff['rows'] = [];
	// 公共前缀也进 rows:分栏视图要展示全文,不能只剩改动段(2026-11-22 用户)
	for (let i = 0; i < pre; i++) {
		rows.push({ beforeLine: i + 1, afterLine: i + 1, kind: 'ctx', text: a[i] });
	}
	let ai = 0;
	let bj = 0;
	let k = 0;
	const ctxRow = (): void => {
		rows.push({ beforeLine: pre + ai + 1, afterLine: pre + bj + 1, kind: 'ctx', text: midA[ai] ?? '' });
		ai++;
		bj++;
	};
	while (k < ops.length) {
		if (ops[k][0] === 0) {
			ctxRow();
			k++;
			continue;
		}
		const dels: Array<{ text: string; atB: number }> = [];
		const adds: Array<{ atB: number }> = [];
		while (k < ops.length && ops[k][0] !== 0) {
			const [kind, i] = ops[k];
			if (kind === 1) {
				dels.push({ text: midA[i], atB: bj });
				ai++;
			} else {
				adds.push({ atB: bj });
				bj++;
			}
			k++;
		}
		const paired = Math.min(dels.length, adds.length);
		for (let t = 0; t < paired; t++) {
			const atB = adds[t].atB;
			modified.push(afterLineOf(atB));
			deleted.push({ line: afterLineOf(dels[t].atB), text: dels[t].text });
			// 行序:旧文本行(红)在前、新文本行(蓝)在后——VSCode 内嵌同款
			rows.push({ beforeLine: pre + ai - dels.length + t + 1, afterLine: null, kind: 'del', text: dels[t].text });
			rows.push({ beforeLine: null, afterLine: pre + atB + 1, kind: 'mod', text: midB[atB] ?? '' });
		}
		for (let t = paired; t < adds.length; t++) {
			const atB = adds[t].atB;
			added.push(afterLineOf(atB));
			rows.push({ beforeLine: null, afterLine: pre + atB + 1, kind: 'add', text: midB[atB] ?? '' });
		}
		for (let t = paired; t < dels.length; t++) {
			const d = dels[t];
			deleted.push({ line: afterLineOf(d.atB), text: d.text });
			rows.push({ beforeLine: pre + ai - dels.length + t + 1, afterLine: null, kind: 'del', text: d.text });
		}
	}
	// 公共后缀:全文尾段,行号两侧各自延续(before i / after endB+(i-endA))
	for (let i = endA; i < n; i++) {
		rows.push({ beforeLine: i + 1, afterLine: endB + (i - endA) + 1, kind: 'ctx', text: a[i] });
	}
	added.sort((x, y) => x - y);
	modified.sort((x, y) => x - y);
	deleted.sort((x, y) => x.line - y.line);
	rows.sort((x, y) => (x.afterLine ?? y.beforeLine ?? 0) - (y.afterLine ?? x.beforeLine ?? 0));
	return { added, modified, deleted, beforeLines: n, afterLines: m, rows };
}
