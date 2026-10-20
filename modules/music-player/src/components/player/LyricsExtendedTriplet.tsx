/**
 * 逐字时间歌词三行组件
 * 
 * 显示逐字时间歌词的三行（上一行、当前行、下一行），支持逐字高亮的卡拉OK效果。
 * 当前行会逐字高亮显示，非当前行显示完整文字。
 */

import React from "react";
import "./LyricsExtendedTriplet.css";
import type { ExtendedLyricLine } from "@/utils/lyrics/extendedParser";
import { linearFillProgress } from "@/utils/lyrics/charFillProgress";
import { buildKaraokeUnits } from "@/utils/lyrics/karaokeUnits";

/**
 * 逐字时间歌词三行组件的属性接口
 */
export interface LyricsExtendedTripletProps {
	/** 上一行逐字歌词 */
	prev?: ExtendedLyricLine;
	/** 当前行逐字歌词 */
	current?: ExtendedLyricLine;
	/** 下一行逐字歌词 */
	next?: ExtendedLyricLine;
	/** 当前播放时间（秒），用于计算逐字高亮进度 */
	currentTime: number;
}

/**
 * 单行歌词组件的属性接口（内部使用）
 */
interface LineComponentProps {
	line?: ExtendedLyricLine;
	currentTime: number;
	isCurrent: boolean;
}

const LineComponent = React.memo(({ line, currentTime, isCurrent }: LineComponentProps) => {
	if (!line) {
		return <span className="lyric-text"></span>;
	}

	const unitsData = React.useMemo(() => {
		if (!isCurrent || !line.chars.length) return [];
		return buildKaraokeUnits(line.chars, line);
	}, [line, isCurrent]);

	// 对于非当前行，显示完整文字（不需要逐字效果）
	if (!isCurrent) {
		return (
			<span className="lyrics-extended-triplet-text lyrics-extended-triplet-plain">
				{line.text}
			</span>
		);
	}

	// 当前行：从左向右揭示高亮（clip + width，避免 scaleX 拉伸拉丁字母）
	return (
		<div className="lyrics-extended-triplet-text lyrics-extended-triplet-karaoke">
			{unitsData.map(({ text, charTime, charEndTime }, unitIndex) => {
				const fillProgress = linearFillProgress(currentTime, charTime, charEndTime);
				const isWs = text.length === 1 && /\s/.test(text);
				const isWordUnit =
					!isWs && text.length > 1 && /^[A-Za-z0-9'-]+$/.test(text);

				return (
					<span
						key={unitIndex}
						className={`lyrics-extended-triplet-char${isWs ? " is-ws" : ""}${
							isWordUnit ? " is-word-unit" : ""
						}`}
					>
						<span className="lyrics-extended-triplet-char-bg">{text}</span>
						<span
							className="lyrics-extended-triplet-char-fill-clip"
							style={{ width: `${fillProgress * 100}%` }}
						>
							<span className="lyrics-extended-triplet-char-fill">{text}</span>
						</span>
					</span>
				);
			})}
		</div>
	);
}, (prevProps, nextProps) => {
	if (prevProps.line !== nextProps.line) return false;
	if (prevProps.isCurrent !== nextProps.isCurrent) return false;
	if (prevProps.isCurrent && prevProps.currentTime !== nextProps.currentTime) return false;
	return true;
});

LineComponent.displayName = 'LineComponent';

/**
 * 逐字时间歌词三行组件
 * 
 * 显示三行逐字时间歌词，当前行支持逐字高亮的卡拉OK效果。
 * 
 * @param props 组件属性
 */
export function LyricsExtendedTriplet({ 
	prev, 
	current, 
	next, 
	currentTime 
}: LyricsExtendedTripletProps) {
	return (
		<div className="lyrics-triplet">
			<div className="lyric-line-prev">
				<LineComponent line={prev} currentTime={currentTime} isCurrent={false} />
			</div>
			<div className="lyric-line-current">
				<LineComponent line={current} currentTime={currentTime} isCurrent={true} />
			</div>
			<div className="lyric-line-next">
				<LineComponent line={next} currentTime={currentTime} isCurrent={false} />
			</div>
		</div>
	);
}

