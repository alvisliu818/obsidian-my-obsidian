/**
 * 模块自己的设置（移植自 obsidian-audio-timestamp-player 的设置模型，0BSD）。
 *
 * 与基底的区别：基底把播放设置放在插件目录的 player-settings.json 边车
 * （utils/player-settings.ts，原样保留）；这里的「切页行为 / 悬浮视频尺寸」
 * 经宿主持有的 loadData/saveData 分片持久化，是聚合仓的标准做法。
 */

export type NavigationBehavior = "continue" | "pause" | "close";

export interface AudioPlayerSettings {
    /** 音频播放中切换到其它笔记时的行为 */
    audioNavigationBehavior: NavigationBehavior;
    /** 视频播放中切换到其它笔记时的行为 */
    videoNavigationBehavior: NavigationBehavior;
    /** 悬浮播放器创建视频时的宽度（px） */
    videoPlayerWidth: number;
    /** 悬浮播放器创建视频时的高度（px） */
    videoPlayerHeight: number;
    /** 是否允许拖拽调整悬浮视频尺寸 */
    videoResizeEnabled: boolean;
}

export const DEFAULT_SETTINGS: AudioPlayerSettings = {
    audioNavigationBehavior: "continue",
    videoNavigationBehavior: "continue",
    videoPlayerWidth: 480,
    videoPlayerHeight: 320,
    videoResizeEnabled: true,
};

/** 解析已存设置，缺失 / 非法项回退默认 */
export function normalizeSettings(data: unknown): AudioPlayerSettings {
    const saved = (data && typeof data === "object" ? data : {}) as Partial<AudioPlayerSettings>;
    return {
        audioNavigationBehavior: normalizeNavigationBehavior(saved.audioNavigationBehavior, "continue"),
        videoNavigationBehavior: normalizeNavigationBehavior(saved.videoNavigationBehavior, "continue"),
        videoPlayerWidth: normalizeDimension(saved.videoPlayerWidth, 320, 1200, 480),
        videoPlayerHeight: normalizeDimension(saved.videoPlayerHeight, 192, 800, 320),
        videoResizeEnabled: saved.videoResizeEnabled !== false,
    };
}

function normalizeNavigationBehavior(
    value: NavigationBehavior | undefined,
    fallback: NavigationBehavior,
): NavigationBehavior {
    return value === "pause" || value === "close" || value === "continue" ? value : fallback;
}

function normalizeDimension(
    value: number | undefined,
    minimum: number,
    maximum: number,
    fallback: number,
): number {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.min(maximum, Math.max(minimum, Math.round(value)))
        : fallback;
}

/** 按媒体类型取切页行为 */
export function getNavigationBehavior(
    settings: AudioPlayerSettings,
    mediaType: "audio" | "video",
): NavigationBehavior {
    return mediaType === "audio"
        ? settings.audioNavigationBehavior
        : settings.videoNavigationBehavior;
}

export type NavigationAction = "none" | "pause" | "close";

/**
 * 切页动作决策：仍是媒体所属笔记（或行为为 continue）→ 不动；
 * 否则按配置暂停 / 关闭。
 */
export function getNavigationAction(
    behavior: NavigationBehavior,
    isSourceFile: boolean,
): NavigationAction {
    if (isSourceFile || behavior === "continue") return "none";
    return behavior;
}
