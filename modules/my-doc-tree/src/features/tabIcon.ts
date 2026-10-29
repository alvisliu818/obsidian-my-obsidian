/**
 * 编辑器标签页上的主题文件图标(虚拟文档树打开的库外文件)。
 *
 * 树行图标走 iconForEntry;标签页的机制不同:Obsidian 用 view.getIcon() 的
 * lucide id 渲染 tabHeaderInnerIconEl,塞不进自定义 SVG。所以打开外部文件后
 * 直接替换该元素内容——但只在图标主题真给了图标时(否则保留原 lucide 图标)。
 *
 * 标签页头会随布局变化重建/被 setIcon 重设,主题图标会丢:每次 workspace
 * 'layout-change' 对标记过的 leaf 重应用,靠 marker 元素(.lgp-tab-theme-icon)
 * 存在与否判断要不要补——setIcon 重设内容会清掉 marker 元素,重建则是全新
 * 元素,两种丢法都会被下一次重应用接住。
 */
import { decideIcon, EXT_ICON_CLASS } from './iconTheme';

/** 标签页图标占位元素类名(marker + 样式钩子)。 */
export const TAB_THEME_ICON_CLASS = 'lgp-tab-theme-icon';

interface TabIconInfo {
  /** 文件全名(含扩展名);主题按末两段目录/文件名规则 + 扩展名匹配。 */
  name: string;
  /** 挂载内相对路径,让主题的目录作用域文件名规则能命中;缺省退回 name。 */
  rel?: string;
}

interface LeafLike {
  __lgTabIconInfo?: TabIconInfo;
  tabHeaderInnerIconEl?: HTMLElement;
  /** TextFileView.dirty(原生未保存)/BlockEditorView.externalDirty(库外编辑未落盘)。 */
  view?: { dirty?: boolean; externalDirty?: boolean } | null;
}

/** 打开外部文件后调用:把这个 leaf 的标签页图标标记为主题图标候选。 */
export function markLeafTabIcon(leaf: unknown, info: TabIconInfo): void {
  (leaf as LeafLike).__lgTabIconInfo = info;
}

/**
 * 对标记过的 leaf 逐个应用主题图标;主题没给图标(未装主题/不认识的文件)
 * 时不动 Obsidian 原图标。返回实际(重新)应用的数量,供探针断言。
 */
export function applyMarkedTabIcons(app: unknown, leaves: unknown[]): number {
  let applied = 0;
  for (const leaf of leaves) {
    const l = leaf as LeafLike;
    const info = l.__lgTabIconInfo;
    const iconEl = l.tabHeaderInnerIconEl;
    if (!info || !iconEl) continue;
    // 视图有未保存改动时 Obsidian 会把图标换成修改标记(铅笔),此时绝不能
    // 重应用主题图标盖掉它——否则"修改图标标记"永远看不见(实测报告)。
    if (l.view?.dirty === true || l.view?.externalDirty === true) continue;
    // marker 元素还在 = 当前 DOM 已是我们的主题图标,跳过
    if (iconEl.querySelector(`.${TAB_THEME_ICON_CLASS}`)) continue;
    const decision = decideIcon(app, {
      name: info.name,
      isDir: false,
      rel: info.rel || info.name,
      fallback: '',
    });
    if (!decision.themed) continue;
    const holder = document.createElement('span');
    holder.className = TAB_THEME_ICON_CLASS;
    if (decision.dataUri) {
      // 扩展市场图标主题:SVG 以 data URI 存储,<img> 渲染(同树行)
      const img = document.createElement('img');
      img.className = EXT_ICON_CLASS;
      img.src = decision.dataUri;
      img.alt = '';
      holder.appendChild(img);
    } else if (decision.svg) {
      holder.innerHTML = decision.svg;
    } else {
      continue;
    }
    iconEl.empty();
    iconEl.appendChild(holder);
    applied++;
  }
  return applied;
}
