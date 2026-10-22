/**
 * Modals for configuring mounts: add/edit one, and manage the list.
 *
 * The path can be typed OR picked: the 浏览 buttons open the real Windows
 * Explorer through Electron's remote dialog (see `features/systemDialog`), and
 * the folder the dialog was last left in is remembered per vault, so a second
 * mount in the same area starts where the first one ended. Typing stays
 * supported — the picker is an addition, not a replacement.
 *
 * The regex fields are validated with the SAME compiler the tree uses, so a
 * pattern accepted here cannot behave differently there.
 */

import { Modal, Notice, Setting, TextComponent } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { compileFilter, dirPruned, entryMatches, validateMountPath, type MountNode } from '../features/mountFilter';
import { exists, isDirectory, joinAbs, scanExternal } from '../features/extFs';
import {
  hasSystemPicker,
  pickExternalPath,
  rememberedDirFor,
  startDirFor,
  type PickKind,
} from '../features/systemDialog';
import { mountDisplayName, mountHostLabel, mountHostOf, type ExternalMount } from '../types';

/** Form state (everything is a string until it is committed). */
interface MountDraft {
  path: string;
  label: string;
  include: string;
  exclude: string;
  refreshSeconds: string;
  enabled: boolean;
}

function draftFrom(m?: ExternalMount): MountDraft {
  return {
    path: m?.path ?? '',
    label: m?.label ?? '',
    include: m?.include ?? '',
    // node_modules and .git are noise in almost every external folder, so they
    // are excluded by default — the user can clear the field.
    exclude: m?.exclude ?? 'node_modules|[\\\\/]\\.git[\\\\/]',
    refreshSeconds: String(m?.refreshSeconds ?? 0),
    enabled: m?.enabled ?? true,
  };
}

function showError(modal: Modal, text: string): void {
  modal.contentEl.createDiv({ cls: 'logseq-mount-modal-error', text });
}

function clearErrors(modal: Modal): void {
  modal.contentEl.querySelectorAll('.logseq-mount-modal-error').forEach((n) => n.remove());
}

/** 一次赋一组内联样式（选择器的树行是弹窗私有 UI，不值得进 styles.css）。 */
function setStyles(el: HTMLElement, styles: Readonly<Record<string, string>>): void {
  Object.assign(el.style, styles);
}

/** Add a new mount, or edit `mount` when one is given.
 *  `attachTo` 非空时 = 嵌套挂载:保存后渲染在该宿主挂载项之下
 *  (si-yuan 虚拟文档树的「挂载文件/文件夹…「xxx」下」语义)。 */
export class MountEditorModal extends Modal {
  plugin: LogseqEditorPlugin;
  private draft: MountDraft;
  private editing: ExternalMount | null;
  private attachTo?: string;
  /** The path field, so a pick can write straight back into it. */
  private pathInput: TextComponent | null = null;

  constructor(plugin: LogseqEditorPlugin, mount?: ExternalMount, attachTo?: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.editing = mount ?? null;
    this.attachTo = attachTo;
    this.draft = draftFrom(mount);
  }

  onOpen(): void {
    // attachTo 现在是 `hostId` 或 `hostId/子路径`，所以宿主标签要带上子路径，
    // 否则用户看不出「到底挂在了哪个文件夹/文件下面」。
    const host = this.attachTo
      ? (this.plugin.settings.externalMounts ?? []).find((m) => m.id === mountHostOf(this.attachTo!).hostId)
      : null;
    const hostLabel = host ? mountHostLabel({ ...host, attachTo: this.attachTo }, this.plugin.settings.externalMounts ?? []) : '';
    this.titleEl.setText(
      this.editing
        ? '编辑外部挂载'
        : hostLabel
          ? `挂载到「${hostLabel}」下`
          : '挂载外部文件或文件夹',
    );
    this.display();
  }

