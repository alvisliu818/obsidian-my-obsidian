import { setIcon } from "obsidian";

/**
 * 构建统一的时间戳按钮 DOM。
 *
 * @param timeStr      显示用的时间字符串（如 "01:23.456"）
 * @param totalSeconds 点击后跳转到的秒数
 * @param onClick      点击回调；第二个参数为该按钮元素，便于管理 active 状态
 */
export function buildTimestampButton(
    timeStr: string,
    totalSeconds: number,
    onClick: (btn: HTMLElement, e: MouseEvent) => void
): HTMLSpanElement {
    const btn = createSpan({ cls: "tsp-timestamp" });
    btn.setAttribute("data-seconds", String(totalSeconds));
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", `Play from ${timeStr}`);

    const icon = createSpan({ cls: "tsp-play-icon" });
    setIcon(icon, "play");
    btn.appendChild(icon);
    btn.appendChild(createSpan({ cls: "tsp-time", text: timeStr }));

    btn.addEventListener("click", (e) => onClick(btn, e));
    return btn;
}

/**
 * 构建循环播放区间按钮 DOM。
 *
 * @param rangeStr     显示用的区间字符串（如 "01:23->02:34"）
 * @param startSeconds 循环起点（秒）
 * @param endSeconds   循环终点（秒）
 * @param onClick      点击回调；第二个参数为该按钮元素，便于管理 active 状态
 */
export function buildLoopButton(
    rangeStr: string,
    startSeconds: number,
    endSeconds: number,
    onClick: (btn: HTMLElement, e: MouseEvent) => void
): HTMLSpanElement {
    const btn = createSpan({ cls: "tsp-loop-timestamp" });
    btn.setAttribute("data-loop-start", String(startSeconds));
    btn.setAttribute("data-loop-end", String(endSeconds));
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-pressed", "false");

    const icon = createSpan({ cls: "tsp-loop-icon" });
    setIcon(icon, "repeat");
    btn.appendChild(icon);
    btn.appendChild(createSpan({ cls: "tsp-loop-time", text: rangeStr }));

    btn.addEventListener("click", (e) => onClick(btn, e));
    return btn;
}