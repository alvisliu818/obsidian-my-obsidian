/**
 * LRC 歌词解析器模块
 * 
 * 提供歌词解析和处理功能，支持：
 * - 解析 LRC 格式的歌词文件
 * - 清理歌词文本中的时间标签
 * - 解析时间标签用于卡拉OK效果
 * 
 * LRC 格式示例：
 * [00:12.34]这是第一句歌词
 * [00:15.67]这是第二句歌词
 */

/**
 * 歌词行接口
 * 
 * 表示一行歌词，包含时间和文本信息
 */
export interface LyricLine {
	/** 歌词行的时间点（秒） */
	time: number;
	/** 歌词文本（可能包含时间标签，用于卡拉OK效果） */
	text: string;
}

/**
 * 歌词解析器类
 * 
 * 提供静态方法用于解析和处理歌词文本
 */
export class LyricsParser {
	/**
	 * 解析 LRC 格式的歌词文件
	 * 
	 * 将 LRC 格式的歌词文本解析为歌词行数组。
	 * 支持标准 LRC 格式： [mm:ss.xx]歌词文本
	 * 
	 * @param lrcContent LRC 格式的歌词文本内容
	 * @returns 返回解析后的歌词行数组，按时间排序
	 * 
	 * @example
	 * ```typescript
	 * const lrc = "[00:12.34]这是第一句歌词\n[00:15.67]这是第二句歌词";
	 * const lines = LyricsParser.parseLRC(lrc);
	 * // lines: [
	 * //   { time: 12.34, text: "这是第一句歌词" },
	 * //   { time: 15.67, text: "这是第二句歌词" }
	 * // ]
	 * ```
	 */
	static parseLRC(lrcContent: string): LyricLine[] {
		// 按行分割歌词文本
		const lines = lrcContent.split("\n");
		// 匹配时间标签的正则表达式：[mm:ss.xx]
		const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2})\]/g;
		const lyrics: LyricLine[] = [];

		// 遍历每一行
		lines.forEach((line) => {
			// 查找所有时间标签
			const matches = [...line.matchAll(timeRegex)];
			if (matches.length === 0) {
				return;
			}

			// 提取歌词文本（移除行内时间标签；不 trim，以保留英文词间空格与行内前导空格）
			// 一行内所有时间标签共享同一段文本，只需替换一次
			const text = line.replace(/\[(\d{2}):(\d{2})\.(\d{2})\]/g, "");
			if (text.trim().length === 0) {
				return;
			}

			// 如果一行包含多个时间标签，为每个时间标签创建一条歌词行
			matches.forEach((match) => {
				// 解析时间：分钟、秒、百分秒
				const minutesStr = match[1];
				const secondsStr = match[2];
				const hundredthsStr = match[3];
				if (!minutesStr || !secondsStr || !hundredthsStr) {
					return; // 跳过无效的匹配
				}
				const minutes = parseInt(minutesStr);
				const seconds = parseInt(secondsStr);
				const hundredths = parseInt(hundredthsStr);
				// 转换为秒数
				const time = minutes * 60 + seconds + hundredths / 100;

				lyrics.push({
					time: time,
					text: text,
				});
			});
		});

		// 按时间排序，确保歌词按播放顺序排列
		return lyrics.sort((a, b) => a.time - b.time);
	}

	/**
	 * 清理歌词文本中的时间标签，返回纯文本
	 * 
	 * 移除所有格式的时间标签（方括号和尖括号格式），返回干净的歌词文本。
	 * 用于显示歌词时去除时间标签。
	 * 
	 * @param text 包含时间标签的歌词文本
	 * @returns 返回清理后的纯文本歌词
	 * 
	 * @example
	 * ```typescript
	 * const text = "[00:12.34]这是歌词<00:15.67>更多文本";
	 * const clean = LyricsParser.cleanText(text);
	 * // clean: "这是歌词更多文本"
	 * ```
	 */
	static cleanText(text: string): string {
		return text
			.replace(/\[\d+:\d+\.\d+\]/g, "") // 移除 [mm:ss.xx] 格式的时间标签
			.replace(/\[\d+:\d+\]/g, "") // 移除 [mm:ss] 格式的时间标签
			.replace(/\[.*?\]/g, "") // 移除任何其他方括号内的内容
			.replace(/<\d+:\d+\.\d+>/g, "") // 移除 <mm:ss.xx> 格式的时间标签
			.replace(/<\d+:\d+>/g, "") // 移除 <mm:ss> 格式的时间标签
			.replace(/<.*?>/g, "") // 移除任何其他尖括号内的内容
			.trimEnd(); // 仅去掉行尾空白，保留行首空格
	}
}


