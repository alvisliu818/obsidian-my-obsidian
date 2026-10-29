/**
 * UI 相关常量定义
 */

/** 页面类型 */
export const PAGE_TYPES = {
	LIBRARY: 'library',
	DISC: 'disc',
	LYRICS: 'lyrics',
} as const;

export type PageType = typeof PAGE_TYPES[keyof typeof PAGE_TYPES];

/** 标签页类型 */
export const TAB_TYPES = {
	FAVORITES: 'favorites',
	ALL: 'all',
	PLAYLISTS: 'playlists',
	ARTISTS: 'artists',
	ALBUMS: 'albums',
} as const;

export type TabType = typeof TAB_TYPES[keyof typeof TAB_TYPES];

/** 动画时间常量（单位：毫秒） */
export const ANIMATION_TIMINGS = {
	/** DOM 更新延迟时间，用于确保 DOM 渲染完成后再触发动画 */
	DOM_UPDATE_DELAY: 20,
	/** 唱片滑动动画时长 */
	DISC_ANIMATION_DURATION: 500,
	/** 唱片动画完成后的缓冲时间 */
	DISC_ANIMATION_BUFFER: 50,
	/** 唱针 transition 动画时长（与 CSS 中的 transition 时间一致） */
	NEEDLE_TRANSITION_DURATION: 300,
	/** 唱针延迟时间（比唱片慢的时间） */
	NEEDLE_DELAY: 150,
} as const;

