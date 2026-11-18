import { describe, expect, it } from 'vitest';
import {
	daysBetween,
	ddayLabel,
	dateKey,
	formatDuration,
	monthGrid,
	parseAmount,
	parseDurationInput,
	recentDayKeys,
	streakOf,
	sumLedgerMonth,
} from '../src/util';

describe('dateKey/parseDateKey', () => {
	it('本地日期键零填充', () => {
		expect(dateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
		expect(dateKey(new Date(2026, 11, 31))).toBe('2026-12-31');
	});
	it('非法键解析为 null', () => {
		expect(daysBetween('bad', '2026-01-01')).toBeNull();
	});
});

describe('daysBetween/ddayLabel', () => {
	it('同日 0，未来正、过去负', () => {
		expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
		expect(daysBetween('2026-01-01', '2026-01-10')).toBe(9);
		expect(daysBetween('2026-01-10', '2026-01-01')).toBe(-9);
	});
	it('跨月/闰年', () => {
		expect(daysBetween('2026-02-27', '2026-03-02')).toBe(3);
		expect(daysBetween('2024-02-27', '2024-03-02')).toBe(4); // 2024 闰年
	});
	it('倒数日文案', () => {
		expect(ddayLabel('2026-01-10', '2026-01-07')).toBe('D-3');
		expect(ddayLabel('2026-01-07', '2026-01-07')).toBe('D-Day');
		expect(ddayLabel('2026-01-01', '2026-01-07')).toBe('D+6');
	});
});

describe('streakOf', () => {
	it('连续打卡含今天', () => {
		const logs = { '2026-01-05': true, '2026-01-06': true, '2026-01-07': true };
		expect(streakOf(logs, '2026-01-07')).toBe(3);
	});
	it('今天没打卡不断签（从昨天回数）', () => {
		const logs = { '2026-01-05': true, '2026-01-06': true };
		expect(streakOf(logs, '2026-01-07')).toBe(2);
	});
	it('中间断档清零', () => {
		const logs = { '2026-01-04': true, '2026-01-06': true, '2026-01-07': true };
		expect(streakOf(logs, '2026-01-07')).toBe(2);
	});
	it('全空为 0', () => {
		expect(streakOf({}, '2026-01-07')).toBe(0);
	});
});

describe('recentDayKeys', () => {
	it('n=7 含今天旧→新', () => {
		const keys = recentDayKeys(3, '2026-01-07');
		expect(keys).toEqual(['2026-01-05', '2026-01-06', '2026-01-07']);
	});
});

describe('monthGrid', () => {
	it('恒 42 格,周一开头', () => {
		const cells = monthGrid(2026, 0); // 2026-01-01 是周四
		expect(cells).toHaveLength(42);
		// 2026-01-01 周四 → 周一开头的前置 3 格是 12/28-12/30
		expect(cells[0].key).toBe('2025-12-29');
		expect(cells[3].key).toBe('2026-01-01');
		expect(cells[3].inMonth).toBe(true);
		expect(cells[0].inMonth).toBe(false);
	});
});

describe('sumLedgerMonth', () => {
	const entries = [
		{ id: '1', date: '2026-01-03', kind: 'out' as const, amount: 12.5, category: '餐饮' },
		{ id: '2', date: '2026-01-10', kind: 'in' as const, amount: 3000, category: '工资' },
		{ id: '3', date: '2026-01-20', kind: 'out' as const, amount: 8, category: '餐饮' },
		{ id: '4', date: '2026-02-01', kind: 'out' as const, amount: 99, category: '购物' },
	];
	it('月内收支与分类小计', () => {
		const sum = sumLedgerMonth(entries, '2026-01');
		expect(sum.income).toBe(3000);
		expect(sum.expense).toBe(20.5);
		expect(sum.byCategory['餐饮']).toBe(20.5);
		expect(sum.byCategory['工资']).toBe(3000);
	});
	it('kind 过滤', () => {
		const sum = sumLedgerMonth(entries, '2026-01', 'out');
		expect(sum.income).toBe(0);
		expect(sum.expense).toBe(20.5);
	});
	it('跨月不含', () => {
		expect(sumLedgerMonth(entries, '2026-03').expense).toBe(0);
	});
});

describe('formatDuration/parseDurationInput', () => {
	it('mm:ss / h:mm:ss', () => {
		expect(formatDuration(65000)).toBe('01:05');
		expect(formatDuration(3905000)).toBe('1:05:05');
		expect(formatDuration(-5)).toBe('00:00');
	});
	it('输入解析', () => {
		expect(parseDurationInput('25')).toBe(25 * 60000);
		expect(parseDurationInput('1:05')).toBe(65000);
		expect(parseDurationInput('1:05:00')).toBe(3900000);
		expect(parseDurationInput('0')).toBeNull();
		expect(parseDurationInput('abc')).toBeNull();
		expect(parseDurationInput('-5')).toBeNull();
		expect(parseDurationInput('1:5:')).toBeNull();
	});
});

describe('parseAmount', () => {
	it('正数两位小数', () => {
		expect(parseAmount('25')).toBe(25);
		expect(parseAmount('25.567')).toBe(25.57);
		expect(parseAmount('0')).toBeNull();
		expect(parseAmount('-3')).toBeNull();
		expect(parseAmount('x')).toBeNull();
	});
});
