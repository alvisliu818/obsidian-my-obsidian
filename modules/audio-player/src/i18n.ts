import { getLanguage } from "obsidian";

/** 支持的语言 */
export type Locale = "en" | "zh-CN" | "zh-TW";

/** 英文字典为准，键集即 StringKey */
const en = {
    "menu.ms": "Timestamp includes milliseconds",
    "menu.copy": "Copy current timestamp",
    "menu.insert": "Insert current timestamp into queue",
    "menu.playback": "More playback settings",
    "menu.shortcuts": "Shortcut settings",

    "aria.rewind": "Backward",
    "aria.step": "Toggle step",
    "aria.forward": "Forward",
    "aria.speed": "Toggle playback speed",
    "aria.subtitle": "Subtitles",

    "step.frame": "Frame",
    "step.keyframe": "Keyframe",
    "step.5s": "5s",

    "notice.insertPreviewOnly": "Inserting timestamps is only supported in Live Preview",
    "notice.noMediaLine": "Could not locate the media source line",
    "notice.inserted": "Inserted timestamp {time}",
    "notice.msOn": "Milliseconds display enabled",
    "notice.msOff": "Milliseconds display disabled",
    "notice.copied": "Timestamp copied: {time}",
    "notice.copyFailed": "Could not copy timestamp: {time}",

    "sticky.enable": "Enable media pinning",
    "sticky.disable": "Disable media pinning",

    "playback.title": "More Playback Settings",
    "playback.mode": "Playback mode",
    "playback.modeDesc": "What happens when playback ends",
    "playback.ratio": "Video ratio",
    "playback.ratioDesc": "Force the display ratio (video only)",
    "playback.orientation": "Orientation",
    "playback.orientationDesc": "Landscape / portrait (video only; portrait is limited to the page)",

    "opt.pause": "Pause at end",
    "opt.loop": "Loop",
    "opt.autoDetect": "Auto detect",
    "opt.auto": "Auto",
    "opt.landscape": "Landscape",
    "opt.portrait": "Portrait",
    "opt.ratio43": "4:3",
    "opt.ratio169": "16:9",

    "shortcut.title": "Shortcut Settings",
    "shortcut.hint": "Click a field and press a key to bind; press Esc to cancel.",
    "shortcut.reset": "Reset",

    "sc.togglePlay": "Play / Pause",
    "sc.seekBackward": "Step backward",
    "sc.seekForward": "Step forward",
    "sc.cycleStepBackward": "Shrink step size",
    "sc.cycleStepForward": "Enlarge step size",
    "sc.volumeUp": "Volume up",
    "sc.volumeDown": "Volume down",
    "sc.toggleSubtitle": "Toggle subtitles",
    "sc.insertTimestamp": "Insert timestamp",
    "sc.fullscreen": "Fullscreen",

    "key.space": "Space",
} satisfies Record<string, string>;

export type StringKey = keyof typeof en;

const zhCN: Record<StringKey, string> = {
    "menu.ms": "时间戳包含毫秒",
    "menu.copy": "复制当前时间戳",
    "menu.insert": "插入当前时间戳到队列",
    "menu.playback": "更多播放设置",
    "menu.shortcuts": "快捷键设置",

    "aria.rewind": "向后",
    "aria.step": "切换步长",
    "aria.forward": "向前",
    "aria.speed": "切换播放速度",
    "aria.subtitle": "字幕",

    "step.frame": "帧",
    "step.keyframe": "关键帧",
    "step.5s": "5秒",

    "notice.insertPreviewOnly": "插入时间戳仅支持实时预览模式",
    "notice.noMediaLine": "无法定位媒体源行",
    "notice.inserted": "已插入时间戳 {time}",
    "notice.msOn": "已开启毫秒显示",
    "notice.msOff": "已关闭毫秒显示",
    "notice.copied": "时间戳已复制: {time}",
    "notice.copyFailed": "无法复制时间戳: {time}",

    "sticky.enable": "启用媒体吸附",
    "sticky.disable": "禁用媒体吸附",

    "playback.title": "更多播放设置",
    "playback.mode": "播放方式",
    "playback.modeDesc": "媒体播放结束后的行为",
    "playback.ratio": "视频比例",
    "playback.ratioDesc": "强制画面显示比例（仅对视频生效）",
    "playback.orientation": "屏幕方向",
    "playback.orientationDesc": "横屏 / 竖屏（仅对视频生效，竖屏会限制在页面内）",

    "opt.pause": "播完暂停",
    "opt.loop": "循环播放",
    "opt.autoDetect": "自动识别",
    "opt.auto": "自动",
    "opt.landscape": "横屏",
    "opt.portrait": "竖屏",
    "opt.ratio43": "4:3",
    "opt.ratio169": "16:9",

    "shortcut.title": "快捷键设置",
    "shortcut.hint": "点击输入框后按下新键位完成绑定，按 Esc 取消。",
    "shortcut.reset": "恢复默认",

    "sc.togglePlay": "播放 / 暂停",
    "sc.seekBackward": "后退一步",
    "sc.seekForward": "前进一步",
    "sc.cycleStepBackward": "减小跳转步长",
    "sc.cycleStepForward": "增大跳转步长",
    "sc.volumeUp": "增大音量",
    "sc.volumeDown": "减小音量",
    "sc.toggleSubtitle": "切换字幕",
    "sc.insertTimestamp": "插入时间戳",
    "sc.fullscreen": "全屏",

    "key.space": "空格",
};

