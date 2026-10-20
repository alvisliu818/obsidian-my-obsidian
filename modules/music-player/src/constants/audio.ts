/**
 * 音频相关常量定义
 */

/** 支持的音频文件格式 */
export const SUPPORTED_AUDIO_FORMATS = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'] as const;

/**
 * 判断扩展名是否为支持的音频格式（不区分大小写）。
 * @param ext 扩展名，可带或不带前导点（如 `mp3`、`.mp3`）；参数为 `unknown` 以兼容 `TFile.extension` 在部分类型下的 `any`
 */
export function isSupportedAudioExtension(ext: unknown): boolean {
	const raw = typeof ext === "string" ? ext : "";
	const lower = raw.toLowerCase();
	const normalized: string = lower.startsWith(".") ? lower : `.${lower}`;
	return (SUPPORTED_AUDIO_FORMATS as readonly string[]).includes(normalized);
}

/** 默认音量值（0.0 - 1.0） */
export const DEFAULT_VOLUME = 1.0;

/** 默认播放速度（1.0 为正常速度） */
export const DEFAULT_PLAYBACK_RATE = 1.0;

/** 支持的图片文件扩展名（用于封面查找） */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'] as const;

