/**
 * 封面懒加载 Hook
 * 
 * 负责管理歌曲封面的懒加载逻辑，包括：
 * - IntersectionObserver 检测可见区域
 * - 并发控制（限制同时加载的封面数量）
 * - 封面缓存（按路径和专辑名称）
 * - 停止加载机制（双击切换页面时停止额外 I/O）
 */

import React from "react";
import { App, TFile } from "obsidian";
import type { ReactTrackInfo } from "@/types";

/**
 * Hook 的输入参数
 */
export interface UseLazyTrackCoversParams {
	/** 要加载封面的歌曲列表 */
	tracks: ReactTrackInfo[];
	/** Obsidian App 实例（用于从路径获取文件） */
	app?: App;
	/** 异步获取歌曲封面的函数（优先文件夹中的 cover 文件，其次内嵌封面） */
	getTrackCover?: (file: TFile) => Promise<string | undefined>;
}

/**
 * Hook 的返回值
 */
export interface UseLazyTrackCoversReturn {
	/** 已加载的封面 URL Map：path → coverUrl */
	embeddedCovers: Map<string, string>;
	/** 每个 track 的 ref Map：path → React.RefObject<HTMLDivElement> */
	trackRefs: Map<string, React.RefObject<HTMLDivElement>>;
	/** 停止加载封面（双击切换页面时调用） */
	stopLoading: () => void;
}

/**
 * 封面懒加载 Hook
 * 
 * 使用 IntersectionObserver 检测可见区域，只加载可见的封面。
 * 支持并发控制、缓存机制和停止加载功能。
 * 
 * @param params Hook 参数
 * @returns Hook 返回值
 */
