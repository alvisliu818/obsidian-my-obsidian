/**
 * 数据与目录缓存。
 *
 * - 评价/标签/当前筛选：模块数据片（宿主 data.json），写时去抖 800ms——
 *   星星连点、连续加标签不打爆 saveData。
 * - 目录缓存：官方 community-plugins.json 拉回来落在插件目录
 *   `community-catalog.json`（约 2MB，不进 data.json），7 天刷新，离线用旧的。
 *   它提供 repo→id 与 name+author→id 两条反查通道：详情页有 GitHub 仓库链接
 *   （repo 精确匹配），列表卡片只有名字+作者（name+author 匹配，冲突极少）。
 */

import { requestUrl, type App, type PluginManifest } from 'obsidian';
import {
	CATALOG_TTL_MS,
	CATALOG_URL,
	DEFAULT_MARKET_DATA,
	type CatalogEntry,
	type CatalogFile,
	type MarketData,
	type PluginReview,
} from './types';

export class MarketStore {
	data: MarketData = { ...DEFAULT_MARKET_DATA, reviews: {} };
	private saveTimer = 0;
	private catalog: CatalogEntry[] | null = null;
	private catalogLoading: Promise<CatalogEntry[]> | null = null;
	private byRepo = new Map<string, CatalogEntry>();
	private byNameAuthor = new Map<string, CatalogEntry>();
	private allTagsCache: string[] | null = null;

	constructor(
		private readonly app: App,
		private readonly manifest: PluginManifest,
		private readonly loadData: () => Promise<unknown>,
		private readonly saveData: (data: unknown) => Promise<void>,
	) {}

	async load(): Promise<void> {
		const raw = (await this.loadData()) as Partial<MarketData> | null;
		this.data = {
			reviews: raw?.reviews && typeof raw.reviews === 'object' ? raw.reviews : {},
			activeTag: typeof raw?.activeTag === 'string' && raw.activeTag ? raw.activeTag : undefined,
		};
	}

