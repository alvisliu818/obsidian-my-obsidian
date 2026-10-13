/**
 * obsidian 1.14 的 typings 把 moment 导出成了无调用签名的命名空间形状
 * （`export const moment: typeof Moment`），上游大量 `moment(...)` 调用在
 * 主仓 tsc 下全部报 TS2349。这里给一个 callable 视图，调用点换用本文件。
 */
import { moment } from "obsidian";

export const momentFn = moment as unknown as (
    input?: string | number | Date | void
) => import("moment").Moment;
