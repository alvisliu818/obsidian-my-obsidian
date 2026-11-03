/**
 * 市场弹窗的 DOM 增强——不 patch 任何核心类，纯观察 + 注入：
 *
 *   1. **可选中复制**：市场弹窗整棵树继承 body 的 `user-select: none`，详情
 *      顶部区（名称/下载量/版本/作者/仓库/更新/描述）没有任何元素显式开回
 *      text，所以选不中；README 区因为有 .markdown-rendered 规则能选。样式
 *      修复 = 给 .community-modal-meta 及其后代显式 user-select: text。
 *   2. **评价 + 标签**：注入到 `.community-modal-meta` 里（星星 1-5 + 标签
 *      chips + 输入框），绑定到目录缓存反查出的插件 id。
 *   3. **按标签筛选**：侧栏搜索区下方注入「我的标签」chips；激活后把不匹配
 *      的 .community-item 卡片 display:none（核心重渲染列表后由观察器重套）。
 *
 * id 反查通道（见 store.ts）：详情页用 GitHub 仓库链接（精确），列表卡片用
 * 名字+作者（目录匹配，冲突极少）。反查失败 = 无标签无筛选，优雅退化。
 */

import type { MarketStore } from './store';

interface EnhanceCtx {
	store: MarketStore;
}

/** 每个文档只注入一次的样式：可选中修复 + 增强块外观。 */
const STYLE_ID = 'lgp-mkt-style';
const STYLE_CSS = `
.community-modal-info .community-modal-meta,
.community-modal-info .community-modal-meta * {
  user-select: text !important;
  -webkit-user-select: text !important;
}
.community-modal-info .community-modal-meta button,
.community-modal-info .community-modal-meta a {
  user-select: none !important;
  -webkit-user-select: none !important;
}
.lgp-mkt-block {
  border-top: 1px solid var(--background-modifier-border);
  margin-top: 10px;
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lgp-mkt-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lgp-mkt-label { color: var(--text-muted); font-size: var(--font-ui-small); flex: 0 0 auto; }
.lgp-mkt-star {
  cursor: pointer; border: none; background: none; padding: 0 2px;
  color: var(--text-faint); font-size: 18px; line-height: 1;
}
.lgp-mkt-star.is-on { color: var(--color-accent); }
.lgp-mkt-star:hover { color: var(--color-accent-hover, var(--color-accent)); }
.lgp-mkt-clear {
  cursor: pointer; border: none; background: none; color: var(--text-faint);
  font-size: var(--font-ui-small); padding: 0 4px;
}
.lgp-mkt-clear:hover { color: var(--text-normal); }
.lgp-mkt-chip {
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 999px; padding: 1px 8px;
  font-size: var(--font-ui-smaller); cursor: pointer;
  background: var(--background-secondary); color: var(--text-normal);
}
.lgp-mkt-chip:hover { border-color: var(--background-modifier-border-hover); }
.lgp-mkt-chip.is-active {
  background: var(--color-accent); color: var(--text-on-accent);
  border-color: transparent;
}
.lgp-mkt-chip.is-active .lgp-mkt-chip-x { color: var(--text-on-accent); }
.lgp-mkt-chip-x { opacity: 0.55; cursor: pointer; font-size: 12px; padding: 0 1px; }
.lgp-mkt-chip-x:hover { opacity: 1; }
.lgp-mkt-input {
  width: 140px; font-size: var(--font-ui-smaller);
  background: var(--background-primary); color: var(--text-normal);
  border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s, 4px);
  padding: 2px 8px;
}
.lgp-mkt-input:focus { border-color: var(--color-accent); outline: none; }
.lgp-mkt-filter { padding: 6px 2px 2px; border-top: 1px solid var(--background-modifier-border); margin-top: 6px; }
.lgp-mkt-status { font-size: var(--font-ui-smaller); color: var(--text-muted); }
.lgp-mkt-badge {
  display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;
  font-size: var(--font-ui-smaller); color: var(--text-muted);
  padding: 2px 4px 0;
}
.lgp-mkt-badge .lgp-mkt-badge-star { color: var(--color-accent); font-weight: 600; }
`;

export function ensureMarketStyles(doc: Document): void {
	if (doc.getElementById(STYLE_ID)) return;
	const style = doc.createElement('style');
	style.id = STYLE_ID;
	style.textContent = STYLE_CSS;
	doc.head.appendChild(style);
}

/** 市场弹窗的一次增强：过滤块 + 详情块 + 卡片筛选/徽标。全部幂等。 */
export function enhanceCommunityModal(modal: HTMLElement, ctx: EnhanceCtx): void {
	ensureMarketStyles(modal.ownerDocument);
	enhanceControls(modal, ctx);
	enhanceDetail(modal, ctx);
	applyFilter(modal, ctx);
}