export function useLazyTrackCovers({
	tracks,
	app,
	getTrackCover,
}: UseLazyTrackCoversParams): UseLazyTrackCoversReturn {
	// 封面缓存：按路径缓存
	const coverCacheRef = React.useRef<Map<string, string>>(new Map());
	// 专辑封面缓存：按专辑名称缓存（同一专辑的歌曲共享封面）
	const albumCoverCacheRef = React.useRef<Map<string, string>>(new Map());
	// 存储异步获取的封面 URL（用于触发重新渲染）
	const [embeddedCovers, setEmbeddedCovers] = React.useState<Map<string, string>>(new Map());
	// 使用 ref 来快速检查封面是否已加载（避免在 callback 中依赖 state）
	const embeddedCoversRef = React.useRef<Map<string, string>>(new Map());
	// 用于跟踪正在加载的封面请求（需要在点击播放后清理）
	const loadingPromisesRef = React.useRef<Set<Promise<void>>>(new Set());
	// 用于标记是否应该停止加载（点击播放后设置；此处仅在双击跳转时使用）
	const shouldStopLoadingRef = React.useRef<boolean>(false);
	// 限制封面加载的并发数量，避免一次触发过多 I/O 导致主线程长时间卡顿
	const MAX_CONCURRENT_COVER_LOADS = 2;
	const activeCoverLoadsRef = React.useRef<number>(0);
	const coverLoadQueueRef = React.useRef<Array<() => void>>([]);
	// 用于存储每个 track 的 ref，用于 Intersection Observer
	const trackRefsRef = React.useRef<Map<string, React.RefObject<HTMLDivElement>>>(new Map());

	// 初始化 track refs
	React.useEffect(() => {
		const refs = trackRefsRef.current;
		// 为新的 tracks 创建 ref
		for (const track of tracks) {
			if (!refs.has(track.path)) {
				refs.set(track.path, React.createRef<HTMLDivElement>());
			}
		}
		// 清理不再存在的 track refs
		const trackPaths = new Set(tracks.map(t => t.path));
		for (const [path] of refs) {
			if (!trackPaths.has(path)) {
				refs.delete(path);
			}
		}
	}, [tracks]);

	// 封面加载调度函数：限制并发加载数量
	const enqueueCoverLoad = React.useCallback((task: () => Promise<void>) => {
		if (shouldStopLoadingRef.current) {
			return;
		}

		const run = () => {
			if (shouldStopLoadingRef.current) {
				return;
			}

			activeCoverLoadsRef.current += 1;
			const p = task();
			loadingPromisesRef.current.add(p);

			void p.finally(() => {
				loadingPromisesRef.current.delete(p);
				activeCoverLoadsRef.current -= 1;

				// 继续执行队列中的下一个任务
				const next = coverLoadQueueRef.current.shift();
				if (next && !shouldStopLoadingRef.current) {
					next();
				}
			});
		};

		if (activeCoverLoadsRef.current < MAX_CONCURRENT_COVER_LOADS) {
			run();
		} else {
			coverLoadQueueRef.current.push(run);
		}
	}, []);

	// 设置 Intersection Observer 来检测可见元素
	// 直接在 Observer 回调中加载封面，避免通过 state 触发，减少 React 渲染开销
	React.useEffect(() => {
		if (!getTrackCover || !app) return;

		const observer = new IntersectionObserver(
			(entries) => {
				// 使用 requestAnimationFrame 批量处理，提升性能
				window.requestAnimationFrame(() => {
					entries.forEach((entry) => {
						if (!entry.isIntersecting || shouldStopLoadingRef.current) return;
						
						const trackElement = entry.target as HTMLElement;
						const trackPath = trackElement.getAttribute('data-track-path');
						if (!trackPath) return;

						// 找到对应的 track
						const track = tracks.find(t => t.path === trackPath);
						if (!track) return;

						// 如果已经有封面，直接更新 state
						if (track.coverUrl) {
							if (!embeddedCoversRef.current.has(trackPath)) {
								embeddedCoversRef.current.set(trackPath, track.coverUrl);
								setEmbeddedCovers(prev => {
									if (prev.has(trackPath)) return prev;
									const next = new Map(prev);
									next.set(trackPath, track.coverUrl!);
									return next;
								});
							}
							observer.unobserve(trackElement);
							return;
						}

						// 检查缓存
						if (coverCacheRef.current.has(trackPath)) {
							const cachedUrl = coverCacheRef.current.get(trackPath);
							if (cachedUrl && !embeddedCoversRef.current.has(trackPath)) {
								embeddedCoversRef.current.set(trackPath, cachedUrl);
								setEmbeddedCovers(prev => {
									if (prev.has(trackPath)) return prev;
									const next = new Map(prev);
									next.set(trackPath, cachedUrl);
									return next;
								});
							}
							observer.unobserve(trackElement);
							return;
						}

						// 如果已经在加载中，跳过
						if (embeddedCoversRef.current.has(trackPath)) {
							observer.unobserve(trackElement);
							return;
						}

						// 优化：如果同一专辑的其他歌曲已经有封面，直接复用
						if (track.album) {
							const albumCover = albumCoverCacheRef.current.get(track.album);
							if (albumCover) {
								coverCacheRef.current.set(trackPath, albumCover);
								embeddedCoversRef.current.set(trackPath, albumCover);
								setEmbeddedCovers(prev => {
									if (prev.has(trackPath)) return prev;
									const next = new Map(prev);
									next.set(trackPath, albumCover);
									return next;
								});
								observer.unobserve(trackElement);
								return;
							}
						}

						// 开始加载封面（通过调度函数，限制并发数量）
						// 标记为正在加载，避免重复请求
						coverCacheRef.current.set(trackPath, "");

						const loadTask = async () => {
							try {
								// 如果此时已经要求停止加载，直接跳过
								if (shouldStopLoadingRef.current) {
									coverCacheRef.current.delete(trackPath);
									return;
								}

								const file = app.vault.getAbstractFileByPath(trackPath);
								if (!file || !(file instanceof TFile)) {
									coverCacheRef.current.delete(trackPath);
									return;
								}

								if (shouldStopLoadingRef.current) {
									coverCacheRef.current.delete(trackPath);
									return;
								}

								const coverUrl = await getTrackCover(file);

								if (shouldStopLoadingRef.current) {
									coverCacheRef.current.delete(trackPath);
									return;
								}

								if (coverUrl) {
									coverCacheRef.current.set(trackPath, coverUrl);
									embeddedCoversRef.current.set(trackPath, coverUrl);
									
									if (track.album) {
										albumCoverCacheRef.current.set(track.album, coverUrl);
									}

									// 只通过 React state 更新，不直接操作 DOM
									setEmbeddedCovers(prev => {
										if (prev.has(trackPath)) return prev;
										const next = new Map(prev);
										next.set(trackPath, coverUrl);
										return next;
									});
								} else {
									coverCacheRef.current.delete(trackPath);
									embeddedCoversRef.current.delete(trackPath);
								}
							} catch (err) {
								if (!shouldStopLoadingRef.current) {
									console.error(`获取封面失败 (${trackPath}):`, err);
								}
								coverCacheRef.current.delete(trackPath);
							}
						};

						enqueueCoverLoad(loadTask);
						
						observer.unobserve(trackElement);
					});
				});
			},
			{
				// 提前 100px 开始加载，提升用户体验
				rootMargin: '100px',
				threshold: 0.01,
			}
		);

		// 使用 requestAnimationFrame 确保 DOM 已经更新
		const rafId = window.requestAnimationFrame(() => {
			// 观察所有 track 元素
			const refs = trackRefsRef.current;
			for (const [, ref] of refs) {
				if (ref.current) {
					observer.observe(ref.current);
				}
			}
		});

		return () => {
			cancelAnimationFrame(rafId);
			observer.disconnect();
		};
		// Note: getTrackCover and app are stable references
	}, [tracks, getTrackCover, app, enqueueCoverLoad]);

	// 停止加载封面
	const stopLoading = React.useCallback(() => {
		shouldStopLoadingRef.current = true;
		loadingPromisesRef.current.clear();
	}, []);

	return {
		embeddedCovers,
		trackRefs: trackRefsRef.current,
		stopLoading,
	};
}

