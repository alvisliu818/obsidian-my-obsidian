/**
 * 曲目标题头部组件的属性接口
 */
export interface TrackHeaderProps {
	/** 歌曲标题 */
	title: string;
	/** 艺术家名称 */
	artist: string;
}

/**
 * 曲目标题头部组件
 * 
 * 显示歌曲的标题和艺术家信息，始终居中显示。
 * 
 * @param props 组件属性
 */
export function TrackHeader({ title, artist }: TrackHeaderProps) {
	return (
		<div className="track-header">
			<h2 className="track-title">{title}</h2>
			<div className="artist-name">{artist}</div>
		</div>
	);
}

