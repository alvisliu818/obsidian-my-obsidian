/**
 * plugin-market —— 社区插件市场增强。
 *
 * 面向 Obsidian 核心的社区插件市场弹窗（1.15 起总是开成独立弹窗窗口）：
 * 详情顶部区可选中复制（核心把整棵树 user-select:none 了）；详情页可打
 * 1-5 星评分与标签（绑定社区插件 id，存模块数据片）；侧栏按标签筛选列表
 * 卡片，卡片上给评价/标签徽标。
 *
 * 捕获点：市场弹窗不走 workspace window（`window-open` 不触发、`window.open`
 * 也不经过主 realm，实测均空），唯一公开捕获点是 `Modal.prototype.open`——
 * open 返回时 modalEl 已就位，从 `modalEl.ownerDocument` 拿到弹窗文档挂
 * MutationObserver，之后看到 `.modal.mod-community-modal` 就做一次幂等增强
 * （核心重渲染列表/详情后自动补位）。插件 id 由目录缓存反查（官方
 * community-plugins.json：repo→id 精确、名字+作者→id 兜底），缓存放插件
 * 目录独立文件，7 天刷新。
 */

import { Modal, Plugin } from 'obsidian';
import { MarketStore } from './store';
import { enhanceCommunityModal } from './market';

export default class PluginMarketPlugin extends Plugin {
	private store!: MarketStore;
	/**
	 * 最近一次打开的社区市场弹窗实例（Modal.prototype.open 补丁捕获）。
	 * 弹窗实例带 items（id→完整条目,含 downloads/updated）与 itemsVisible
	 * （当前显示顺序）——空壳卡兜底填充靠它精确对号,不用猜。
	 */
	lastCommunityModal: { items?: Record<string, Record<string, unknown>>; itemsVisible?: string[]; sortOrder?: string } | null = null;
	/** 每个弹窗文档的空壳兜底重试计数（key=文档 href）。 */
	private shellRetry = new Map<string, number>();
	/** 每个已观察文档 → 它的 MutationObserver。 */
	private docs = new Map<Document, MutationObserver>();
	/** 每个文档的去抖定时器。 */
	private timers = new Map<Document, number>();
	/** 注入过 <style> 的文档（卸载时摘样式）。 */
	private stylesDocs = new Set<Document>();

	async onload(): Promise<void> {
		this.store = new MarketStore(
			this.app,
			this.manifest,
			() => this.loadData(),
			(data) => this.saveData(data),
		);
		await this.store.load();
		// 目录就绪后整体补一轮增强（首启拉网络的那次错过就补上）
		void this.store.ensureCatalog().then(() => this.refreshAll());

		this.attachWindow(window);
		this.patchModalOpen();
	}

	onunload(): void {
		for (const mo of this.docs.values()) mo.disconnect();
		this.docs.clear();
		for (const t of this.timers.values()) window.clearTimeout(t);
		this.timers.clear();
		for (const doc of new Set<Document>([window.document, ...this.stylesDocs])) {
			doc.getElementById('lgp-mkt-style')?.remove();
		}
		this.stylesDocs.clear();
		this.store.flush();
	}

	/**
	 * 市场弹窗的捕获点：patch 公开 API 的 Modal.prototype.open（唯一可靠钩子，
	 * 见文件头）。open 返回时 modalEl 已就位；弹出若发生在 open 之后（先渲染
	 * 后换 document）由分帧重查兜底。
	 */
	private patchModalOpen(): void {
		const proto = Modal.prototype as unknown as {
			open: (...args: unknown[]) => unknown;
			__lgpMktPatched?: boolean;
		};
		if (proto.__lgpMktPatched) return;
		const orig = proto.open;
		proto.__lgpMktPatched = true;
		const self = this;
		proto.open = function (this: { modalEl?: HTMLElement }, ...args: unknown[]) {
			const result = orig.apply(this, args);
			self.onModalOpen(this);
			return result;
		};
		this.register(() => {
			proto.open = orig;
			delete proto.__lgpMktPatched;
		});
	}

