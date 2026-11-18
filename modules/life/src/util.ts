/**
 * Life 模块纯函数工具：本地日期键、天数差、连续打卡、日历网格、金额聚合。
 * 「纯」是刻意的——全部可被 vitest 直测（不 import obsidian）。
 */

import type { LedgerEntry, LedgerKind } from './types';

/** 本地 yyyy-mm-dd（不是 UTC—— Date→键一律走这里,防时区错日）。 */
export function dateKey(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

export function todayKey(): string {
	return dateKey(new Date());
}

/** 'yyyy-mm-dd' → 本地 Date 当日零点；非法串返回 null。 */
export function parseDateKey(key: string): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
	if (!m) return null;
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return isNaN(d.getTime()) ? null : d;
}

/** a→b 的自然日差（b-a；同日=0）。两键非法返回 null。 */
export function daysBetween(a: string, b: string): number | null {
	const da = parseDateKey(a);
	const db = parseDateKey(b);
	if (!da || !db) return null;
	return Math.round((db.getTime() - da.getTime()) / 86400000);
}

/** 倒数日文案：未来 D-3 / 今天 D-Day / 过去 D+12。非法日期 null。 */
export function ddayLabel(target: string, from = todayKey()): string | null {
	const diff = daysBetween(from, target);
	if (diff === null) return null;
	if (diff === 0) return 'D-Day';
	return diff > 0 ? `D-${diff}` : `D+${-diff}`;
}

/** 连续打卡天数（截至 today；today 没打卡不算断,从昨天往回数）。 */
export function streakOf(logs: Record<string, boolean>, today = todayKey()): number {
	let streak = 0;
	let cursor = today;
	if (!logs[cursor]) {
		const y = parseDateKey(today);
		if (!y) return 0;
		y.setDate(y.getDate() - 1);
		cursor = dateKey(y);
	}
	while (logs[cursor]) {
		streak++;
		const d = parseDateKey(cursor);
		if (!d) break;
		d.setDate(d.getDate() - 1);
		cursor = dateKey(d);
	}
	return streak;
}

/** 最近 n 天（含 today）的 dateKey 列表，旧→新。 */
export function recentDayKeys(n: number, today = todayKey()): string[] {
	const keys: string[] = [];
	const base = parseDateKey(today);
	if (!base) return keys;
	for (let i = n - 1; i >= 0; i--) {
		const d = new Date(base);
		d.setDate(d.getDate() - i);
		keys.push(dateKey(d));
	}
	return keys;
}

export interface CalendarCell {
	/** yyyy-mm-dd */
	key: string;
	day: number;
	/** 本月内（ false = 前后月的填充格） */
	inMonth: boolean;
}

/** 月视图网格：周一开头，恒 6 行 ×7 列（42 格,前后月填充）。 */
export function monthGrid(year: number, month0: number, today = todayKey()): CalendarCell[] {
	const cells: CalendarCell[] = [];
	const first = new Date(year, month0, 1);
	// getDay(): 周日=0 → 周一开头的偏移
	const lead = (first.getDay() + 6) % 7;
	const start = new Date(year, month0, 1 - lead);
	for (let i = 0; i < 42; i++) {
		const d = new Date(start);
		d.setDate(start.getDate() + i);
		cells.push({ key: dateKey(d), day: d.getDate(), inMonth: d.getMonth() === month0 });
	}
	void today;
	return cells;
}

/** 月份天数（month0: 0-11）。 */
export function daysInMonth(year: number, month0: number): number {
	return new Date(year, month0 + 1, 0).getDate();
}

export interface LedgerMonthSum {
	income: number;
	expense: number;
	/** 分类 → 金额（只含该 kind） */
	byCategory: Record<string, number>;
}

/** 某月（yyyy-mm）聚合：收入/支出/分类小计。amount 四舍五入到分。 */
export function sumLedgerMonth(entries: LedgerEntry[], yearMonth: string, kind?: LedgerKind): LedgerMonthSum {
	const sum: LedgerMonthSum = { income: 0, expense: 0, byCategory: {} };
	for (const e of entries) {
		if (!e.date.startsWith(yearMonth)) continue;
		if (kind && e.kind !== kind) continue;
		const amt = Math.round(e.amount * 100) / 100;
		if (e.kind === 'in') sum.income += amt;
		else sum.expense += amt;
		sum.byCategory[e.category] = Math.round(((sum.byCategory[e.category] ?? 0) + amt) * 100) / 100;
	}
	sum.income = Math.round(sum.income * 100) / 100;
	sum.expense = Math.round(sum.expense * 100) / 100;
	return sum;
}

/** ms → mm:ss（>1h → h:mm:ss）。 */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const sec = total % 60;
	const mm = String(m).padStart(2, '0');
	const ss = String(sec).padStart(2, '0');
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 短 id（时间基 + 随机尾,同毫秒碰撞概率 ~1/10^6）。 */
export function genId(): string {
	const t = Date.now().toString(36);
	let r = '';
	for (let i = 0; i < 4; i++) r += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
	return t + r;
}

/** 解析「25」「25:30」「1:05:00」→ ms；非法/负数 null。 */
export function parseDurationInput(raw: string): number | null {
	const s = raw.trim();
	if (!/^\d{1,3}(:\d{1,2}){0,2}$/.test(s)) return null;
	const parts = s.split(':').map(Number);
	if (parts.some((n) => isNaN(n))) return null;
	let ms = 0;
	if (parts.length === 1) ms = parts[0] * 60000;
	else if (parts.length === 2) ms = parts[0] * 60000 + parts[1] * 1000;
	else ms = parts[0] * 3600000 + parts[1] * 60000 + parts[2] * 1000;
	return ms > 0 ? ms : null;
}

/** 金额输入解析：≥0 两位小数；非法 null。 */
export function parseAmount(raw: string): number | null {
	const n = Number(raw.trim());
	if (!isFinite(n) || n <= 0) return null;
	return Math.round(n * 100) / 100;
}

export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
