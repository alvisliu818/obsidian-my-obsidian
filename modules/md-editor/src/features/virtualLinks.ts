/**
 * 虚拟链接渲染面(fakelink/Virtual Linker 语义吸收,2026-11-19):
 *
 * 两个装饰面共用一套词库索引(virtualLinkIndex.ts)与扫描核心
 * (virtualLinkScan.ts):
 *  - 渲染态(registerMarkdownPostProcessor):块渲染 HTML、原生阅读视图、
 *    嵌入——文本节点里命中词条 → 包 span.lgp-virtual-link(不写回文件,
 *    纯 DOM 装饰,fakelink 核心语义);
 *  - 编辑态(聚焦块 CM6,见 editor/extensions.ts 的 virtualLinkExtension):
 *    mark 装饰 + 光标让位(光标落进词条区间回原样,方便改词)。
 *
 * 交互( fakelink parity 子集):
 *  - 点击 → 打开目标(note → 文件;header → 文件#标题锚);
 *  - 右键菜单 → 打开 / 转换为真实链接(仅编辑态,区间精确) / 排除该词;
 *  - 排除词写入 settings.virtualLinksExcludedKeywords,重建索引后消失。
 *
 * v1 有意收敛(与上游差异,均注明):
 *  - 同词多文件只取最优目标(note > alias > header,路径升序),不做
 *    [1|2|3] 徽标多目标 UI;
 *  - 渲染态右键无「转换为真实链接」(渲染文本与块模型的偏移映射不可靠,
 *    编辑态区间精确,转换只在编辑态提供);
 *  - 大小写不敏基线,无上游 per-note case 标签;无模糊/词干匹配。
 */

import { Menu, Notice, type App } from 'obsidian';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { BlockRenderHost } from '../blocks/renderHost';
import type { Block, BlockEditorSettings } from '../types';
import type { VirtualLinkIndex, VirtualLinkSnapshot } from './virtualLinkIndex';
import { scanVirtualLinks, type VirtualLinkTerm } from './virtualLinkScan';

/** 渲染面/菜单需要的宿主面(避免与 main.ts 循环依赖)。 */
export interface VirtualLinkSurfaceHost {
  app: App;
  settings: BlockEditorSettings;
  virtualLinkIndex?: VirtualLinkIndex | null;
  saveSettings(): Promise<void>;
  scheduleVirtualLinkRebuild(): void;
  refreshAllViews(): void;
}

const SKIP_PARENTS_SELECTOR = 'code, pre, script, style, textarea, a, .internal-link, .cm-editor, .cm-content, .lgp-virtual-link';

/** 同词多目标取优:note > alias > header,路径升序稳定排序。 */
export function pickBestTerm(terms: VirtualLinkTerm[]): VirtualLinkTerm | null {
  if (!terms.length) return null;
  const rank = (t: VirtualLinkTerm): number => (t.kind === 'note' ? 0 : t.kind === 'alias' ? 1 : 2);
  return [...terms].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))[0];
}

/** 点击/跳转目标:note → path;header → path#标题。 */
export function virtualLinkTargetPath(term: VirtualLinkTerm): string {
  return term.kind === 'header' && term.header ? `${term.path}#${term.header}` : term.path;
}

/**
 * 转换为真实链接的替换文本:词与目标 basename 同文(大小写不敏)→
 * `[[词]]`;别名/标题/部分匹配 → `[[path#header|词]]` 全形。
 */
export function realLinkTextFor(term: VirtualLinkTerm, matchedText: string): string {
  const basename = term.path.split('/').pop()?.replace(/\.md$/, '') ?? term.path;
  if (term.kind === 'note' && matchedText.toLowerCase() === basename.toLowerCase()) {
    return `[[${matchedText}]]`;
  }
  const target = term.kind === 'header' && term.header ? `${term.path}#${term.header}` : term.path;
  return `[[${target}|${matchedText}]]`;
}

/** 打开虚拟链接目标(点击/菜单共用)。 */
export function openVirtualLink(host: VirtualLinkSurfaceHost, term: VirtualLinkTerm): void {
  void host.app.workspace.openLinkText(virtualLinkTargetPath(term), '');
}