const zhTW: Record<StringKey, string> = {
    "menu.ms": "時間戳包含毫秒",
    "menu.copy": "複製目前時間戳",
    "menu.insert": "將目前時間戳插入佇列",
    "menu.playback": "更多播放設定",
    "menu.shortcuts": "快速鍵設定",

    "aria.rewind": "後退",
    "aria.step": "切換步長",
    "aria.forward": "前進",
    "aria.speed": "切換播放速度",
    "aria.subtitle": "字幕",

    "step.frame": "影格",
    "step.keyframe": "關鍵影格",
    "step.5s": "5 秒",

    "notice.insertPreviewOnly": "插入時間戳僅支援即時預覽模式",
    "notice.noMediaLine": "無法定位媒體來源行",
    "notice.inserted": "已插入時間戳 {time}",
    "notice.msOn": "已開啟毫秒顯示",
    "notice.msOff": "已關閉毫秒顯示",
    "notice.copied": "已複製時間戳：{time}",
    "notice.copyFailed": "無法複製時間戳：{time}",

    "sticky.enable": "啟用媒體釘選",
    "sticky.disable": "停用媒體釘選",

    "playback.title": "更多播放設定",
    "playback.mode": "播放方式",
    "playback.modeDesc": "媒體播放結束後的行為",
    "playback.ratio": "視訊比例",
    "playback.ratioDesc": "強制畫面顯示比例（僅對視訊生效）",
    "playback.orientation": "螢幕方向",
    "playback.orientationDesc": "橫向 / 直向（僅對視訊生效，直向會限制在頁面內）",

    "opt.pause": "播完暫停",
    "opt.loop": "循環播放",
    "opt.autoDetect": "自動辨識",
    "opt.auto": "自動",
    "opt.landscape": "橫向",
    "opt.portrait": "直向",
    "opt.ratio43": "4:3",
    "opt.ratio169": "16:9",

    "shortcut.title": "快速鍵設定",
    "shortcut.hint": "點擊輸入框後按下新按鍵即可綁定，按 Esc 取消。",
    "shortcut.reset": "恢復預設",

    "sc.togglePlay": "播放 / 暫停",
    "sc.seekBackward": "後退一步",
    "sc.seekForward": "前進一步",
    "sc.cycleStepBackward": "縮小跳轉步長",
    "sc.cycleStepForward": "放大跳轉步長",
    "sc.volumeUp": "提高音量",
    "sc.volumeDown": "降低音量",
    "sc.toggleSubtitle": "切換字幕",
    "sc.insertTimestamp": "插入時間戳",
    "sc.fullscreen": "全螢幕",

    "key.space": "空格",
};

const DICTS: Record<Locale, Record<StringKey, string>> = {
    en,
    "zh-CN": zhCN,
    "zh-TW": zhTW,
};

let resolved: Locale | null = null;
let override: Locale | null = null;

/** 依据 Obsidian 语言设置判定当前语言 */
function detectLocale(): Locale {
    let lang = "en";
    try {
        lang = (getLanguage() || "en").toLowerCase();
    } catch {
        // 应用尚未就绪时回退英文
    }
    if (lang.startsWith("zh")) {
        return /tw|hk|hant|mo/.test(lang) ? "zh-TW" : "zh-CN";
    }
    return "en";
}

/** 强制指定语言（传 null 恢复自动检测），主要用于测试或手动切换 */
export function setLocale(locale: Locale | null) {
    override = locale;
    resolved = null;
}

/** 取翻译文本，支持 {name} 占位符插值 */
export function t(key: StringKey, vars?: Record<string, string | number>): string {
    if (!resolved) resolved = override ?? detectLocale();
    let text = DICTS[resolved][key] ?? en[key] ?? key;
    if (vars) {
        for (const name in vars) text = text.split(`{${name}}`).join(String(vars[name]));
    }
    return text;
}
