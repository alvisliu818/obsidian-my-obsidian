/**
 * The mount panel: a sidebar view listing folders that live OUTSIDE the vault.
 *
 * This is a self-contained `ItemView`. It deliberately injects NOTHING into
 * Obsidian's own file explorer — a previous attempt did, and occupying
 * `.nav-files-container`'s firstElementChild displaced the native virtualizer's
 * spacer, breaking the surrounding layout. Owning the whole subtree here means
 * there is no DOM to break. See `notes/mounts.md` for the measurement.
 *
 * Each row's right-click menu offers "link into the vault", which makes the
 * entry a REAL vault path: a junction for folders, a hard link for files
 * (Windows refuses junctions for files, and symlinks need privileges we do not
 * have). Linked entries then open in the native block editor with everything
 * that implies — backlinks, block references, search.
 */

import { ItemView, Menu, Notice, type WorkspaceLeaf } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import type { ExternalMount } from '../types';
import { mountDisplayName } from '../types';
import {
  compileFilter,
  countTree,
  dirPruned,
  entryMatches,
  EMPTY_FILTER,
  isTextMount,
  type MountNode,
} from '../features/mountFilter';
import {
  MOUNT_FOLDER,
  createEmptyFile,
  createLink,
  deletePermanent,
  ensureDirX,
  exists,
  extOf,
  isDirectory,
  joinAbs,
  linkKindFor,
  linkTargetFor,
  removeLink,
  renameEntry,
  safeSegment,
  scanExternal,
  trashEntry,
  validateEntryName,
  linkVaultPath,
} from '../features/extFs';
import { ConfirmModal, NamePromptModal } from './promptModals';
import { iconForEntry } from '../features/iconTheme';

export const VIEW_TYPE_MOUNT_PANEL = 'logseq-mount-panel';

/** Must match the row height in styles.css so the spacer maths stays honest. */
const MOUNT_ROW_HEIGHT = 25;
/** Rows drawn beyond the viewport on each side, so fast scrolling stays filled. */
const MOUNT_OVERSCAN = 8;

/** Per-mount render state, kept across repaints. */
interface MountState {
  /** Expanded folder paths, relative to the mount root. */
  open: Set<string>;
  tree: MountNode[];
  /**
   * Folders whose children have been read (`''` = the mount root). The tree is
   * built one layer at a time: expanding a folder reads just that folder, so
   * mounting a drive root costs one `readdir` instead of walking all of it.
   */
  loaded: Set<string>;
  truncated: boolean;
  scannedAt: number;
  error?: string;
}

