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
	/** 弹窗实例捕获（main.ts onModalOpen）——空壳卡填充的精确数据源 */
	lastCommunityModal: {
		items?: Record<string, Record<string, unknown>>;
		itemsVisible?: string[];
		sortOrder?: string;
	} | null;
}

/** 每个文档只注入一次的样式：可选中修复 + 增强块外观。 */
const STYLE_ID = 'lgp-mkt-style';
const STYLE_CSS = `
.community-modal-info .community-modal-meta,
.community-modal-info .community-modal-meta * {
  user-select: text !important;
  -webkit-user-select: text !important;
}
.community-modal-info .community-modal-meta button {
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
.lgp-mkt-note-row { align-items: flex-start; }
.lgp-mkt-note-wrap { flex: 1 1 auto; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.lgp-mkt-note {
  width: 100%; min-height: 44px; resize: vertical;
  background: var(--background-primary); color: var(--text-normal);
  border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s, 4px);
  padding: 4px 8px; font-size: var(--font-ui-smaller); line-height: 1.4;
}
.lgp-mkt-note:focus { border-color: var(--color-accent); outline: none; }
.lgp-mkt-badge-note { color: var(--text-muted); }
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

/** 市场弹窗的一次增强：过滤块 + 详情块 + 卡片筛选/徽标 + 空壳卡兜底填充。 */
export function enhanceCommunityModal(modal: HTMLElement, ctx: EnhanceCtx): void {
	ensureMarketStyles(modal.ownerDocument);
	enhanceControls(modal, ctx);
	enhanceDetail(modal, ctx);
	applyFilter(modal, ctx);
	fillShellCards(modal, ctx);
}

// ---------------------------------------------------------------------------
// 弹窗市场空壳卡兜底填充（核心 1.15 bug 的补偿）
//
// 实测（2026-11-19，弹窗市场为独立窗口）：核心把目录全量渲染成
// .community-item.tappable 空壳（10563 张，无任何身份属性），只有首批 ~31 张
// 填了内容；滚容器/滚文档/显式 scroll 事件都触发不了继续填充（A/B 排除本
// 插件，禁用后依旧）——用户看到的就是「没加载过的插件一片空白」。
// 空壳没有身份信息，但实例的 itemsVisible 是条目对象数组（按当前显示顺序），
// 第 i 张卡 = itemsVisible[i]，精确对号；对象上还带核心预渲染的
// nameEl/authorEl/descEl，直接搬进壳里。核心后续自己填充时数据源相同无冲突。
// ---------------------------------------------------------------------------

function fillShellCards(modal: HTMLElement, ctx: EnhanceCtx): void {
	const doc = modal.ownerDocument;
	if (!doc) return;
	const cards = [...doc.querySelectorAll<HTMLElement>('.community-item.tappable')];
	const shells = cards.filter((c) => !c.querySelector('.community-item-name')?.textContent?.trim());
	if (!shells.length) return; // 没有空壳（核心填充正常）——无事可做
	// 精确数据源：弹窗实例的 itemsVisible——注意它是【条目对象数组】（不是 id
	// 数组），第 i 个对象就带 name/author/description/downloads/updated 与核心
	// 预渲染的 nameEl/authorEl/descEl。补丁在 onModalOpen 捕获实例（main.ts）。
	const inst = ctx.lastCommunityModal;
	const visible = inst?.itemsVisible;
	if (!Array.isArray(visible) || !visible.length) return; // 没数据 = 保持空壳，不猜
	shells.forEach((shell) => {
		const pos = cards.indexOf(shell);
		if (pos < 0 || pos >= visible.length) return;
		const item = visible[pos] as unknown as Record<string, unknown> | undefined;
		if (!item) return;
		if (shell.querySelector('.community-item-name')) return; // 竞态防护
		const name = typeof item.name === 'string' ? item.name : '';
		if (!name) return;
		const author = typeof item.author === 'string' ? item.author : '';
		const description = typeof item.description === 'string' ? item.description : '';
		const downloads = typeof item.downloads === 'number' ? item.downloads : undefined;
		const updated = typeof item.updated === 'string' ? item.updated : undefined;
		const own = (k: string): HTMLElement | undefined => {
			const v = item[k];
			// 预制元素活在弹窗 document（跨 realm instanceof 不可用）——按 doc 校验
			if (v && typeof v === 'object' && (v as HTMLElement).ownerDocument === doc) {
				return v as HTMLElement;
			}
			return undefined;
		};
		const nameEl = own('nameEl');
		if (nameEl) {
			shell.appendChild(nameEl);
		} else {
			const el = doc.createElement('div');
			el.className = 'community-item-name';
			el.textContent = name;
			shell.appendChild(el);
		}
		const authorEl = own('authorEl');
		if (authorEl) {
			shell.appendChild(authorEl);
		} else {
			const el = doc.createElement('div');
			el.className = 'community-item-author';
			el.textContent = author ? `作者：${author}` : '';
			shell.appendChild(el);
		}
		if (downloads !== undefined) {
			const dlEl = doc.createElement('div');
			dlEl.className = 'community-item-downloads';
			dlEl.textContent = String(downloads);
			shell.appendChild(dlEl);
		}
		if (updated) {
			const upEl = doc.createElement('div');
			upEl.className = 'community-item-updated';
			upEl.textContent = updated;
			shell.appendChild(upEl);
		}
		const descEl = own('descEl');
		if (descEl) {
			shell.appendChild(descEl);
		} else {
			const el = doc.createElement('div');
			el.className = 'community-item-desc';
			el.textContent = description;
			shell.appendChild(el);
		}
		shell.dataset.lgpMktFilled = '1';
	});
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

	// —— 备注行（文字评价，输入即自动保存；重建块会重画标签行，textarea 不重建）——
	const noteRow = block.createDiv({ cls: 'lgp-mkt-row lgp-mkt-note-row' });
	noteRow.createSpan({ cls: 'lgp-mkt-label', text: '备注' });
	const noteWrap = noteRow.createDiv({ cls: 'lgp-mkt-note-wrap' });
	const note = doc.createElement('textarea');
	note.className = 'lgp-mkt-note';
	note.placeholder = '写点备注…（输入自动保存）';
	note.rows = 2;
	note.value = rec?.note ?? '';
	let noteTimer = 0;
	note.addEventListener('input', () => {
		if (noteTimer) window.clearTimeout(noteTimer);
		noteTimer = window.setTimeout(() => {
			noteTimer = 0;
			// 只落数据，不重建块——重建会打断正在输入的光标
			ctx.store.setNote(id, (note as HTMLTextAreaElement).value);
			refreshAround(block, ctx);
		}, 600);
	});
	noteWrap.appendChild(note);

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
		if (cardMatches(card, tag, ctx)) matched++;
	}
	return { matched, total };
}

/**
 * 标签筛选的单卡判定。
 *
 * 两条不隐藏的宽限（反查失败 = 优雅退化，见 store.ts 文件头）：
 *  - **懒加载占位卡**：核心分批渲染列表，未滚到的卡片还没有 name/author
 *    （实测 300 张卡里只有视口带约 31 张有内容）。它们反查必失败——
 *    若按"查无此 id = 不匹配"处理，开筛选后整个未渲染区全部消失
 *    （实测 9933/9934 被藏），滚动到哪藏到哪。占位卡一律可见。
 *  - **目录未收录**：官方目录快照之外的插件（目录刷新间隙新增的等）。
 *    同理可见——筛选只对"确认无此标签"的卡片生效。
 */
function cardMatches(card: HTMLElement, tag: string | undefined, ctx: EnhanceCtx): boolean {
	if (!tag) return true;
	const id = cardId(card, ctx);
	if (!id) return true;
	return !!ctx.store.reviewOf(id)?.tags?.includes(tag);
}

function applyFilter(modal: HTMLElement, ctx: EnhanceCtx): void {
	const doc = modal.ownerDocument;
	if (!doc) return;
	const tag = ctx.store.data.activeTag;
	for (const card of modal.querySelectorAll<HTMLElement>('.community-item.tappable')) {
		const match = cardMatches(card, tag, ctx);
		card.style.display = match ? '' : 'none';
		const id = cardId(card, ctx);
		const review = id ? ctx.store.reviewOf(id) : undefined;
		// 徽标（有评价或标签才画；先清旧的防重复/防陈旧）
		card.querySelector('.lgp-mkt-badge')?.remove();
		if (review && (review.note || review.tags?.length)) {
			const badge = doc.createElement('div');
			badge.className = 'lgp-mkt-badge';
			if (review.note) {
				const n = doc.createElement('span');
				n.className = 'lgp-mkt-badge-note';
				n.textContent = `📝 ${review.note.replace(/\s+/g, ' ').slice(0, 24)}${review.note.length > 24 ? '…' : ''}`;
				badge.appendChild(n);
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
