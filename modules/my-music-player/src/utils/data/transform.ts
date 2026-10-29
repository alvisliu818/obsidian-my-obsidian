/**
 * 数据工具模块
 * 
 * 提供数据处理相关的工具函数，主要用于：
 * - 从曲目数据生成艺术家和专辑的映射关系
 */

import type { MusicPlayerSettings } from '@/types';

/**
 * 从曲目数据生成艺术家和专辑的映射关系
 * 
 * 遍历所有曲目，根据每首曲目的艺术家和专辑信息，
 * 生成两个映射表：
 * - artists: 艺术家名称 -> 该艺术家的所有曲目 ID 数组
 * - albums: 专辑名称 -> 该专辑的所有曲目 ID 数组
 * 
 * @param settings 音乐播放器设置对象，包含所有曲目数据
 * @returns 返回包含 artists 和 albums 两个映射表的对象
 * 
 * @example
 * ```typescript
 * const { artists, albums } = generateArtistsAndAlbums(settings);
 * // artists: { "周杰伦": ["trackId1", "trackId2"], ... }
 * // albums: { "范特西": ["trackId1", ...], ... }
 * ```
 */
export function generateArtistsAndAlbums(settings: MusicPlayerSettings) {
    // 初始化艺术家映射表：艺术家名称 -> 曲目 ID 数组
    const artists: Record<string, string[]> = {};
    // 初始化专辑映射表：专辑名称 -> 曲目 ID 数组
    const albums: Record<string, string[]> = {};

    // 遍历所有曲目，建立艺术家和专辑的映射关系
    Object.entries(settings.tracks).forEach(([trackId, track]) => {
        const trackData = track;
        const artist = (trackData.artist ?? "").trim();
        const album = (trackData.album ?? "").trim();

        // 更新艺术家映射表
        // 如果该艺术家还不存在，创建新的数组
        if (!artists[artist]) {
            artists[artist] = [];
        }
        // 如果该曲目 ID 还未添加到该艺术家的列表中，则添加
        const artistTracks = artists[artist];
        if (artistTracks && !artistTracks.includes(trackId)) {
            artistTracks.push(trackId);
        }

        // 更新专辑映射表
        // 如果该专辑还不存在，创建新的数组
        if (!albums[album]) {
            albums[album] = [];
        }
        // 如果该曲目 ID 还未添加到该专辑的列表中，则添加
        const albumTracks = albums[album];
        if (albumTracks && !albumTracks.includes(trackId)) {
            albumTracks.push(trackId);
        }
    });

    return { artists, albums };
}
