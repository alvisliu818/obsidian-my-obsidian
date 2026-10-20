/**
 * 逐字时间歌词解析器模块
 * 
 * 提供逐字时间歌词解析功能，支持：
 * - 解析包含逐字时间标签的歌词（LYRICS 标签内嵌的卡拉 OK 文本）
 * - 解析格式：<mm:ss.xx>字 或 [mm:ss.xx]字
 * - 用于实现卡拉OK逐字高亮效果
 * 
 * 逐字时间歌词格式示例：
 * [00:12.34]这<00:12.45>是<00:12.56>歌<00:12.67>词
 * 或
 * <00:12.34>这<00:12.45>是<00:12.56>歌<00:12.67>词
 */

/**
 * 逐字歌词字符接口
 * 表示一个字符及其对应的时间点
 */
export interface ExtendedLyricChar {
	/** 字符内容 */
	char: string;
	/** 该字符的时间点（秒） */
	time: number;
}

/**
 * 逐字歌词行接口
 * 表示一行逐字歌词，包含行时间和字符数组
 */
export interface ExtendedLyricLine {
	/** 歌词行的时间点（秒） */
	time: number;
	/** 该行的逐字字符数组 */
	chars: ExtendedLyricChar[];
	/** 该行的纯文本（用于显示） */
	text: string;
	/**
	 * 本行歌词中出现的所有时间戳（行首 + 每个逐字标签），升序去重。
	 * 用于计算每个字/词的高亮结束时间：取严格大于该字开始时间的下一个时间戳。
	 */
	lineTimeStamps: readonly number[];
}

/**
 * 逐字歌词解析器类
 * 
 * 提供静态方法用于解析逐字时间歌词文本
 */
export class LyricsExtendedParser {
	/**
	 * 解析逐字时间歌词文本
	 * 
	 * 将包含逐字时间标签的歌词文本解析为逐字歌词行数组。
	 * 支持格式：
	 * - [mm:ss.xx]字<mm:ss.xx>字（行时间标签 + 逐字时间标签）
	 * - <mm:ss.xx>字<mm:ss.xx>字（只有逐字时间标签）
	 * 
	 * @param extendedContent 逐字时间歌词文本内容
	 * @returns 返回解析后的逐字歌词行数组，按时间排序
	 * 
	 * @example
	 * ```typescript
	 * const extended = "[00:12.34]这<00:12.45>是<00:12.56>歌<00:12.67>词";
	 * const lines = LyricsExtendedParser.parse(extended);
	 * ```
	 */
	static parse(extendedContent: string): ExtendedLyricLine[] {
		if (!extendedContent || !extendedContent.trim()) {
			return [];
		}

		const lines: ExtendedLyricLine[] = [];
		// 按行分割歌词文本
		const textLines = extendedContent.split(/\r?\n/);

		// 匹配行时间标签的正则表达式：[mm:ss.xx]
		const lineTimeRegex = /\[(\d{2}):(\d{2})\.(\d{2})\]/;
		// 匹配逐字时间标签的正则表达式：<mm:ss.xx> 或 [mm:ss.xx]
		const charTimeRegex = /[<[](\d{2}):(\d{2})\.(\d{2})[>\]]/g;

		const parseTagToSeconds = (m: RegExpMatchArray): number | null => {
			const minutesStr = m[1];
			const secondsStr = m[2];
			const hundredthsStr = m[3];
			if (!minutesStr || !secondsStr || !hundredthsStr) return null;
			const minutes = parseInt(minutesStr);
			const seconds = parseInt(secondsStr);
			const hundredths = parseInt(hundredthsStr);
			return minutes * 60 + seconds + hundredths / 100;
		};

		textLines.forEach((line) => {
			if (!line.trim()) return;

			// 查找行时间标签
			const lineTimeMatch = line.match(lineTimeRegex);
			let lineTime = 0;
			
			if (lineTimeMatch) {
				// 解析行时间：分钟、秒、百分秒
				const minutesStr = lineTimeMatch[1];
				const secondsStr = lineTimeMatch[2];
				const hundredthsStr = lineTimeMatch[3];
				if (minutesStr && secondsStr && hundredthsStr) {
					const minutes = parseInt(minutesStr);
					const seconds = parseInt(secondsStr);
					const hundredths = parseInt(hundredthsStr);
					lineTime = minutes * 60 + seconds + hundredths / 100;
				}
			}

			// 移除行时间标签，只保留逐字时间标签和文本
			let processedLine = line.replace(lineTimeRegex, "");

			const stampSet = new Set<number>();
			if (lineTime > 0) {
				stampSet.add(lineTime);
			}

			// 解析逐字时间标签
			const chars: ExtendedLyricChar[] = [];
			const matches = [...processedLine.matchAll(charTimeRegex)];
			for (const m of matches) {
				const t = parseTagToSeconds(m);
				if (t !== null) stampSet.add(t);
			}

			if (matches.length === 0) {
				// 如果没有逐字时间标签，将整行文本作为单个字符组（不 trim 行内容，保留空格）
				if (processedLine.trim().length > 0) {
					for (const char of processedLine) {
						chars.push({ char, time: lineTime });
					}
				}
			} else {
				// 有逐字时间标签，解析每个字符的时间
				let lastIndex = 0;
				let lastTime = lineTime;

				matches.forEach((match) => {
					const time = parseTagToSeconds(match);
					if (time === null) {
						return;
					}

					// 获取当前时间标签之前的文本
					const matchIndex = match.index ?? 0;
					const beforeText = processedLine.substring(lastIndex, matchIndex);

					// 将文本分割为字符，每个字符都关联上一个时间标签的时间
					for (const char of beforeText) {
						chars.push({ char, time: lastTime });
					}

					// 更新索引和时间
					const matchLength = match[0]?.length ?? 0;
					lastIndex = matchIndex + matchLength;
					lastTime = time;
				});

				// 处理最后一个时间标签之后的文本
				const remainingText = processedLine.substring(lastIndex);
				for (const char of remainingText) {
					chars.push({ char, time: lastTime });
				}
			}

			const lineTimeStamps = [...stampSet].sort((a, b) => a - b);

			// 如果解析出字符，添加到结果中
			if (chars.length > 0) {
				// 生成纯文本（移除所有时间标签）
				const text = chars.map((c) => c.char).join("");

				// 如果没有行时间，使用第一个字符的时间作为行时间
				const finalLineTime = lineTime > 0 ? lineTime : (chars[0]?.time || 0);

				lines.push({
					time: finalLineTime,
					chars,
					text,
					lineTimeStamps,
				});
			}
		});

		// 按时间排序，确保歌词按播放顺序排列
		return lines.sort((a, b) => a.time - b.time);
	}
}

