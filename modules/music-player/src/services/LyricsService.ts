/**
 * 歌词管理服务
 * 
 * 负责管理歌词相关的业务逻辑，包括：
 * - 加载歌词（从插件设置中读取）
 * - 解析歌词（LRC 格式和逐字歌词）
 * - 处理歌词格式转换
 * 
 * 歌词数据存储在插件设置中；音频内仅使用 **LYRICS** 标签存一份原文。
 * 解析时根据内容自动识别逐句（LRC）或逐字（卡拉 OK 时间戳）并分别展示。
 */

import { LyricLine, LyricsParser } from "@/utils/lyrics/parser";
import { ExtendedLyricLine, LyricsExtendedParser } from "@/utils/lyrics/extendedParser";
import { isTimestampedKaraokeLyrics } from "@/utils/lyrics/formatDetection";
import { stripLeadingLyricsMetadata } from "@/utils/lyrics/normalizeLyrics";
import { applyLyricsOffset, parseLyricsOffset, stripLyricsOffsetTags } from "@/utils/lyrics/offset";
import MusicPlayerPlugin from "@/main";
import { getOrCreateTrackId } from "@/utils/track/id";

/**
 * 歌词管理服务类
 * 
 * 提供歌词的加载和解析功能，支持 LRC 格式和逐字歌词格式。
 */
export class LyricsService {
	/**
	 * 创建歌词管理服务实例
	 * 
	 * @param plugin - 插件实例，用于访问设置中的歌词数据
	 */
	constructor(private plugin: MusicPlayerPlugin) {}

	/**
	 * 加载歌词
	 * 
	 * 从插件设置读取曲目 `lyrics` 原文，自动识别逐字或逐句格式后解析。
	 * 
	 * @param trackPath - 音乐文件路径
	 * @returns 包含普通歌词和逐字歌词的对象
	 */
	loadLyrics(trackPath: string): {
		lyrics: LyricLine[];
		extendedLyrics: ExtendedLyricLine[];
	} {
		// 通过路径获取 ID，然后通过 ID 获取 track 信息
		const trackId = getOrCreateTrackId(trackPath, this.plugin.settings);
		const track = this.plugin.settings.tracks[trackId];
		const lyrics: LyricLine[] = [];
		const extendedLyrics: ExtendedLyricLine[] = [];

		const rawLyrics = track?.lyrics && track.lyrics.trim() !== "" ? track.lyrics : "";

		if (!rawLyrics.trim()) {
			return { lyrics, extendedLyrics };
		}

		// [offset:±ms] 是歌词参数：解析后用于整体平移时间轴，但不显示在歌词中
		const offsetSeconds = parseLyricsOffset(rawLyrics);
		const lyricsText = stripLeadingLyricsMetadata(stripLyricsOffsetTags(rawLyrics));
		if (!lyricsText.trim()) {
			return { lyrics, extendedLyrics };
		}

		if (isTimestampedKaraokeLyrics(lyricsText)) {
			const parsed = LyricsExtendedParser.parse(lyricsText);
			if (parsed.length > 0) {
				extendedLyrics.push(...parsed);
			}
		}

		if (extendedLyrics.length === 0) {
			const parsedLyrics = LyricsParser.parseLRC(lyricsText);

			if (parsedLyrics.length > 0) {
				lyrics.push(
					...parsedLyrics.map((line) => ({
						time: line.time,
						text: LyricsParser.cleanText(line.text),
					}))
				);
			} else {
				const lines = lyricsText.split(/\r?\n/).filter((l) => l.trim().length > 0);
				lyrics.push(
					...lines.map((line, index) => ({
						time: index * 3,
						text: LyricsParser.cleanText(line),
					}))
				);
			}
		}

		// 应用偏移（正偏移 = 歌词整体提前）
		applyLyricsOffset(lyrics, extendedLyrics, offsetSeconds);

		return { lyrics, extendedLyrics };
	}
}