  private display(): void {
    const { contentEl } = this;
    contentEl.empty();
    clearErrors(this);
    this.pathInput = null;

    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: '把库外的文件夹或单个文件挂到挂载面板。Markdown 会在原地编辑并存回原文件，不会复制进库。',
    });

    const pathSetting = new Setting(contentEl)
      .setName('文件或文件夹路径')
      .setDesc('库外的绝对路径，例如 D:\\notes\\inbox。也可以直接挂单个文件。')
      .addText((t) => {
        this.pathInput = t;
        t.setPlaceholder('D:\\notes\\inbox').setValue(this.draft.path).onChange((v) => {
          this.draft.path = v;
        });
      });
    if (hasSystemPicker()) {
      pathSetting
        .addButton((b) =>
          b.setButtonText('浏览文件夹').setTooltip('打开系统资源管理器选择文件夹').onClick(() => {
            void this.browse('folder');
          }),
        )
        .addButton((b) =>
          b.setButtonText('选择文件').setTooltip('打开系统资源管理器选择文件').onClick(() => {
            void this.browse('file');
          }),
        );
    }

    new Setting(contentEl)
      .setName('显示名称')
      .setDesc('在面板中显示的名称。留空则使用文件或文件夹自身的名字。')
      .addText((t) =>
        t.setPlaceholder('收件箱').setValue(this.draft.label).onChange((v) => {
          this.draft.label = v;
        }),
      );

    if (this.plugin.settings.mountFilterEnabled === true) {
      new Setting(contentEl)
        .setName('包含正则')
        .setDesc('只显示匹配此式的文件。留空 = 全部显示。例如 \\.md$')
        .addText((t) =>
          t.setPlaceholder('\\.md$').setValue(this.draft.include).onChange((v) => {
            this.draft.include = v;
          }),
        );

      new Setting(contentEl)
        .setName('排除正则')
        .setDesc('隐藏匹配此式的条目，即使它匹配包含正则。例如 node_modules|[\\\\/]\\.git[\\\\/]')
        .addText((t) =>
          t.setPlaceholder('node_modules').setValue(this.draft.exclude).onChange((v) => {
            this.draft.exclude = v;
          }),
        );
    } else {
      // 过滤关闭时这两个字段不渲染（用户要求）：正则仍保留在挂载配置里，
      // 一个字都不会丢，开启「启用挂载过滤」后这里恢复成输入框。
      new Setting(contentEl)
        .setName('包含 / 排除正则')
        .setDesc(
          '挂载过滤当前是关闭的（设置 → 外部挂载 → 启用挂载过滤），' +
            '已配置的正则保留但不生效；开启过滤后即可在这里编辑。',
        );
    }

    new Setting(contentEl)
      .setName('自动刷新（秒）')
      .setDesc('按间隔重新扫描这个挂载。0 = 仅在手动点重新扫描时。')
      .addText((t) =>
        t.setPlaceholder('0').setValue(this.draft.refreshSeconds).onChange((v) => {
          this.draft.refreshSeconds = v;
        }),
      );

    new Setting(contentEl)
      .setName('启用')
      .addToggle((t) =>
        t.setValue(this.draft.enabled).onChange((v) => {
          this.draft.enabled = v;
        }),
      );

    const actions = new Setting(contentEl);
    actions.addButton((b) =>
      b
        .setButtonText('保存')
        .setCta()
        .onClick(async () => {
          if (await this.commit()) this.close();
        }),
    );
    actions.addButton((b) => b.setButtonText('取消').onClick(() => this.close()));
  }

  /**
   * Open the OS picker and drop the result into the path field.
   *
   * The location is remembered as soon as something is chosen (not only when
   * the mount is saved), so a cancelled mount still leaves the dialog where
   * the user was working.
   */
  private async browse(kind: PickKind): Promise<void> {
    const current = this.draft.path.trim();
    const picked = await pickExternalPath({
      kind,
      startDir: startDirFor(current, isDirectory(current), this.plugin.settings.mountPickDir ?? ''),
    });
    if (!picked) return;
    this.draft.path = picked;
    this.pathInput?.setValue(picked);
    const dir = rememberedDirFor(picked, kind);
    if (dir && dir !== this.plugin.settings.mountPickDir) {
      this.plugin.settings.mountPickDir = dir;
      void this.plugin.saveSettings();
    }
  }

  private async commit(): Promise<boolean> {
    clearErrors(this);
    const pathError = validateMountPath(this.draft.path);
    if (pathError) {
      showError(this, pathError);
      return false;
    }
    // Compile through the real compiler, so what is accepted here and what
    // actually applies in the tree cannot drift apart.
    const compiled = compileFilter({ include: this.draft.include, exclude: this.draft.exclude });
    if (compiled.errors.include) {
      showError(this, `包含正则无效：/${compiled.errors.include}/`);
      return false;
    }
    if (compiled.errors.exclude) {
      showError(this, `排除正则无效：/${compiled.errors.exclude}/`);
      return false;
    }
    // A mounted FILE is legal too (the panel renders it as a single row), so
    // existence is the only check here — a directory is not required.
    const trimmed = this.draft.path.trim().replace(/[\\/]+$/, '');
    if (!exists(trimmed)) {
      showError(this, `路径不存在：${trimmed}`);
      return false;
    }
    const secs = Number(this.draft.refreshSeconds);
    if (!Number.isFinite(secs) || secs < 0) {
      showError(this, '自动刷新必须是秒数（0 表示关闭）。');
      return false;
    }

    if (this.editing) {
      const m = this.editing;
      m.path = trimmed;
      m.label = this.draft.label;
      m.include = this.draft.include;
      m.exclude = this.draft.exclude;
      m.refreshSeconds = Math.min(secs, 3600);
      m.enabled = this.draft.enabled;
      await this.plugin.saveSettings();
      this.plugin.refreshMounts();
      new Notice(`已更新 ${mountDisplayName(m)}`);
      return true;
    }

    await this.plugin.addMount({
      path: trimmed,
      label: this.draft.label,
      include: this.draft.include,
      exclude: this.draft.exclude,
      refreshSeconds: Math.min(secs, 3600),
      pinned: false,
      ...(this.attachTo ? { attachTo: this.attachTo } : {}),
    });
    new Notice('挂载已保存');
    return true;
  }
}