export class MountPanelView extends ItemView {
  plugin: LogseqEditorPlugin;
  private states = new Map<string, MountState>();
  /** Per-render viewport painters; the panel's scroll runs them all. */
  private rowPainters: Array<() => void> = [];
  /** The ancestor that actually scrolls the panel (usually `.view-content`). */
  private scrollEl: HTMLElement | null = null;
  private readonly onScrollRepaint = (): void => {
    for (const paint of this.rowPainters) paint();
  };

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_MOUNT_PANEL;
  }

  getDisplayText(): string {
    return '外部挂载';
  }

  getIcon(): string {
    return 'folder-symlink';
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    if (this.scrollEl) this.scrollEl.removeEventListener('scroll', this.onScrollRepaint);
    this.scrollEl = null;
    this.rowPainters = [];
    this.states.clear();
  }

  /**
   * The ancestor that actually scrolls the panel — the first element with a
   * scrollable overflow, which in a sidebar leaf is `.view-content`
   * (measured: overflowY auto). Rows repaint on its scroll, so the whole
   * panel scrolls as one and there is no inner scroll box to fix in place.
   */
  private findScrollEl(): HTMLElement | null {
    let el: HTMLElement | null = this.contentEl;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') return el;
      el = el.parentElement;
    }
    return null;
  }

  /** Forget every cached scan, so the next paint re-reads from disk. */
  refreshMounts(): void {
    this.states.clear();
    this.render();
  }

  // ------------------------------------------------------------------
  // scanning
  // ------------------------------------------------------------------

  /**
   * Scan one mount, caching until a refresh is asked for.
   *
   * A fresh mount starts EXPANDED: someone who just mounted a folder wants to
   * see what is in it. Nested folders stay closed.
   */
  private scan(mount: ExternalMount, force = false): MountState {
    const cached = this.states.get(mount.id);
    if (cached && !force) return cached;

    // 过滤默认关闭：虚拟文档树挂载不过滤，显示挂载目录下的全部内容。
    // 关闭时用一个恒真的过滤器，include/exclude 正则原样保留，开启后立即生效。
    const filtering = this.plugin.settings.mountFilterEnabled !== false;
    const f = filtering
      ? compileFilter({ include: mount.include, exclude: mount.exclude })
      : compileFilter(EMPTY_FILTER);
    const state: MountState = {
      open: cached?.open ?? new Set<string>(['']),
      tree: [],
      loaded: new Set<string>(),
      truncated: false,
      scannedAt: Date.now(),
    };

    if (!isDirectory(mount.path)) {
      state.error = '文件夹不存在，请检查路径。';
      this.states.set(mount.id, state);
      return state;
    }

    if (f.errors.include) state.error = `包含正则无效，已忽略：/${f.errors.include}/`;
    else if (f.errors.exclude) state.error = `排除正则无效，已忽略：/${f.errors.exclude}/`;
    this.states.set(mount.id, state);
    // First layer only — deeper folders are read when they are expanded
    // (see `loadLayer`), which is what lets a drive root mount instantly
    // instead of walking the whole disk before anything is shown.
    this.loadLayer(mount, '', state);
    return state;
  }

  /**
   * Read ONE folder and attach its children to the tree.
   *
   * `depth: 0` lists the folder's own entries without descending, so the cost
   * of expanding a folder is a single `readdir` no matter how much is under it.
   * Because there is no full walk any more, there is no entry cap either — the
   * tree is always complete, just filled in lazily.
   */
  private loadLayer(mount: ExternalMount, rel: string, state: MountState): void {
    if (state.loaded.has(rel)) return;
    state.loaded.add(rel);

    const filtering = this.plugin.settings.mountFilterEnabled !== false;
    const f = filtering
      ? compileFilter({ include: mount.include, exclude: mount.exclude })
      : compileFilter(EMPTY_FILTER);

    const dirAbs = rel ? joinAbs(mount.path, rel) : mount.path;
    const { entries } = scanExternal(dirAbs, {
      shouldEnterDir: (childRel) => !dirPruned(rel ? `${rel}/${childRel}` : childRel, f),
      keepFile: (childRel) => entryMatches(rel ? `${rel}/${childRel}` : childRel, f),
      depth: 0,
    });

    const children: MountNode[] = entries.map((e) => ({
      name: e.name,
      rel: rel ? `${rel}/${e.rel}` : e.rel,
      abs: e.abs,
      isDir: e.isDir,
      size: e.size,
      mtime: e.mtime,
      children: [],
    }));
    // Same order `buildTree` produces: folders first, then files, A→Z.
    children.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));

    if (!rel) {
      state.tree = children;
      return;
    }
    const parent = this.findNode(state.tree, rel);
    if (parent) {
      parent.children = children;
      parent.empty = children.length === 0;
    }
  }

  /** Find a node by its mount-relative path among the layers loaded so far. */
  private findNode(list: MountNode[], rel: string): MountNode | null {
    for (const n of list) {
      if (n.rel === rel) return n;
      if (n.isDir) {
        const hit = this.findNode(n.children, rel);
        if (hit) return hit;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // rendering
  // ------------------------------------------------------------------

  render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('logseq-mount-panel');

    // Viewport painters are rebuilt with the DOM; the scroll listener lives
    // on the panel's scrollable ancestor, which survives re-renders.
    this.rowPainters = [];
    if (this.scrollEl) this.scrollEl.removeEventListener('scroll', this.onScrollRepaint);
    this.scrollEl = this.findScrollEl();
    this.scrollEl?.addEventListener('scroll', this.onScrollRepaint, { passive: true });

    // Pinned mounts float to the top; everything else keeps the order the user
    // dragged it into (see `wireDragReorder`).
    const mounts = (this.plugin.settings.externalMounts ?? [])
      .filter((m) => m.enabled)
      .slice()
      .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true));
    if (mounts.length === 0) {
      const empty = contentEl.createDiv({ cls: 'logseq-mount-panel-empty' });
      empty.createDiv({ text: '还没有外部挂载。' });
      empty.createDiv({
        cls: 'logseq-mount-panel-hint',
        text: '把库外的文件夹挂到这里，Markdown 会在原地编辑并存回原文件。',
      });
      const add = empty.createEl('button', { cls: 'mod-cta', text: '添加挂载' });
      add.addEventListener('click', () => this.plugin.promptAddMount());
      return;
    }

    const bar = contentEl.createDiv({ cls: 'logseq-mount-panel-bar' });
    bar.createSpan({ cls: 'logseq-mount-panel-count', text: `${mounts.length} 个挂载` });
    const addBtn = bar.createEl('button', { cls: 'logseq-mount-panel-btn', text: '＋' });
    addBtn.setAttribute('aria-label', '添加挂载');
    addBtn.addEventListener('click', () => this.plugin.promptAddMount());
    const refreshBtn = bar.createEl('button', { cls: 'logseq-mount-panel-btn', text: '⟳' });
    refreshBtn.setAttribute('aria-label', '重新扫描');
    refreshBtn.addEventListener('click', () => this.refreshMounts());

    for (const m of mounts) this.renderMount(contentEl, m);
    // Repaint with the final DOM in place — geometry measured mid-build can
    // be stale, and the scroll position may have been reset by the rebuild.
    for (const paint of this.rowPainters) paint();
  }

  private renderMount(root: HTMLElement, mount: ExternalMount): void {
    const section = root.createDiv({ cls: 'logseq-mount-section' });

    const head = section.createDiv({ cls: 'logseq-mount-head' });
    const caret = head.createSpan({ cls: 'logseq-mount-caret' });
    const state = this.scan(mount);
    caret.textContent = state.open.has('') ? '▾' : '▸';
    // The mount root is a folder too, so it gets the same treatment.
    const headLabel = mountDisplayName(mount);
    head.appendChild(
      iconForEntry(this.plugin.app, {
        name: headLabel,
        isDir: true,
        mountPath: mount.path,
        rel: '',
        collapsed: !state.open.has(''),
        fallback: '📁',
      }),
    );
    head.createSpan({ cls: 'logseq-mount-name', text: headLabel });
    if (mount.pinned) head.createSpan({ cls: 'logseq-mount-flag is-pinned', text: '已固定' });
    head.addEventListener('click', () => {
      if (state.open.has('')) state.open.delete('');
      else state.open.add('');
      this.render();
    });
    // The mount's own menu: edit, unmount, rescan, pin.
    this.wireMenu(head, mount, null);
    this.wireDragReorder(section, head, mount);

    if (!state.open.has('')) return;

    if (state.error) section.createDiv({ cls: 'logseq-mount-error', text: state.error });
    const filtering = this.plugin.settings.mountFilterEnabled !== false;
    const counts = countTree(state.tree);
    const meta: string[] = [];
    // The tree fills in layer by layer, so a total would be a lie: only what
    // has actually been read is counted — and the whole line is optional
    // (Settings → 外部挂载 → 显示「已加载」统计).
    if (this.plugin.settings.mountShowLoadedCount !== false && (counts.files || counts.folders)) {
      meta.push(`已加载 ${counts.files} 文件 · ${counts.folders} 文件夹`);
    }
    // Filter hints only while filtering is ON: with the toggle off the
    // regexes are inert, and showing 排除 /…/ suggests they still bite.
    if (filtering) {
      if (mount.include.trim()) meta.push(`包含 /${mount.include}/`);
      if (mount.exclude.trim()) meta.push(`排除 /${mount.exclude}/`);
    }
    if (state.truncated) meta.push('已截断');
    section.createDiv({ cls: 'logseq-mount-meta', text: meta.join(' · ') || mount.path });

    if (state.tree.length === 0 && !state.truncated) {
      section.createDiv({ cls: 'logseq-mount-empty', text: '没有符合过滤条件的条目。' });
      return;
    }
    this.renderRows(section, mount, state);
  }

  /**
   * Draw the rows of one mount through a viewport band.
   *
   * The tree is flattened to a list first (only folders in `open` contribute
   * their children); a spacer of the full height keeps the panel's own scroll
   * honest, and an absolutely positioned band holds only the rows near the
   * viewport. There is deliberately NO inner scroll box: the whole panel
   * scrolls as one — the mount header scrolls away with its tree — and the
   * band is repainted by the panel scroll listener (`onScrollRepaint`).
   */
  private renderRows(section: HTMLElement, mount: ExternalMount, state: MountState): void {
    const rows = this.flatten(state);
    const spacer = section.createDiv({ cls: 'logseq-mount-spacer' });
    spacer.style.position = 'relative';
    spacer.style.height = `${rows.length * MOUNT_ROW_HEIGHT}px`;
    const band = spacer.createDiv({ cls: 'logseq-mount-band' });
    band.style.position = 'absolute';
    band.style.left = '0';
    band.style.right = '0';

    const paint = (): void => {
      // Rects are viewport-based, so whichever ancestor scrolls, the visible
      // window math stays honest. With no scrollable ancestor the content
      // fits, and every row is painted.
      let first = 0;
      let last = rows.length;
      const scroller = this.scrollEl;
      if (scroller) {
        const outer = scroller.getBoundingClientRect();
        const inner = spacer.getBoundingClientRect();
        if (inner.bottom < outer.top || inner.top > outer.bottom) {
          band.empty();
          return;
        }
        const above = inner.top < outer.top ? Math.floor((outer.top - inner.top) / MOUNT_ROW_HEIGHT) : 0;
        first = Math.max(0, Math.min(rows.length, above - MOUNT_OVERSCAN));
        const visible = Math.ceil(outer.height / MOUNT_ROW_HEIGHT) + MOUNT_OVERSCAN * 2;
        last = Math.min(rows.length, first + visible);
      }
      band.empty();
      band.style.transform = `translateY(${first * MOUNT_ROW_HEIGHT}px)`;
      for (let i = first; i < last; i++) {
        const r = rows[i];
        const row = band.createDiv({ cls: 'logseq-mount-row-wrap' });
        row.style.height = `${MOUNT_ROW_HEIGHT}px`;
        this.renderNode(row, mount, r.node, state, r.depth);
      }
    };
    this.rowPainters.push(paint);
    paint();
  }

  /** Flatten the loaded tree into draw order, honouring which folders are open. */
  private flatten(state: MountState): Array<{ node: MountNode; depth: number }> {
    const out: Array<{ node: MountNode; depth: number }> = [];
    const walk = (list: MountNode[], depth: number): void => {
      for (const n of list) {
        out.push({ node: n, depth });
        if (n.isDir && state.open.has(n.rel)) walk(n.children, depth + 1);
      }
    };
    walk(state.tree, 0);
    return out;
  }

  private renderNode(parent: HTMLElement, mount: ExternalMount, node: MountNode, state: MountState, depth: number): void {
    const isOpen = state.open.has(node.rel);
    const row = parent.createDiv({
      cls: 'logseq-mount-row ' + (node.isDir ? 'is-dir' : 'is-file'),
    });
    // Native-explorer rhythm, pulled 10px left as a whole (user preference):
    // folder rows carry a 14px caret gutter, FILE rows the same gutter plus
    // the caret's width (11px + 4px gap), so the file ICON aligns with the
    // folder ICON at the same depth. Each level shifts the row 17px; the
    // mount head counts as the depth-0 folder, rows start one level in.
    row.style.paddingInlineStart = `${(node.isDir ? 14 : 29) + (depth + 1) * 17}px`;

    if (node.isDir) {
      const caret = row.createSpan({ cls: 'logseq-mount-caret' });
      caret.textContent = isOpen ? '▾' : '▸';
      row.appendChild(
        iconForEntry(this.plugin.app, {
          name: node.name,
          isDir: true,
          mountPath: mount.path,
          rel: node.rel,
          collapsed: !isOpen,
          fallback: '📁',
        }),
      );
      row.createSpan({ cls: 'logseq-mount-name', text: node.name });
      if (node.empty) row.createSpan({ cls: 'logseq-mount-flag', text: '空' });
      row.addEventListener('click', () => {
        if (isOpen) {
          state.open.delete(node.rel);
        } else {
          state.open.add(node.rel);
          // Lazily read this folder's children the first time it is opened.
          this.loadLayer(mount, node.rel, state);
        }
        this.render();
      });
      this.wireMenu(row, mount, node);
      // Children are drawn by `flatten`/`renderRows`, not recursively here —
      // that is what keeps the row count (and the DOM) bounded.
      return;
    }

    const text = isTextMount(extOf(node.name));
    // Files get the icon theme's own artwork when it is installed, so a mounted
    // tree shows the same icons the vault's files do. Folders keep a generic
    // marker: the theme resolves folder icons by vault path, which an
    // out-of-vault folder does not have.
    row.appendChild(
      iconForEntry(this.plugin.app, {
        name: node.name,
        isDir: false,
        mountPath: mount.path,
        rel: node.rel,
        fallback: text ? '📄' : '🔒',
      }),
    );
    row.createSpan({ cls: 'logseq-mount-name', text: node.name });
    // Linked state is the only flair a file row carries: type pills (png /
    // 二进制 / …) read as noise repeated on half the rows, so they are gone.
    if (this.isLinked(node)) row.createSpan({ cls: 'logseq-mount-flag is-linked', text: '已链接' });
    row.addEventListener('click', () => {
      void this.plugin.openExternalEntry(mount, node);
    });
    this.wireMenu(row, mount, node);
  }

  // ------------------------------------------------------------------
  // context menu
  // ------------------------------------------------------------------

  /**
   * Right-click menu.
   *
   * `preventDefault` is essential: without it Obsidian opens ITS menu for the
   * row underneath, offering vault-only actions (rename, delete) that would
   * fail confusingly on a path the vault has never heard of.
   */
  private wireMenu(row: HTMLElement, mount: ExternalMount, node: MountNode | null): void {
    row.addEventListener('contextmenu', (ev) => {
      const e = ev as MouseEvent;
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();

      if (node) {
        const text = !node.isDir && isTextMount(extOf(node.name));
        const linked = this.isLinked(node);
        // Name the destination honestly, and never promise a vault link the user
        // did not ask for: opening a file writes nothing to the vault.
        const primaryTitle = node.isDir
          ? '展开 / 折叠'
          : linked
            ? node.name.toLowerCase().endsWith('.md')
              ? '在 Logseq 块编辑器中打开（已链接）'
              : '用已安装的编辑器打开（已链接）'
            : node.name.toLowerCase().endsWith('.md')
              ? '在块编辑器中打开'
              : text
                ? '在块编辑器中打开'
                : '用系统程序打开';
        menu.addItem((item) =>
          item
            .setTitle(primaryTitle)
            .setIcon('file-text' as never)
            .onClick(() => {
              if (node.isDir) this.toggleNode(mount, node.rel);
              else void this.plugin.openExternalEntry(mount, node);
            }),
        );
        if (!node.isDir) {
          menu.addItem((item) =>
            item
              .setTitle('只读打开')
              .setIcon('eye' as never)
              .onClick(() => void this.plugin.openExternalEntry(mount, node, { readOnly: true })),
          );
        }
        // Obsidian 1.14.4+ opens out-of-vault files with its NATIVE editor
        // (TExternalFile) — offer that alongside our own editors when the
        // running app supports it.
        if (!node.isDir && this.plugin.canOpenNativeExternal()) {
          menu.addItem((item) =>
            item
              .setTitle('用原生编辑器打开')
              .setIcon('app-window' as never)
              .onClick(() => void this.plugin.openExternalInNativeEditor(node)),
          );
        }
        menu.addSeparator();

        // ---- the link-into-vault action (hideable via 设置 → 外部挂载) ----
        // Windows refuses a junction for a file and refuses symlinks without
        // privileges, so the kind is derived from the target rather than chosen.
        // With the setting off the whole group disappears: no link, no unlink,
        // no parent-folder link — already-established links keep working.
        if (this.plugin.settings.mountLinkEnabled !== false) {
          const kind = linkKindFor(node.abs);
          const linkName = safeSegment(node.name);
          const already = this.isLinked(node);
          const kindLabel = kind === 'junction' ? '目录联接' : '硬链接';
          menu.addItem((item) =>
            item
              .setTitle(
                already
                  ? '从库中取消链接'
                  : `链接到库（${kindLabel} → ${MOUNT_FOLDER}/）`,
              )
              .setIcon((already ? 'unlink' : 'link') as never)
              .onClick(async () => {
                if (already) this.unlinkNode(node);
                else await this.linkNode(node, linkName);
              }),
          );
          if (!node.isDir && !already) {
            menu.addItem((item) =>
              item.setTitle('链接整个上级文件夹').setIcon('folder-plus' as never).onClick(async () => {
                // Linking the containing folder brings the whole subtree across at
                // once — often what people actually want, and a hard link cannot
                // do it per-file without linking hundreds of entries.
                const st = this.states.get(mount.id);
                if (!st) return;
                const parent = parentNodeOf(st, node.rel);
                if (!parent) {
                  new Notice('找不到上级文件夹。');
                  return;
                }
                await this.linkNode(parent, safeSegment(parent.name));
              }),
            );
          }
        }
        menu.addSeparator();
        // ---- file management on the external tree (思源文件树对齐) ----
        this.addTreeFileMenuItems(menu, mount, node);
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle('在资源管理器中显示')
            .setIcon('folder-open' as never)
            .onClick(() => this.plugin.revealInSystem(node.abs)),
        );
        // When the forward ran, its handlers already provide 复制绝对路径 —
        // adding ours too would show the entry twice.
        const forwarded = this.addFileMenuEventItems(menu, node.abs);
        if (!forwarded) {
          menu.addItem((item) =>
            item
              .setTitle('复制绝对路径')
              .setIcon('copy' as never)
              .onClick(() => {
                void navigator.clipboard?.writeText(node.abs);
                new Notice('已复制路径');
              }),
          );
        }
      } else {
        // Mount header: directory-level ops land on the mount ROOT, matching
        // how the SiYuan file tree exposes 新建 on the tree root.
        this.addTreeFileMenuItems(menu, mount, null);
        menu.addSeparator();
        this.addFileMenuEventItems(menu, mount.path);
        menu.addItem((item) =>
          item.setTitle('编辑这个挂载…').setIcon('settings' as never).onClick(() => this.plugin.editMount(mount)),
        );
        menu.addItem((item) =>
          item.setTitle('重新扫描').setIcon('refresh-cw' as never).onClick(() => this.refreshMounts()),
        );
        menu.addItem((item) =>
          item
            .setTitle(mount.pinned ? '取消固定' : '固定到顶部')
            .setIcon('pin' as never)
            .onClick(async () => {
              mount.pinned = !mount.pinned;
              await this.plugin.saveSettings();
              this.render();
            }),
        );
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle('卸载')
            .setIcon('trash' as never)
            .onClick(async () => {
              await this.plugin.removeMount(mount);
              this.render();
            }),
        );
      }

      menu.showAtMouseEvent(e);
    });
  }

  /**
   * Drag the mount's header to reorder the list.
   *
   * HTML5 drag-and-drop, not a pointer handler: the rows already own click
   * (expand/collapse) and contextmenu, and a drag gesture never fires click, so
   * the two do not fight. The order is written straight into
   * `settings.externalMounts`, which is what `render()` reads.
   */
  private wireDragReorder(section: HTMLElement, head: HTMLElement, mount: ExternalMount): void {
    head.draggable = true;
    head.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', mount.id);
      // Firefox refuses to start a drag without some payload being set.
      e.dataTransfer?.setData('application/x-logseq-mount', mount.id);
      e.dataTransfer!.effectAllowed = 'move';
      section.addClass('is-dragging');
    });
    head.addEventListener('dragend', () => {
      section.removeClass('is-dragging');
      section.removeClass('is-drop-target');
    });
    section.addEventListener('dragover', (e) => {
      const id = e.dataTransfer?.getData('application/x-logseq-mount');
      if (!id || id === mount.id) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      section.addClass('is-drop-target');
    });
    section.addEventListener('dragleave', () => section.removeClass('is-drop-target'));
    section.addEventListener('drop', (e) => {
      const id = e.dataTransfer?.getData('application/x-logseq-mount');
      section.removeClass('is-drop-target');
      if (!id || id === mount.id) return;
      e.preventDefault();
      void this.plugin.reorderMount(id, mount.id);
      this.render();
    });
  }

  private toggleNode(mount: ExternalMount, rel: string): void {
    const st = this.states.get(mount.id);
    if (!st) return;
    if (st.open.has(rel)) st.open.delete(rel);
    else st.open.add(rel);
    this.render();
  }

  /**
   * Forward the native `file-menu` event so THIS menu carries everything the
   * file explorer's would — most importantly the items OTHER PLUGINS add.
   *
   * The file is resolved to its `TExternalFile` (`file:`-prefixed lookup,
   * Obsidian 1.14.4+); handlers receive a real TAbstractFile, so items that
   * act through the vault API work unchanged. A neutral source string keeps
   * most core-explorer entries out — 新建 / 重命名 / 删除 already exist above
   * via the SiYuan-parity block — but handlers otherwise append freely
   * (Obsidian sorts the menu by section at show time, so placement is the
   * menu's business, not ours). One broken handler must not take the whole
   * menu down, hence the try/catch. Returns whether the forward actually
   * happened, so callers can skip items the handlers already provide —
   * 「复制绝对路径」 in particular is added by the open-with group.
   */
  private addFileMenuEventItems(menu: Menu, abs: string): boolean {
    if (!this.plugin.canOpenNativeExternal()) return false;
    const af = this.app.vault.getAbstractFileByPath(`file:${abs.replace(/\\/g, '/')}`);
    if (!af) return false;
    menu.addSeparator();
    try {
      this.app.workspace.trigger('file-menu', menu, af, 'logseq-mount-panel');
    } catch (e) {
      console.error('file-menu handler failed for', abs, e);
      return false;
    }
    // Some handlers re-offer entries this menu already added earlier (the
    // known case is 重命名). First occurrence wins; separators carry no title
    // and stay. `items` is undocumented — hence the cast — and the dedupe
    // splices IN PLACE, so the live array is the one being mutated.
    const items = (menu as unknown as { items: Array<{ title?: string } | null> }).items;
    const seen = new Set<string>();
    for (let i = items.length - 1; i >= 0; i--) {
      const t = (items[i]?.title ?? '').trim();
      if (!t) continue;
      if (seen.has(t)) items.splice(i, 1);
      else seen.add(t);
    }
    return true;
  }

  // ------------------------------------------------------------------
  // file management on the external tree (思源文件树对齐)
  // ------------------------------------------------------------------

  /**
   * 新建文件 / 新建文件夹 / 重命名 / 删除,对齐思源文件树
   * (siyuan-editor components/file-tree.ts) 的四个入口。
   *
   * node == null 表示挂载根:只给两个新建(重命名/删除属于挂载本身,
   * 归「编辑这个挂载…/卸载」管,不在这里给)。
   */
  private addTreeFileMenuItems(menu: Menu, mount: ExternalMount, node: MountNode | null): void {
    const dirNode = node?.isDir ? node : null;
    const newDirAbs = dirNode ? dirNode.abs : node ? parentAbsOf(node.rel, mount.path) : mount.path;
    // 新建目标:文件夹节点/挂载根进它自己;文件节点进它的上级目录。
    const canNew = node === null || node.isDir || true; // 文件也能在其上级新建,始终给
    void canNew;

    menu.addItem((item) =>
      item
        .setTitle('新建文件')
        .setIcon('file-plus' as never)
        .onClick(() => this.promptNewFile(mount, newDirAbs, dirNode?.rel ?? (node ? parentRelOf(node.rel) : ''))),
    );
    menu.addItem((item) =>
      item
        .setTitle('新建文件夹')
        .setIcon('folder-plus' as never)
        .onClick(() => this.promptNewFolder(mount, newDirAbs, dirNode?.rel ?? (node ? parentRelOf(node.rel) : ''))),
    );
    if (node) {
      menu.addItem((item) =>
        item
          .setTitle('重命名')
          .setIcon('text-cursor-input' as never)
          .onClick(() => this.promptRename(mount, node)),
      );
      menu.addItem((item) =>
        item
          .setTitle('删除…')
          .setIcon('trash-2' as never)
          .onClick(() => this.promptDelete(mount, node)),
      );
    }
  }

  /** 刷新扫描缓存并重绘;openRel 非空时确保该目录处于展开态。 */
  private rescan(mount: ExternalMount, openRel = ''): void {
    const st = this.states.get(mount.id);
    if (openRel) st?.open.add(openRel);
    this.scan(mount, true);
    this.render();
  }

  private promptNewFile(mount: ExternalMount, dirAbs: string, dirRel: string): void {
    new NamePromptModal(
      this.app,
      { title: '新建文件', placeholder: 'untitled.md', validate: validateEntryName },
      (name) => {
        if (!name) return;
        const abs = joinAbs(dirAbs, name);
        const r = createEmptyFile(abs);
        if (!r.ok) {
          new Notice(`创建失败：${r.error ?? '未知错误'}`);
          return;
        }
        new Notice(`已创建 ${name}`);
        this.rescan(mount, dirRel);
      },
    ).open();
  }

  private promptNewFolder(mount: ExternalMount, dirAbs: string, dirRel: string): void {
    new NamePromptModal(
      this.app,
      { title: '新建文件夹', placeholder: 'new-folder', validate: validateEntryName },
      (name) => {
        if (!name) return;
        const r = ensureDirX(joinAbs(dirAbs, name));
        if (!r.ok) {
          new Notice(`创建失败：${r.error ?? '未知错误'}`);
          return;
        }
        new Notice(`已创建 ${name}`);
        this.rescan(mount, dirRel);
      },
    ).open();
  }

  private promptRename(mount: ExternalMount, node: MountNode): void {
    new NamePromptModal(
      this.app,
      { title: '重命名', initial: node.name, validate: validateEntryName },
      (name) => {
        if (!name || name === node.name) return;
        const r = renameEntry(node.abs, name);
        if (!r.ok) {
          new Notice(`重命名失败：${r.error ?? '未知错误'}`);
          return;
        }
        // 已链接节点跟着改名:链接名就是旧文件名,不拆链的话
        // isLinked 会继续「看见」旧名并误报已链接。
        // renameEntry(abs, newName) 在 abs 自己的父目录下改名,
        // 所以这里传裸名 name 而不是完整目标路径 —— 传完整路径会被
        // validateEntryName 的非法字符检查拒掉(实测踩过)。
        const base = this.plugin.vaultBasePath();
        const oldLink = base ? linkTargetFor(base, node.name, safeSegment(node.name)) : '';
        if (base && exists(oldLink)) {
          const rr = renameEntry(oldLink, name);
          if (!rr.ok) new Notice(`链接未同步改名：${rr.error ?? '未知错误'}`);
        }
        new Notice(`已重命名为 ${name}`);
        this.rescan(mount, parentRelOf(node.rel));
      },
    ).open();
  }

  private promptDelete(mount: ExternalMount, node: MountNode): void {
    const typeStr = node.isDir ? '文件夹' : '文件';
    new ConfirmModal(
      this.app,
      {
        title: `删除${typeStr}`,
        body: `确定删除${typeStr}「${node.name}」${node.isDir ? '及其全部内容' : ''}吗？将移入系统回收站。`,
        confirmText: '删除',
        dangerous: true,
      },
      (ok) => {
        if (!ok) return;
        // 先拆链接:硬链接删掉只是去掉目录项,但留着会指向一个不再存在的名字。
        const base = this.plugin.vaultBasePath();
        const oldLink = base ? linkTargetFor(base, node.name, safeSegment(node.name)) : '';
        if (base && exists(oldLink)) removeLink(oldLink);
        void trashEntry(node.abs).then((r) => {
          if (r.ok) {
            new Notice('已移入回收站');
            this.rescan(mount, parentRelOf(node.rel));
            return;
          }
          // 没有回收站(或系统拒绝):二次确认后永久删除,绝不静默。
          new ConfirmModal(
            this.app,
            {
              title: '无法移入回收站',
              body: `${r.error ?? '此系统不支持回收站'}。要永久删除「${node.name}」吗？此操作不可恢复。`,
              confirmText: '永久删除',
              dangerous: true,
            },
            (ok2) => {
              if (!ok2) return;
              const rr = deletePermanent(node.abs, node.isDir);
              if (!rr.ok) new Notice(`删除失败：${rr.error ?? '未知错误'}`);
              else new Notice('已永久删除');
              this.rescan(mount, parentRelOf(node.rel));
            },
          ).open();
        });
      },
    ).open();
  }

  // ------------------------------------------------------------------
  // linking
  // ------------------------------------------------------------------

  /**
   * Expose one node inside the vault as a real path.
   *
   * Folder → junction, file → hard link, chosen automatically because Windows
   * refuses a junction for a file and refuses symlinks without privileges. The
   * link lands in `Mounts/`, which must be a VISIBLE folder: links under a
   * dot-prefixed parent are readable through `vault.adapter` but never indexed,
   * which makes them look fine on disk and dead in the app.
   */
  private async linkNode(node: MountNode, linkName: string): Promise<void> {
    const base = this.plugin.vaultBasePath();
    if (!base) {
      new Notice('无法获取库根路径。');
      return;
    }
    const target = linkTargetFor(base, node.name, linkName);
    const r = createLink(node.abs, target);
    if (!r.ok) {
      new Notice(`链接失败：${r.error ?? '未知错误'}`);
      return;
    }
    this.render();
    new Notice(
      r.kind === 'junction'
        ? `已链接文件夹到 ${MOUNT_FOLDER}/${linkName}`
        : `已链接文件到 ${MOUNT_FOLDER}/${linkName}（硬链接：直接编辑原文件）`,
    );
    // Open it straight away so the user sees the result, not just a toast.
    // A link made just now is not in the index yet, so wait for it before
    // opening by name — otherwise this lands on the "empty" placeholder.
    const rel = linkVaultPath(linkName);
    if (await this.plugin.waitForIndex(rel)) {
      await this.plugin.app.workspace.openLinkText(rel, '', false);
    } else {
      new Notice('链接已建立，稍后即可在库中打开。');
    }
  }

  /**
   * Is this entry already linked into the vault?
   *
   * Read from the filesystem rather than kept in a Set: a link can also be
   * created by a plain click (which links before opening) or by another tool,
   * and an in-memory flag would then be stale — the menu would offer to create a
   * link that already exists.
   */
  private isLinked(node: MountNode): boolean {
    const base = this.plugin.vaultBasePath();
    if (!base) return false;
    return exists(linkTargetFor(base, node.name, safeSegment(node.name)));
  }

  private unlinkNode(node: MountNode): void {
    const base = this.plugin.vaultBasePath();
    if (!base) return;
    const target = linkTargetFor(base, node.name, safeSegment(node.name));
    const r = removeLink(target);
    if (!r.ok) new Notice(`取消链接失败：${r.error ?? '未知错误'}`);
    else new Notice('已从库中移除链接（外部文件未受影响）');
    this.render();
  }

  /**
   * Unlink by absolute path, for the e2e probe to exercise the real path
   * rather than a filesystem call of its own.
   */
  unlinkByAbs(abs: string): { ok: boolean; error?: string } {
    const base = this.plugin.vaultBasePath();
    if (!base) return { ok: false, error: '无法获取库根路径' };
    const name = abs.split(/[\\/]+/).pop() ?? 'mount';
    const r = removeLink(linkTargetFor(base, name, safeSegment(name)));
    if (r.ok) this.render();
    return r;
  }
}

// Small helper kept out of the class for readability.
/** The directory containing `rel`, if the cached scan has it. */
function parentNodeOf(st: MountState, rel: string): MountNode | null {
  const idx = rel.lastIndexOf('/');
  if (idx < 0) return null;
  return findNode(st.tree, rel.slice(0, idx));
}

function findNode(nodes: MountNode[], rel: string): MountNode | null {
  for (const n of nodes) {
    if (n.rel === rel) return n;
    const hit = findNode(n.children, rel);
    if (hit) return hit;
  }
  return null;
}

/** rel 的父目录相对路径；顶层返回 ''（挂载根）。 */
function parentRelOf(rel: string): string {
  const idx = rel.lastIndexOf('/');
  return idx < 0 ? '' : rel.slice(0, idx);
}

/** 挂载根 + 父目录相对路径 → 绝对路径（与 joinAbs 一致，只是先算 rel）。 */
function parentAbsOf(rel: string, mountRoot: string): string {
  return joinAbs(mountRoot, parentRelOf(rel));
}
