export interface TraceTimeSettings {
	/** 档位 1：多少分钟内显示“刚刚”，0 = 关闭 */
	justNowMinutes: number;
	/** 档位 2：多少分钟内显示“N 分钟前”，0 = 关闭 */
	minutesAgoLimit: number;
	/** 档位 3：多少小时内显示“N 小时前”，0 = 关闭 */
	hoursAgoLimit: number;
	/** 档位 4：今天的块显示 HH:mm */
	todayTimeOnly: boolean;
	/** 档位 5：昨天的块显示“昨天 HH:mm” */
	yesterdayWithTime: boolean;
	/** 档位 6：多少天内显示“N 天前”，0 = 关闭 */
	daysAgoLimit: number;
	/** 档位 7：今年的块显示 MM-DD */
	thisYearShort: boolean;
	/** 回退格式：更早的块按此显示，占位符见 renderDateFormat */
	dateFormat: string;
	/** 标签字号（px） */
	labelFontSize: number;
	/** 紧凑模式：关闭限制行宽时标签收起为圆点，悬停展开 */
	compactLabels: boolean;
	/** 标签垂直位置：块首行 / 块中间 / 块末行（首末行指该行的行内居中） */
	labelVertical: "start" | "middle" | "end";
}

export const DEFAULT_SETTINGS: TraceTimeSettings = {
	justNowMinutes: 3,
	minutesAgoLimit: 60,
	hoursAgoLimit: 24,
	todayTimeOnly: false,
	yesterdayWithTime: true,
	daysAgoLimit: 0,
	thisYearShort: false,
	dateFormat: "YYYY-MM-DD HH:mm",
	labelFontSize: 12,
	compactLabels: true,
	labelVertical: "middle",
};

export function nowMinutes(): number {
	return Math.floor(Date.now() / 60000);
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * 按格式串渲染日期。占位符：
 * YYYY=4 位年  YY=2 位年  MM=月  M=月(不补零)  DD=日  D=日(不补零)
 * HH=时  mm=分  W=当月第几周（1-7 日 = 第 1 周，依此类推）
 */
export function renderDateFormat(format: string, d: Date): string {
	const tokens: Record<string, string> = {
		YYYY: String(d.getFullYear()),
		YY: pad2(d.getFullYear() % 100),
		MM: pad2(d.getMonth() + 1),
		M: String(d.getMonth() + 1),
		DD: pad2(d.getDate()),
		D: String(d.getDate()),
		HH: pad2(d.getHours()),
		mm: pad2(d.getMinutes()),
		W: String(Math.ceil(d.getDate() / 7)),
	};
	return format.replace(/YYYY|YY|MM|M|DD|D|HH|mm|W/g, (t) => tokens[t]);
}

/** 本地日历日序号，用于计算“差几天”（按自然日而不是 24 小时）。 */
function daySerial(d: Date): number {
	return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
}

/**
 * 阶梯式显示规则：从上往下匹配，命中即停；某档关闭（阈值 0 / 开关关）
 * 则落到下一档，最后由完整日期格式兜底。
 * 纯显示层逻辑：存储的永远是分钟时间戳。
 */
export function formatTimestamp(
	minutes: number,
	settings: TraceTimeSettings,
	now: Date = new Date()
): string {
	const d = new Date(minutes * 60000);
	const diffMin = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60000));

	// 1. 刚刚
	if (settings.justNowMinutes > 0 && diffMin < settings.justNowMinutes) return "刚刚";

	// 2. N 分钟前
	if (settings.minutesAgoLimit > 0 && diffMin < settings.minutesAgoLimit) {
		return `${diffMin} 分钟前`;
	}

	// 3. N 小时前
	const diffHours = Math.floor(diffMin / 60);
	if (settings.hoursAgoLimit > 0 && diffHours >= 1 && diffHours < settings.hoursAgoLimit) {
		return `${diffHours} 小时前`;
	}

	const dayDiff = daySerial(now) - daySerial(d);

	// 4. 今天 HH:mm
	if (settings.todayTimeOnly && dayDiff === 0) {
		return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	}

	// 5. 昨天 HH:mm
	if (settings.yesterdayWithTime && dayDiff === 1) {
		return `昨天 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	}

	// 6. N 天前
	if (settings.daysAgoLimit > 0 && dayDiff >= 1 && dayDiff <= settings.daysAgoLimit) {
		return `${dayDiff} 天前`;
	}

	// 7. 今年 MM-DD
	if (settings.thisYearShort && d.getFullYear() === now.getFullYear()) {
		return renderDateFormat("MM-DD", d);
	}

	// 回退：完整日期格式
	return renderDateFormat(settings.dateFormat || "YYYY-MM-DD HH:mm", d);
}