/** List every mount with per-row edit / rescan / unmount. */
export class MountListModal extends Modal {
  plugin: LogseqEditorPlugin;

  constructor(plugin: LogseqEditorPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText('外部挂载');
    this.display();
  }

  private display(): void {
    const { contentEl } = this;
    contentEl.empty();
    const mounts = this.plugin.settings.externalMounts ?? [];

    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: '显示在挂载面板里的库外文件夹。Markdown 仍是唯一真值——挂载的文件在原地编辑，绝不复制进库。',
    });

    if (mounts.length === 0) {
      contentEl.createDiv({ cls: 'logseq-mount-modal-empty', text: '暂无挂载。' });
    }

    for (const m of mounts) {
      const row = contentEl.createDiv({ cls: 'logseq-mount-list-row' });
      const head = row.createDiv({ cls: 'logseq-mount-list-head' });
      head.createSpan({ cls: 'logseq-mount-list-name', text: mountDisplayName(m) });
      if (!m.enabled) head.createSpan({ cls: 'logseq-mount-list-off', text: '已停用' });
      if (m.attachTo) {
        head.createSpan({ cls: 'logseq-mount-list-off', text: `嵌套于 ${mountHostLabel(m, mounts)}` });
      }
      if (!isDirectory(m.path)) head.createSpan({ cls: 'logseq-mount-list-warn', text: '路径不存在' });
      row.createDiv({ cls: 'logseq-mount-list-path', text: m.path });

      const filters = row.createDiv({ cls: 'logseq-mount-list-filters' });
      if (m.include.trim()) filters.createSpan({ cls: 'logseq-mount-list-include', text: `+/${m.include}/` });
      if (m.exclude.trim()) filters.createSpan({ cls: 'logseq-mount-list-exclude', text: `-/${m.exclude}/` });
      if (m.refreshSeconds > 0) filters.createSpan({ cls: 'logseq-mount-list-refresh', text: `${m.refreshSeconds}s` });

      const actions = row.createDiv({ cls: 'logseq-mount-list-actions' });
      actions.createEl('button', { cls: 'mod-cta', text: '编辑' }).addEventListener('click', () => {
        new MountEditorModal(this.plugin, m).open();
      });
      actions.createEl('button', { text: '重新扫描' }).addEventListener('click', () => {
        this.plugin.refreshMounts();
        new Notice('挂载已重新扫描');
      });
      actions.createEl('button', { text: '卸载' }).addEventListener('click', async () => {
        await this.plugin.removeMount(m);
        this.display();
      });
    }

    const foot = new Setting(contentEl);
    foot.addButton((b) =>
      b
        .setButtonText('添加挂载')
        .setCta()
        .onClick(() => new MountEditorModal(this.plugin).open()),
    );
    foot.addButton((b) => b.setButtonText('关闭').onClick(() => this.close()));
  }
}

/**
 * Pick where a new mount lands in the panel: before any existing mount, or
 * at the end. Opened by the tree row's 挂载 action, where path and label come
 * from the row itself — only the position needs choosing. With no existing
 * mounts there is nothing to choose, so callers add directly instead.
 */
export class MountPositionModal extends Modal {
  plugin: LogseqEditorPlugin;
  private draft: Omit<ExternalMount, 'id' | 'enabled'>;