	flush(): void {
		if (this.saveTimer) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = 0;
			void this.saveData(this.data);
		}
	}

	private scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = 0;
			void this.saveData(this.data);
		}, 800);
	}

	reviewOf(pluginId: string): PluginReview | undefined {
		return this.data.reviews[pluginId];
	}

	/** 备注上限（防 data.json 膨胀；超长截断）。 */
	static readonly NOTE_MAX = 2000;

	setNote(pluginId: string, note: string | undefined): void {
		const rec = { ...this.data.reviews[pluginId] } as PluginReview & { rating?: number };
		const text = (note ?? '').replace(/\r\n/g, '\n').trim().slice(0, MarketStore.NOTE_MAX);
		if (text) rec.note = text;
		else delete rec.note;
		// 星级字段已废弃（v1 遗留），写入时顺手清掉
		delete rec.rating;
		if (!rec.note && !rec.tags?.length) delete this.data.reviews[pluginId];
		else {
			rec.updatedAt = Date.now();
			this.data.reviews[pluginId] = rec;
		}
		this.allTagsCache = null;
		this.scheduleSave();
	}

	addTag(pluginId: string, tag: string): void {
		const clean = tag.trim().replace(/\s+/g, ' ').slice(0, 24);
		if (!clean) return;
		const rec = { ...this.data.reviews[pluginId] };
		const tags = rec.tags ? [...rec.tags] : [];
		if (!tags.some((t) => t.toLowerCase() === clean.toLowerCase())) tags.push(clean);
		rec.tags = tags;
		rec.updatedAt = Date.now();
		this.data.reviews[pluginId] = rec;
		this.allTagsCache = null;
		this.scheduleSave();
	}

	removeTag(pluginId: string, tag: string): void {
		const rec = this.data.reviews[pluginId];
		if (!rec?.tags) return;
		const tags = rec.tags.filter((t) => t !== tag);
		if (tags.length) rec.tags = tags;
		else delete rec.tags;
		if (!rec.tags?.length && !rec.note) delete this.data.reviews[pluginId];
		else this.data.reviews[pluginId] = rec;
		this.allTagsCache = null;
		// 当前筛选的标签被删光时连筛选一起撤
		if (this.data.activeTag && !this.allTags().includes(this.data.activeTag)) {
			this.data.activeTag = undefined;
		}
		this.scheduleSave();
	}

	setActiveTag(tag: string | undefined): void {
		this.data.activeTag = tag || undefined;
		this.scheduleSave();
	}

	/** 全部已知标签（按使用次数降序，稳定可用）。 */
	allTags(): string[] {
		if (this.allTagsCache) return this.allTagsCache;
		const count = new Map<string, number>();
		for (const rec of Object.values(this.data.reviews)) {
			for (const t of rec.tags ?? []) count.set(t, (count.get(t) ?? 0) + 1);
		}
		this.allTagsCache = [...count.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([t]) => t);
		return this.allTagsCache;
	}

	// ------------------------------------------------------------------
	// 目录缓存与 id 反查
	// ------------------------------------------------------------------

	/** 目录就绪（内存里建好反查表）；拉取失败静默用旧缓存。 */
	async ensureCatalog(): Promise<CatalogEntry[]> {
		if (this.catalog) return this.catalog;
		if (this.catalogLoading) return this.catalogLoading;
		this.catalogLoading = this.loadCatalog().finally(() => {
			this.catalogLoading = null;
		});
		return this.catalogLoading;
	}

	private async loadCatalog(): Promise<CatalogEntry[]> {
		const path = this.catalogPath();
		try {
			if (await this.app.vault.adapter.exists(path)) {
				const file = JSON.parse(await this.app.vault.adapter.read(path)) as CatalogFile;
				// v2 才认（v1 有 repo 字段被误剥空的 bug，直接重拉）
				if (file.v === 2 && file.plugins?.length) {
					this.adoptCatalog(file.plugins);
					if (Date.now() - file.fetchedAt < CATALOG_TTL_MS) return this.catalog!;
				}
			}
		} catch {
			/* 旧缓存坏了就当没有 */
		}
		try {
			const res = await requestUrl({ url: CATALOG_URL, throw: false });
			if (res.status === 200) {
				const raw = res.json as Array<{ id: string; name: string; author: string; description?: string; repo: string }>;
				const entries: CatalogEntry[] = raw.map((e) => ({
					id: e.id,
					name: e.name,
					author: e.author,
					description: e.description,
					repo: normRepo(e.repo),
				}));
				if (entries.length) {
					this.adoptCatalog(entries);
					await this.app.vault.adapter.write(
						path,
						JSON.stringify({ v: 2, fetchedAt: Date.now(), plugins: entries } satisfies CatalogFile),
					);
				}
			}
		} catch {
			/* 无网络：用旧缓存（可能为空——此时反查通道失效，UI 优雅退化） */
		}
		return this.catalog ?? [];
	}

	/** 装入目录条目并建反查索引（测试也从这里喂规则）。 */
	adoptCatalog(entries: CatalogEntry[]): void {
		this.catalog = entries;
		this.byRepo.clear();
		this.byNameAuthor.clear();
		for (const e of entries) {
			if (e.repo && !this.byRepo.has(e.repo)) this.byRepo.set(e.repo, e);
			const key = `${e.name} ${e.author}`.toLowerCase();
			if (!this.byNameAuthor.has(key)) this.byNameAuthor.set(key, e);
		}
	}

	private catalogPath(): string {
		const dir = this.manifest.dir ?? '.obsidian/plugins/obsidian-my-obsidian';
		return `${dir.replace(/[\\/]+$/, '')}/community-catalog.json`;
	}

	/** GitHub 仓库 URL（详情页的仓库链接）→ 目录条目。 */
	byRepoUrl(url: string): CatalogEntry | undefined {
		return this.byRepo.get(normRepo(url));
	}

	/** 名字+作者（列表卡片只有这两样）→ 目录条目。 */
	lookupNameAuthor(name: string, author: string): CatalogEntry | undefined {
		return this.byNameAuthor.get(`${name} ${author}`.toLowerCase().trim());
	}
}

/**
 * 仓库标识归一化成 "owner/repo"（小写）。两种输入都认：完整 GitHub URL
 * （详情页的仓库链接）与裸 "owner/repo"（官方 community-plugins.json 的
 * repo 字段就是裸的——v1 缓存曾把它当 URL 误剥成空串，教训在 v2 版本号）。
 */
export function normRepo(value: string): string {
	if (!value) return '';
	const m = /github\.com\/([^/]+)\/([^/?#]+)/i.exec(value);
	const repo = m ? `${m[1]}/${m[2]}` : value.split(/[?#]/)[0];
	return repo.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase();
}