/** 把词加入全局排除词(settings 持久化 + 重建索引 + 全视图重绘)。 */
async function excludeKeyword(host: VirtualLinkSurfaceHost, key: string): Promise<void> {
  const list = String(host.settings.virtualLinksExcludedKeywords ?? '')
    .split(/[\n,;，；]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const lower = key.toLowerCase();
  if (list.some((s) => s.toLowerCase() === lower)) return;
  list.push(key);
  host.settings.virtualLinksExcludedKeywords = list.join('\n');
  await host.saveSettings();
  host.scheduleVirtualLinkRebuild();
  host.refreshAllViews();
  new Notice(`已排除「${key}」(虚拟链接不再匹配)`);
}

/** 右键菜单(渲染态/编辑态共用;convert 仅编辑态提供)。 */
export function showVirtualLinkMenu(
  host: VirtualLinkSurfaceHost,
  term: VirtualLinkTerm,
  matchedText: string,
  pos: { x: number; y: number },
  convert?: () => void,
): void {
  const menu = new Menu();
  menu.addItem((i) =>
    i.setTitle(`打开「${term.kind === 'header' ? `${term.path}#${term.header}` : term.path}」`).setIcon('link' as never).onClick(() => openVirtualLink(host, term)),
  );
  if (convert) {
    menu.addItem((i) => i.setTitle('转换为真实链接').setIcon('bracket' as never).onClick(() => convert()));
  }
  menu.addSeparator();
  menu.addItem((i) => i.setTitle(`排除该词「${matchedText}」`).setIcon('eye-off' as never).onClick(() => void excludeKeyword(host, matchedText)));
  menu.showAtPosition(pos);
}

/** 单条文本节点的装饰化:命中区间包 span,返回替换用的 DocumentFragment(无命中返回 null)。 */
function decorateTextNode(
  host: VirtualLinkSurfaceHost,
  snapshot: VirtualLinkSnapshot,
  sourcePath: string,
  node: Text,
): DocumentFragment | null {
  const text = node.nodeValue ?? '';
  if (text.length < 2) return null;
  const matches = scanVirtualLinks(text, snapshot.trie, snapshot.scanOptions);
  if (!matches.length) return null;
  const frag = document.createDocumentFragment();
  let cursor = 0;
  for (const m of matches) {
    const best = pickBestTerm(snapshot.terms.get(m.key) ?? []);
    if (!best || best.path === sourcePath) continue; // 自链接跳过(fakelink excludeLinksToOwnNote 基线)
    if (m.from > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, m.from)));
    const span = document.createElement('span');
    span.className = `lgp-virtual-link lgp-vl-${best.kind}`;
    span.dataset.vlPath = best.path;
    if (best.header) span.dataset.vlHeader = best.header;
    span.dataset.vlKey = m.key;
    span.setAttribute('title', virtualLinkTargetPath(best));
    span.textContent = text.slice(m.from, m.to);
    span.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openVirtualLink(host, best);
    });
    span.addEventListener('contextmenu', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      showVirtualLinkMenu(host, best, text.slice(m.from, m.to), { x: ev.clientX, y: ev.clientY });
    });
    frag.appendChild(span);
    cursor = m.to;
  }
  if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
  return cursor > 0 ? frag : null;
}

/**
 * 渲染态入口:registerMarkdownPostProcessor。ctx.sourcePath 用于自链接
 * 过滤;宿主未就绪/功能关闭时零成本过路(文本节点不进扫描)。
 */
export function registerVirtualLinks(
  plugin: VirtualLinkSurfaceHost & { registerMarkdownPostProcessor(fn: (el: HTMLElement, ctx: { sourcePath: string }) => void): void },
): void {
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    const settings = plugin.settings;
    if (settings.virtualLinksEnabled === false) return;
    const snapshot = plugin.virtualLinkIndex?.snapshot();
    if (!snapshot || snapshot.size === 0) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      const parent = text.parentElement;
      if (!parent || !text.nodeValue || text.nodeValue.length < 2) continue;
      if (parent.closest(SKIP_PARENTS_SELECTOR)) continue;
      targets.push(text);
    }
    for (const text of targets) {
      const frag = decorateTextNode(plugin, snapshot, ctx.sourcePath, text);
      if (frag) text.replaceWith(frag);
    }
  });
}

// ---------------------------------------------------------------------------
// 编辑态(聚焦块 CM6):mark 装饰 + 光标让位 + 点击/右键/转换
// ---------------------------------------------------------------------------

/** 语法树里的排斥区间:代码环境 + 真实链接(命名兼容两套树,同 emoji 手法)。 */
function skipRangesOf(view: EditorView): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const tree = syntaxTree(view.state);
  if (tree.length <= 0) return out;
  tree.iterate({
    from: 0,
    to: Math.min(view.state.doc.length, tree.length),
    enter: (n) => {
      const name = n.name.toLowerCase();
      if (name.includes('code') || name.includes('link')) {
        out.push({ from: n.from, to: n.to });
        return false;
      }
      return undefined;
    },
  });
  return out;
}

