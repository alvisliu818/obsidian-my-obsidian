/**
 * 时间戳相关的共享工具：
 *  - 统一的解析、格式化函数
 *  - 统一的匹配正则（避免多处手写走样）
 */

/** 无锚点、无全局标志的时间戳模式（用于 String.match / test 的单次查询） */
export const TS_PATTERN = /(?:(?:\d{1,3}):)?\d{1,3}:\d{2}(?:\.\d{1,3})?/;

/** 带锚点与捕获组的完整匹配（可选 时:分:秒(.毫秒)） */
const TS_FULL_RE = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?$/;

/**
 * 创建带捕获组和全局标志的正则（用于扫描 / 替换）。
 * 每次调用返回独立实例，避免 lastIndex 在多个扫描器之间相互污染。
 */
export function createInlineTsRegex(): RegExp {
    return /(?:(?:(\d{1,3}):)?(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?)/g;
}

/**
 * 创建循环播放区间的正则（`[loop]` + 两个时间戳 + `->`）。
 * 每次调用返回独立实例，避免 lastIndex 相互污染。
 */
export function createLoopRangeRegex(): RegExp {
    return /\[loop\][ \t]*((?:(?:\d{1,3}):)?\d{1,3}:\d{2}(?:\.\d{1,3})?)[ \t]*->[ \t]*((?:(?:\d{1,3}):)?\d{1,3}:\d{2}(?:\.\d{1,3})?)/gi;
}

/** 解析 "MM:SS(.mmm)" / "H:MM:SS(.mmm)" 形式的时间字符串为秒 */
export function parseTimestamp(s: string): number {
    const m = s.trim().match(TS_FULL_RE);
    if (!m) return 0;
    const [, h, mm, ss, ms] = m;
    return (Number(h) || 0) * 3600
         + (Number(mm) || 0) * 60
         + (Number(ss) || 0)
         + (ms ? parseFloat("0." + ms) : 0);
}

/**
 * 将秒数格式化为 "MM:SS" / "H:MM:SS"，
 * withMs 为 true 时附带 ".mmm" 毫秒后缀。
 *
 * 注意：毫秒按四舍五入，可能出现 1000，此时秒数进位。
 */
export function formatTime(seconds: number, withMs: boolean = true): string {
    if (!isFinite(seconds) || seconds < 0) return "00:00";

    let totalSec: number;
    let msPart = 0;
    if (withMs) {
        const totalMs = Math.round(seconds * 1000);
        totalSec = Math.floor(totalMs / 1000);
        msPart = totalMs % 1000;
    } else {
        totalSec = Math.floor(seconds);
    }

    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const base = h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    return withMs ? base + "." + String(msPart).padStart(3, '0') : base;
}