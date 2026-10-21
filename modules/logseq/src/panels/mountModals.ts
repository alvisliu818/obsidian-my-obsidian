/**
 * Modals for configuring mounts: add/edit one, and manage the list.
 *
 * A Modal rather than a native picker because Obsidian's `showFolderPicker` and
 * `showOpenDialog` are both `undefined` in this build (measured), so the path is
 * typed or pasted. The regex fields are validated with the SAME compiler the
 * tree uses, so a pattern accepted here cannot behave differently there.
 */

import { Modal, Notice, Setting } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { compileFilter, validateMountPath } from '../features/mountFilter';
import { isDirectory } from '../features/extFs';
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

/** Add a new mount, or edit `mount` when one is given.
 *  `attachTo` 非空时 = 嵌套挂载:保存后渲染在该宿主挂载项之下
 *  (si-yuan 虚拟文档树的「挂载文件/文件夹…「xxx」下」语义)。 */
export class MountEditorModal extends Modal {
  plugin: LogseqEditorPlugin;
  private draft: MountDraft;
  private editing: ExternalMount | null;
  private attachTo?: string;

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
      this.editing ? '编辑外部挂载' : hostLabel ? `挂载到「${hostLabel}」下` : '挂载外部文件夹',
    );
    this.display();
  }

  private display(): void {
    const { contentEl } = this;
    contentEl.empty();
    clearErrors(this);

    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: '把库外的文件夹显示到挂载面板。Markdown 会在原地编辑并存回原文件，不会复制进库。',
    });

    new Setting(contentEl)
      .setName('文件夹路径')
      .setDesc('库外的绝对路径，例如 D:\\notes\\inbox')
      .addText((t) =>
        t.setPlaceholder('D:\\notes\\inbox').setValue(this.draft.path).onChange((v) => {
          this.draft.path = v;
        }),
      );

    new Setting(contentEl)
      .setName('显示名称')
      .setDesc('在面板中显示的名称。留空则使用文件夹自身的名字。')
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
    const trimmed = this.draft.path.trim().replace(/[\\/]+$/, '');
    if (!isDirectory(trimmed)) {
      showError(this, `文件夹不存在：${trimmed}`);
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