/**
 * 聚焦块 CM6 的虚拟链接扩展。mark 装饰(文本保持可见,下划线样式),光标
 * 落进词条区间(含起点)回原样——改词不被打扰(emoji/live preview 同款交互)。
 * 区间带 data-vl-from/to,右键「转换为真实链接」按精确区间改写块文本,
 * CM 事务走 updateListener 的 docChanged 同步块模型(与打字同链路)。
 */
export function virtualLinkExtension(host: BlockRenderHost, block?: Block): Extension {
  const plugin = host.plugin as unknown as VirtualLinkSurfaceHost & { virtualLinkIndex?: VirtualLinkIndex };
  const viewPlugin = ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet = Decoration.none;
      constructor(view: EditorView) {
        this.compute(view);
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.compute(u.view);
      }
      private compute(view: EditorView): void {
        if (plugin.settings.virtualLinksEnabled === false || (block && host.sourceModeBlock === block)) {
          this.decorations = Decoration.none;
          return;
        }
        const snapshot = plugin.virtualLinkIndex?.snapshot();
        if (!snapshot || snapshot.size === 0) {
          this.decorations = Decoration.none;
          return;
        }
        const doc = view.state.doc;
        const skips = skipRangesOf(view);
        const ownPath = host.file?.path ?? null;
        const matches = scanVirtualLinks(doc.toString(), snapshot.trie, snapshot.scanOptions).filter((m) => {
          if (skips.some((s) => m.from < s.to && s.from < m.to)) return false;
          // 自链接(目标 = 当前文件)跳过
          const best = pickBestTerm(snapshot.terms.get(m.key) ?? []);
          if (!best || best.path === ownPath) return false;
          // 光标让位:选区与词条区间重叠,或光标停在起点 → 原样
          const sel = view.state.selection.ranges;
          if (sel.some((r) => r.to > m.from && r.from < m.to)) return false;
          if (sel.some((r) => r.from === m.from && r.to === m.from)) return false;
          return true;
        });
        if (!matches.length) {
          this.decorations = Decoration.none;
          return;
        }
        const builder = new RangeSetBuilder<Decoration>();
        for (const m of matches) {
          const best = pickBestTerm(snapshot.terms.get(m.key) ?? []) as VirtualLinkTerm;
          builder.add(
            m.from,
            m.to,
            Decoration.mark({
              class: `lgp-virtual-link lgp-vl-${best.kind}`,
              attributes: {
                'data-vl-from': String(m.from),
                'data-vl-to': String(m.to),
                'data-vl-key': m.key,
                'data-vl-path': best.path,
                ...(best.header ? { 'data-vl-header': best.header } : {}),
                title: virtualLinkTargetPath(best),
              },
            }),
          );
        }
        this.decorations = builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
  const handlers = EditorView.domEventHandlers({
    click: (event, _view) => {
      if (plugin.settings.virtualLinksEnabled === false) return false;
      const el = (event.target as HTMLElement | null)?.closest?.('.lgp-virtual-link') as HTMLElement | null;
      if (!el) return false;
      const snapshot = plugin.virtualLinkIndex?.snapshot();
      if (!snapshot) return false;
      const terms = snapshot.terms.get(el.dataset.vlKey ?? '');
      const best = terms ? pickBestTerm(terms) : null;
      if (!best) return false;
      openVirtualLink(plugin, best);
      return true; // 打开目标即完成导航,不让 CM 再落光标
    },
    contextmenu: (event, view) => {
      if (plugin.settings.virtualLinksEnabled === false) return false;
      const el = (event.target as HTMLElement | null)?.closest?.('.lgp-virtual-link') as HTMLElement | null;
      if (!el) return false;
      const snapshot = plugin.virtualLinkIndex?.snapshot();
      if (!snapshot) return false;
      const key = el.dataset.vlKey ?? '';
      const terms = snapshot.terms.get(key);
      const best = terms ? pickBestTerm(terms) : null;
      if (!best) return false;
      const matchedText = view.state.sliceDoc(Number(el.dataset.vlFrom ?? 0), Number(el.dataset.vlTo ?? 0));
      const from = Number(el.dataset.vlFrom ?? 0);
      const to = Number(el.dataset.vlTo ?? 0);
      showVirtualLinkMenu(
        plugin,
        best,
        matchedText,
        { x: event.clientX, y: event.clientY },
        () => {
          view.dispatch({ changes: { from, to, insert: realLinkTextFor(best, matchedText) } });
        },
      );
      return true;
    },
  });
  return [viewPlugin, handlers];
}