	private onModalOpen(modal: { modalEl?: HTMLElement; items?: Record<string, Record<string, unknown>>; itemsVisible?: string[]; sortOrder?: string }): void {
		// 核心会先在主文档渲染 modal 再把它**搬进弹窗文档**（1.15 市场弹窗是
		// 独立窗口）。此前 class 一匹配就 return,只挂了主文档观察器——弹窗文档
		// 的后续变更（数据到达→填充首批→重排）永远看不到,空壳卡没人兜底
		// （用户实报「没加载过的插件显示空白」的机制）。改为周期重查:每次都
		// attach 当时的 ownerDocument（docs map 去重）并对新文档补一轮增强,
		// 跟随文档迁移直到稳定。
		const seen = new Set<Document>();
		const check = (retries: number): void => {
			const el = modal.modalEl;
			if (el?.classList.contains('mod-community-modal')) {
				// 捕获实例引用（不快照字段——open 时 items 还没加载,填充时活读）
				this.lastCommunityModal = modal;
				const doc = el.ownerDocument;
				if (doc && !seen.has(doc)) {
					seen.add(doc);
					this.attachWindow(doc.defaultView);
					this.timers.delete(doc);
					this.enhanceDoc(doc); // 列表可能已渲染完，观察器看不到过去
				}
			}
			if (retries > 0) window.setTimeout(() => check(retries - 1), 500);
		};
		check(10);
	}

	private attachWindow(win: Window | undefined | null): void {
		if (!win?.document) return;
		const doc = win.document;
		if (this.docs.has(doc)) return;
		const mo = new MutationObserver(() => this.schedule(doc));
		mo.observe(doc.documentElement, { childList: true, subtree: true });
		this.docs.set(doc, mo);
		this.stylesDocs.add(doc);
		this.schedule(doc);
	}

	/** 弹窗/主窗任意 DOM 变化都来一次（去抖 120ms），增强函数自身幂等。 */
	private schedule(doc: Document): void {
		if (this.timers.has(doc)) return;
		this.timers.set(
			doc,
			window.setTimeout(() => {
				this.timers.delete(doc);
				this.enhanceDoc(doc);
			}, 120),
		);
	}

	private enhanceDoc(doc: Document): void {
		const modal = doc.querySelector<HTMLElement>('.modal.mod-community-modal');
		if (!modal) return;
		try {
			enhanceCommunityModal(modal, { store: this.store, lastCommunityModal: this.lastCommunityModal });
		} catch (e) {
			// 核心 DOM 结构变动不应拖垮设置弹窗——增强失败静默跳过
			console.error('[plugin-market] enhance failed', e);
		}
		// 兜底重试：数据在途（目录网络拉取）时首轮 enhance 空手而归——只要还有
		// 空壳就限时补跑（2s × 15 次 ≈ 30s 覆盖慢网;每次真增强都会消掉一批空壳，
		// 空壳清零即停）。观察器是主通道，这里只兜「变更恰好都错过」的窗口。
		const shells = [...modal.querySelectorAll<HTMLElement>('.community-item.tappable')].filter(
			(c) => !c.querySelector('.community-item-name'),
		).length;
		if (shells === 0) return;
		const key = `${doc.location?.href ?? 'main'}`;
		const attempts = (this.shellRetry.get(key) ?? 0) + 1;
		if (attempts > 15) return;
		this.shellRetry.set(key, attempts);
		window.setTimeout(() => {
			if (this.docs.has(doc)) this.enhanceDoc(doc);
		}, 2000);
	}

	/** 目录缓存就绪/热重载后的全量补一轮。 */
	private refreshAll(): void {
		for (const doc of this.docs.keys()) {
			const t = this.timers.get(doc);
			if (t) window.clearTimeout(t);
			this.timers.delete(doc);
			this.enhanceDoc(doc);
		}
	}
}