// ---------------------------------------------------------------------------
// 侧栏：我的标签 chips + 筛选状态
// ---------------------------------------------------------------------------

function enhanceControls(modal: HTMLElement, ctx: EnhanceCtx): void {
	const controls = modal.querySelector('.community-modal-controls');
	if (!controls) return;
	let block = controls.querySelector<HTMLElement>('.lgp-mkt-filter');
	if (!block) {
		block = modal.ownerDocument.createElement('div');
		block.className = 'lgp-mkt-filter';
		// 插在搜索摘要下面（核心把摘要放在 controls 末尾）
		controls.appendChild(block);
	}
	const tags = ctx.store.allTags();
	const active = ctx.store.data.activeTag;
	block.empty();
	const label = block.createDiv({ cls: 'lgp-mkt-row' });
	label.createSpan({ cls: 'lgp-mkt-label', text: '我的标签' });
	if (!tags.length) {
		label.createSpan({ cls: 'lgp-mkt-status', text: '（还没有标签——在详情页给插件打上）' });
		return;
	}
	for (const tag of tags) {
		const chip = label.createSpan({
			cls: 'lgp-mkt-chip' + (active === tag ? ' is-active' : ''),
			text: tag,
		});
		chip.addEventListener('click', () => {
			ctx.store.setActiveTag(active === tag ? undefined : tag);
			enhanceCommunityModal(modal, ctx); // 重画 chips + 重套筛选
		});
	}
	if (active) {
		const clear = label.createSpan({ cls: 'lgp-mkt-clear', text: '清除筛选 ✕' });
		clear.addEventListener('click', () => {
			ctx.store.setActiveTag(undefined);
			enhanceCommunityModal(modal, ctx);
		});
	}
	const status = block.createDiv({ cls: 'lgp-mkt-status' });
	if (active) {
		const shown = countMatchingCards(modal, ctx);
		status.textContent = `按标签「${active}」筛选：显示 ${shown.matched} / ${shown.total} 个插件`;
	}
}

// ---------------------------------------------------------------------------
// 详情页：评分 + 标签编辑
// ---------------------------------------------------------------------------

function enhanceDetail(modal: HTMLElement, ctx: EnhanceCtx): void {
	const info = modal.querySelector('.community-modal-info');
	if (!info) return;
	const meta = info.querySelector('.community-modal-meta');
	if (!meta) return;
	const id = idFromDetail(info as HTMLElement, ctx);
	let block = meta.querySelector<HTMLElement>('.lgp-mkt-block');
	if (block && block.dataset['lgpId'] === (id ?? '')) return; // 已就位且是同一插件
	if (block) block.remove();
	block = meta.ownerDocument!.createElement('div');
	block.className = 'lgp-mkt-block';
	block.dataset['lgpId'] = id ?? '';
	renderDetailBlock(block as HTMLElement, id, ctx);
	meta.appendChild(block);
}

function renderDetailBlock(block: HTMLElement, id: string | null, ctx: EnhanceCtx): void {
	const doc = block.ownerDocument!;
	block.empty();
	if (!id) {
		block.createSpan({
			cls: 'lgp-mkt-status',
			text: '（目录缓存未就绪或未收录——稍等片刻或等下次联网刷新后重开）',
		});
		return;
	}
	const rec = ctx.store.reviewOf(id);

	// —— 评分行 ——
	const rateRow = block.createDiv({ cls: 'lgp-mkt-row' });
	rateRow.createSpan({ cls: 'lgp-mkt-label', text: '评分' });
	for (let i = 1; i <= 5; i++) {
		const star = doc.createElement('button');
		star.className = 'lgp-mkt-star' + (rec?.rating && i <= rec.rating ? ' is-on' : '');
		star.textContent = '★';
		star.title = `${i} 星`;
		star.addEventListener('click', () => {
			// 点当前星级 = 取消评分
			ctx.store.setRating(id, rec?.rating === i ? undefined : i);
			renderDetailBlock(block, id, ctx);
			refreshAround(block, ctx);
		});
		rateRow.appendChild(star);
	}
	if (rec?.rating) {
		const clear = rateRow.createSpan({ cls: 'lgp-mkt-clear', text: '清除' });
		clear.title = '取消评分';
		clear.addEventListener('click', () => {
			ctx.store.setRating(id, undefined);
			renderDetailBlock(block, id, ctx);
			refreshAround(block, ctx);
		});
	}

	// —— 标签行 ——
	const tagRow = block.createDiv({ cls: 'lgp-mkt-row' });
	tagRow.createSpan({ cls: 'lgp-mkt-label', text: '标签' });
	for (const tag of rec?.tags ?? []) {
		const chip = tagRow.createSpan({ cls: 'lgp-mkt-chip', text: tag });
		chip.title = '点击按此标签筛选列表';
		const x = doc.createElement('span');
		x.className = 'lgp-mkt-chip-x';
		x.textContent = '✕';
		x.title = '移除这个标签';
		x.addEventListener('click', (ev) => {
			ev.stopPropagation();
			ctx.store.removeTag(id, tag);
			renderDetailBlock(block, id, ctx);
			refreshAround(block, ctx);
		});
		chip.appendChild(x);
		chip.addEventListener('click', () => {
			ctx.store.setActiveTag(tag);
			refreshAround(block, ctx);
		});
	}
	const input = doc.createElement('input');
	input.className = 'lgp-mkt-input';
	input.placeholder = '添加标签，回车确认';
	input.addEventListener('keydown', (ev) => {
		if ((ev as KeyboardEvent).key === 'Enter') {
			ev.preventDefault();
			const v = (input as HTMLInputElement).value;
			if (v.trim()) {
				ctx.store.addTag(id, v);
				renderDetailBlock(block, id, ctx);
				refreshAround(block, ctx);
			}
		}
	});
	tagRow.appendChild(input);
}