  constructor(plugin: LogseqEditorPlugin, draft: Omit<ExternalMount, 'id' | 'enabled'>) {
    super(plugin.app);
    this.plugin = plugin;
    this.draft = draft;
  }

  onOpen(): void {
    this.titleEl.setText('选择挂载位置');
    this.display();
  }

  private display(): void {
    const { contentEl } = this;
    contentEl.empty();
    const name = this.draft.label.trim() || this.draft.path;

    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: `把「${name}」作为独立条目挂到虚拟文档树。选择它在挂载列表中的位置：`,
    });

    const mounts = this.plugin.settings.externalMounts ?? [];
    mounts.forEach((m, i) => {
      const row = contentEl.createDiv({ cls: 'logseq-mount-list-row' });
      const head = row.createDiv({ cls: 'logseq-mount-list-head' });
      head.createSpan({ cls: 'logseq-mount-list-name', text: mountDisplayName(m) });
      if (!m.enabled) head.createSpan({ cls: 'logseq-mount-list-off', text: '已停用' });
      const actions = row.createDiv({ cls: 'logseq-mount-list-actions' });
      actions.createEl('button', { cls: 'mod-cta', text: `挂到「${mountDisplayName(m)}」之前` }).addEventListener(
        'click',
        () => void this.commit(i),
      );
    });

    const end = contentEl.createDiv({ cls: 'logseq-mount-list-row' });
    end
      .createEl('button', { cls: 'mod-cta', text: '挂到面板末尾' })
      .addEventListener('click', () => void this.commit(mounts.length));

    const foot = new Setting(contentEl);
    foot.addButton((b) => b.setButtonText('取消').onClick(() => this.close()));
  }

  private async commit(atIndex: number): Promise<void> {
    const m = await this.plugin.addMount(this.draft, atIndex);
    new Notice(`已挂载 ${mountDisplayName(m)}`);
    this.close();
  }
}

/**
 * 「挂载到…」的目标位置是否合法（纯函数，好测）。
 *
 * 唯一禁区：目标位置的磁盘绝对路径落在**源条目内部**（含相等）。那会让新
 * 挂载的子树里再渲染出它自己的挂载点，flatten 无限递归。跨挂载的间接成环
 * （源在 m1、m1 又挂自源内部等）同样被这条规则罩住——它只比较真实磁盘
 * 路径，不关心挂载链怎么绕。反方向（把祖先挂到子孙里）不成环，允许。
 */
export function mountTargetForbidden(sourceAbs: string, mountPath: string, rel: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase();
  const src = norm(sourceAbs);
  const loc = norm(rel ? joinAbs(mountPath, rel) : mountPath);
  return loc === src || loc.startsWith(`${src}\\`) || loc.startsWith(`${src}/`);
}

/** 「挂载到…」选中一个位置后回传给调用方的结果。 */
export interface MountTargetPick {
  /** 直接写入新挂载的 attachTo：`hostId` 或 `hostId/子路径`。 */
  attachTo: string;
  /** 位置描述（宿主名/宿主名+子路径），给 Notice 与确认按钮用。 */
  label: string;
}

/**
 * 「挂载到…」的目标选择器：浏览虚拟文档树（所有启用挂载的树，逐层懒加载），
 * 选一个位置（挂载项根、子文件夹或文件），把源条目以嵌套挂载引用过去。
 *
 * - 树行三种：挂载头（顶层列表 + 嵌套头行）、真实文件/文件夹。单击选中，
 *   caret 展开；文件也可选——文件能承载嵌套挂载（容器语义）。
 * - 选中的位置以 `attachTo` 高亮回填，底部「挂载到这里」确认。
 * - 禁区行（mountTargetForbidden）灰显不可选，title 说明原因。
 *
 * 自带一份懒加载层缓存：面板的 loadLayer 是私有状态，弹窗在面板之外
 * 生命周期独立，复制这 20 行扫描逻辑（同一套纯函数）比拉出共享接口省事。
 * 选择器只服务选位，不接拖拽序/已加载统计那些面板语义。
 */
export class MountTargetPickerModal extends Modal {
  private plugin: LogseqEditorPlugin;
  private sourceName: string;
  private sourceAbs: string;
  private onPick: (t: MountTargetPick) => void;
  /** mountId -> 已加载的层（rel -> children）。 */
  private layers = new Map<string, Map<string, MountNode[]>>();
  /** mountId -> 展开的 rel 集（'' = 挂载根）。 */
  private openMap = new Map<string, Set<string>>();
  private picked: MountTargetPick | null = null;
  private pickBtn: HTMLButtonElement | null = null;
  private treeEl: HTMLElement | null = null;

