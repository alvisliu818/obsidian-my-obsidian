/**
 * 类型定义统一导出
 * 
 * 集中导出所有类型定义，方便其他模块导入使用。
 * 包括：
 * - 设置相关类型
 * - 播放相关类型
 * - 库相关类型
 * - API 接口类型
 */

// 设置相关类型
export type { MusicPlayerSettings, TrackInfo } from './settings';
export { DEFAULT_SETTINGS } from './settings';
export type { PlayMode } from '../main';

// React 组件相关的类型定义
export type { ReactPlaybackSnapshot } from './playback';
export type { ReactTrackInfo, ReactLibrarySnapshot } from './library';
export type { ReactApi } from './api';