/** 详情块变化后连带重画：所在弹窗的筛选块 + 卡片筛选（新标签可能改变筛选集）。 */
function refreshAround(block: HTMLElement, ctx: EnhanceCtx): void {
	const modal = block.closest('.modal.mod-community-modal');
	if (modal) enhanceCommunityModal(modal as HTMLElement, ctx);
}

// ---------------------------------------------------------------------------
// 卡片：筛选 + 徽标
// ---------------------------------------------------------------------------

function cardId(card: HTMLElement, ctx: EnhanceCtx): string | null {
	const name = card.querySelector('.community-item-name')?.textContent?.trim() ?? '';
	const authorRaw = card.querySelector('.community-item-author')?.textContent?.trim() ?? '';
	const author = authorRaw.replace(/^(?:作者|by)\s*[：:]\s*/i, '');
	const entry = ctx.store.lookupNameAuthor(name, author);
	return entry?.id ?? null;
}

function idFromDetail(info: HTMLElement, ctx: EnhanceCtx): string | null {
	// 仓库链接最可靠
	const repoAnchor = info.querySelector<HTMLAnchorElement>(
		'.community-modal-info-repo a[href*="github.com"]',
	);
	if (repoAnchor) {
		const entry = ctx.store.byRepoUrl(repoAnchor.href);
		if (entry) return entry.id;
	}
	// 兜底：名字+作者
	const name = info.querySelector('.community-modal-info-name')?.textContent?.trim() ?? '';
	const authorRaw =
		info.querySelector('.community-modal-info-author')?.textContent?.trim() ?? '';
	const author = authorRaw.replace(/^(?:作者|by)\s*[：:]\s*/i, '');
	return ctx.store.lookupNameAuthor(name, author)?.id ?? null;
}

function countMatchingCards(modal: HTMLElement, ctx: EnhanceCtx): { matched: number; total: number } {
	const tag = ctx.store.data.activeTag;
	let matched = 0;
	let total = 0;
	for (const card of modal.querySelectorAll<HTMLElement>('.community-item.tappable')) {
		total++;
		const id = cardId(card, ctx);
		if (id && ctx.store.reviewOf(id)?.tags?.includes(tag ?? '')) matched++;
	}
	return { matched, total };
}

function applyFilter(modal: HTMLElement, ctx: EnhanceCtx): void {
	const doc = modal.ownerDocument;
	if (!doc) return;
	const tag = ctx.store.data.activeTag;
	for (const card of modal.querySelectorAll<HTMLElement>('.community-item.tappable')) {
		const id = cardId(card, ctx);
		const review = id ? ctx.store.reviewOf(id) : undefined;
		// 筛选
		const match = !tag || (!!id && !!review?.tags?.includes(tag));
		card.style.display = match ? '' : 'none';
		// 徽标（有评价或标签才画；先清旧的防重复/防陈旧）
		card.querySelector('.lgp-mkt-badge')?.remove();
		if (review && (review.rating || review.tags?.length)) {
			const badge = doc.createElement('div');
			badge.className = 'lgp-mkt-badge';
			if (review.rating) {
				const s = doc.createElement('span');
				s.className = 'lgp-mkt-badge-star';
				s.textContent = `★ ${review.rating}`;
				badge.appendChild(s);
			}
			for (const t of (review.tags ?? []).slice(0, 3)) {
				const c = doc.createElement('span');
				c.textContent = `#${t}`;
				badge.appendChild(c);
			}
			card.appendChild(badge);
		}
	}
}