  constructor(
    plugin: LogseqEditorPlugin,
    opts: { sourceName: string; sourceAbs: string; onPick: (t: MountTargetPick) => void },
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.sourceName = opts.sourceName;
    this.sourceAbs = opts.sourceAbs;
    this.onPick = opts.onPick;
  }

  onOpen(): void {
    this.titleEl.setText(`把「${this.sourceName}」挂载到…`);
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: '在虚拟文档树里选一个位置（挂载项、子文件夹或文件），把这个条目以嵌套挂载引用过去。只是加一个入口，不动磁盘上的原图。',
    });
    this.treeEl = this.contentEl.createDiv({ cls: 'logseq-mount-picker-tree' });
    setStyles(this.treeEl, {
      maxHeight: '46vh',
      overflowY: 'auto',
      border: '1px solid var(--background-modifier-border)',
      borderRadius: '6px',
      padding: '4px',
    });
    this.renderTree();

    const foot = this.contentEl.createDiv();
    setStyles(foot, { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' });
    foot.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
    const ok = foot.createEl('button', { cls: 'mod-cta', text: '挂载到这里' }) as HTMLButtonElement;
    ok.disabled = true;
    ok.addEventListener('click', () => this.confirm());
    this.pickBtn = ok;
  }

  private confirm(): void {
    if (!this.picked) return;
    this.close();
    this.onPick(this.picked);
  }

  /** 顶层挂载：无 attachTo，或宿主不存在/停用（与面板的回落规则一致）。 */
  private topLevelMounts(): ExternalMount[] {
    const all = this.plugin.settings.externalMounts ?? [];
    return all.filter((m) => {
      if (!m.enabled) return false;
      if (!m.attachTo) return true;
      const { hostId } = mountHostOf(m.attachTo);
      const host = all.find((h) => h.id === hostId);
      return !host || !host.enabled;
    });
  }

  /** 某挂载内 `rel` 之下（enabled 的）嵌套挂载。 */
  private nestedAt(hostId: string, hostRel: string): ExternalMount[] {
    return (this.plugin.settings.externalMounts ?? []).filter((m) => {
      if (!m.enabled || !m.attachTo) return false;
      const h = mountHostOf(m.attachTo);
      return h.hostId === hostId && h.hostRel === hostRel;
    });
  }

  /** 懒加载一层的真实子项（带挂载自己的过滤规则；选择器不做拖拽序）。 */
  private childrenOf(mountId: string, rel: string): MountNode[] {
    let byRel = this.layers.get(mountId);
    if (!byRel) {
      byRel = new Map();
      this.layers.set(mountId, byRel);
    }
    const hit = byRel.get(rel);
    if (hit) return hit;
    const m = (this.plugin.settings.externalMounts ?? []).find((x) => x.id === mountId);
    let children: MountNode[] = [];
    if (m) {
      const f = compileFilter({ include: m.include, exclude: m.exclude });
      const dirAbs = rel ? joinAbs(m.path, rel) : m.path;
      if (isDirectory(dirAbs)) {
        const { entries } = scanExternal(dirAbs, {
          shouldEnterDir: (childRel) => !dirPruned(rel ? `${rel}/${childRel}` : childRel, f),
          keepFile: (childRel) => entryMatches(rel ? `${rel}/${childRel}` : childRel, f),
          depth: 0,
        });
        children = entries.map((e) => ({
          name: e.name,
          rel: rel ? `${rel}/${e.rel}` : e.rel,
          abs: e.abs,
          isDir: e.isDir,
          children: [],
        }));
        children.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      }
    }
    byRel.set(rel, children);
    return children;
  }

  private isOpen(mountId: string, rel: string): boolean {
    return this.openMap.get(mountId)?.has(rel) === true;
  }

  private toggleOpen(mountId: string, rel: string): void {
    let set = this.openMap.get(mountId);
    if (!set) {
      set = new Set();
      this.openMap.set(mountId, set);
    }
    if (set.has(rel)) set.delete(rel);
    else set.add(rel);
    this.renderTree();
  }

  private renderTree(): void {
    const list = this.treeEl;
    if (!list) return;
    const top = list.scrollTop;
    list.empty();
    const tops = this.topLevelMounts();
    if (tops.length === 0) {
      list.createDiv({ cls: 'setting-item-description', text: '还没有可用的挂载项。' });
      return;
    }
    for (const m of tops) this.renderMountRow(list, m, 0, new Set());
    list.scrollTop = top;
  }

  /** 一行挂载头：可选（= 挂到该挂载根），可展开（= 浏览它的树）。 */
  private renderMountRow(container: HTMLElement, m: ExternalMount, depth: number, visited: Set<string>): void {
    const cyclic = visited.has(m.id);
    const open = this.isOpen(m.id, '');
    this.row(container, {
      depth,
      name: mountDisplayName(m),
      isMount: true,
      forbidden: mountTargetForbidden(this.sourceAbs, m.path, ''),
      expandable: !cyclic,
      open,
      attach: { attachTo: m.id, label: mountDisplayName(m) },
      onToggle: () => this.toggleOpen(m.id, ''),
    });
    if (open && !cyclic) {
      // 子层盒子直接建在 container 里:紧跟本行、先于后续兄弟行,缩进关系才对。
      const next = new Set(visited).add(m.id);
      const box = container.createDiv();
      for (const child of this.nestedAt(m.id, '')) this.renderMountRow(box, child, depth + 1, next);
      for (const n of this.childrenOf(m.id, '')) this.renderNodeRow(box, m, n, depth + 1, next);
    }
  }

  /** 一行真实文件/文件夹：可选（= 挂到该节点之下），文件夹或挂了下游挂载的可展开。 */
  private renderNodeRow(container: HTMLElement, m: ExternalMount, node: MountNode, depth: number, visited: Set<string>): void {
    const nested = this.nestedAt(m.id, node.rel);
    const open = this.isOpen(m.id, node.rel);
    this.row(container, {
      depth,
      name: node.name,
      isMount: false,
      forbidden: mountTargetForbidden(this.sourceAbs, m.path, node.rel),
      expandable: node.isDir || nested.length > 0,
      open,
      attach: { attachTo: `${m.id}/${node.rel}`, label: `${mountDisplayName(m)}/${node.rel}` },
      onToggle: () => this.toggleOpen(m.id, node.rel),
    });
    if (open) {
      const box = container.createDiv();
      const next = new Set(visited);
      for (const child of nested) this.renderMountRow(box, child, depth + 1, next);
      for (const n of this.childrenOf(m.id, node.rel)) this.renderNodeRow(box, m, n, depth + 1, next);
    }
  }

  /** 组一行树行：缩进 + caret + 名字；单击选中，caret 单击展开。 */
  private row(
    container: HTMLElement,
    o: {
      depth: number;
      name: string;
      isMount: boolean;
      forbidden: boolean;
      expandable: boolean;
      open: boolean;
      attach: MountTargetPick;
      onToggle: () => void;
    },
  ): HTMLElement {
    const row = container.createDiv({ cls: 'logseq-mount-list-row' });
    setStyles(row, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '2px 6px',
      borderRadius: '4px',
      cursor: o.forbidden ? 'not-allowed' : 'pointer',
      paddingInlineStart: `${4 + o.depth * 17}px`,
      opacity: o.forbidden ? '0.45' : '1',
    });
    if (o.forbidden) row.setAttribute('title', '不能挂到它自己内部（会无限嵌套）');
    row.dataset.attach = o.attach.attachTo;
    row.dataset.label = o.attach.label;

    const caret = row.createSpan({ text: o.expandable ? (o.open ? '▾' : '▸') : '' });
    setStyles(caret, { width: '14px', textAlign: 'center', flexShrink: '0' });
    if (o.expandable) {
      setStyles(caret, { cursor: 'pointer' });
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        o.onToggle();
      });
    }

    const name = row.createSpan({ cls: 'logseq-mount-list-name', text: o.name });
    setStyles(name, {
      flex: '1',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontWeight: o.isMount ? '600' : 'normal',
    });
    if (o.isMount) {
      const tag = row.createSpan({
        cls: 'setting-item-description',
        text: '挂载项',
      });
      setStyles(tag, { flexShrink: '0', fontSize: 'var(--font-ui-smaller)' });
    }

    if (!o.forbidden) {
      row.addEventListener('click', () => {
        this.picked = o.attach;
        this.treeEl?.querySelectorAll('.logseq-mount-list-row').forEach((n) => {
          setStyles(n as HTMLElement, { backgroundColor: '' });
        });
        setStyles(row, { backgroundColor: 'var(--background-modifier-active-hover)' });
        if (this.pickBtn) {
          this.pickBtn.disabled = false;
          this.pickBtn.textContent = `挂载到「${o.attach.label}」`;
        }
      });
    }
    return row;
  }
}
