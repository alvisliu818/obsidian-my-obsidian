/**
 * 三行歌词组件
 * 
 * 显示上一行、当前行、下一行歌词，用于唱片页面的歌词显示。
 * 当前行会高亮显示，提供简洁的歌词浏览体验。
 */

import "./LyricsTriplet.css";

/**
 * 三行歌词组件的属性接口
 */
export interface LyricsTripletProps {
	/** 上一行歌词文本 */
	prev?: string;
	/** 当前行歌词文本 */
	current?: string;
	/** 下一行歌词文本 */
	next?: string;
}

/**
 * 三行歌词组件
 * 
 * 显示三行歌词（上一行、当前行、下一行），当前行会高亮显示。
 * 
 * @param props 组件属性
 */
export function LyricsTriplet({ prev = "", current = "", next = "" }: LyricsTripletProps) {
	return (
		<div className="lyrics-triplet">
			<div className="lyric-line-prev">
				<span className="lyric-text">{prev}</span>
			</div>
			<div className="lyric-line-current">
				<span className="lyric-text">{current}</span>
			</div>
			<div className="lyric-line-next">
				<span className="lyric-text">{next}</span>
			</div>
		</div>
	);
}

