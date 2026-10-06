import { PluginSettingTab, Setting, Notice, type App } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { SqliteConsoleModal } from '../features/sqliteConsole';
import { MountListModal } from '../panels/mountModals';
import { VIEW_TYPE_MOUNT_PANEL } from '../panels/mountPanel';
import { mountDisplayName, type PagePropsEditor, type ScopeMode, type ShortcutOverrides } from '../types';
import { SHORTCUT_GROUP_LABELS } from '../types';

export class LogseqEditorSettingTab extends PluginSettingTab {
  plugin: LogseqEditorPlugin;

  constructor(app: App, plugin: LogseqEditorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * The master dropdown's value: 'all' when every group is on, 'none' when
   * every group is off, 'custom' for any mix in between.
   */
  private shortcutPresetValue(): 'all' | 'none' | 'custom' {
    const s = this.plugin.settings.shortcuts;
    const values = Object.values(s);
    if (values.every(Boolean)) return 'all';
    if (values.every((v) => !v)) return 'none';
    return 'custom';
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Take over markdown files')
      .setDesc('Open all .md files with the Logseq-style block editor by default. You can always switch back to the native editor per file.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.takeOverByDefault).onChange(async (v) => {
          this.plugin.settings.takeOverByDefault = v;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (this.plugin.settings.takeOverByDefault) {
      new Setting(containerEl)
        .setName('Take-over scope')
        .setDesc(
          'Which files open with the block editor by default: every markdown file, or only files inside the folders listed below.',
        )
        .addDropdown((d) =>
          d
            .addOptions({ all: 'All files (except exclusions)', folders: 'Only in specific folders' })
            .setValue(this.plugin.settings.scopeMode)
            .onChange(async (v) => {
              this.plugin.settings.scopeMode = v as ScopeMode;
              await this.plugin.saveSettings();
              this.display();
            }),
        );
    }

    if (this.plugin.settings.takeOverByDefault && this.plugin.settings.scopeMode === 'folders') {
      new Setting(containerEl)
        .setName('Included folders')
        .setDesc(
          'Comma-separated folder paths where .md files open with the block editor (e.g. "journals, projects/notes"). Files outside these folders keep the native editor.',
        )
        .addText((t) =>
          t
            .setPlaceholder('journals, projects/notes')
            .setValue(this.plugin.settings.includedFolders)
            .onChange(async (v) => {
              this.plugin.settings.includedFolders = v;
              await this.plugin.saveSettings();
            }),
        );
    }

    if (this.plugin.settings.takeOverByDefault && this.plugin.settings.scopeMode === 'all') {
      new Setting(containerEl)
        .setName('Excluded folders')
        .setDesc('Comma-separated folder paths whose files keep opening with the native editor (e.g. "templates, attachments/notes").')
        .addText((t) =>
          t
            .setPlaceholder('folder1, folder2')
            .setValue(this.plugin.settings.excludedFolders)
            .onChange(async (v) => {
              this.plugin.settings.excludedFolders = v;
              await this.plugin.saveSettings();
            }),
        );
    }

    // ---------- Page properties editor ----------
    new Setting(containerEl)
      .setName('Page properties editor')
      .setDesc(
        'How the page-properties block (the file-top key:: value lines, or frontmatter) is edited inside the block editor. "Native (Obsidian properties)" mounts Obsidian\'s own properties UI — with its property type widgets and the property plugins you have installed. The file format never changes either way.',
      )
      .addDropdown((d) =>
        d
          .addOptions({ logseq: 'Logseq (key:: value text)', native: 'Native (Obsidian properties)' })
          .setValue(this.plugin.settings.pagePropsEditor)
          .onChange(async (v) => {
            this.plugin.settings.pagePropsEditor = v as PagePropsEditor;
            await this.plugin.saveSettings();
            if (v === 'native') void this.plugin.resolveNativePropsCtor();
          }),
      );

    // ---------- Shortcuts ----------
    containerEl.createEl('h3', { text: 'Shortcuts' });

    new Setting(containerEl)
      .setName('Logseq shortcuts')
      .setDesc(
        'Master switch for the Logseq-specific shortcuts below. "All" keeps the stock Logseq bindings; "None" hands every one of them back to Obsidian/CodeMirror, so the block editor edits like a plain text editor. Individual groups below can then be re-enabled one by one. This only affects the block editor — the native Obsidian editor always uses Obsidian shortcuts.',
      )
      .addDropdown((d) =>
        d
          .addOptions({
            all: 'All groups (Logseq default)',
            none: 'None (use Obsidian shortcuts)',
            custom: 'Custom — choose per group below',
          })
          .setValue(this.shortcutPresetValue())
          .onChange(async (v) => {
            if (v === 'custom') return; // driven by the per-group toggles
            const value = v === 'all';
            for (const k of Object.keys(this.plugin.settings.shortcuts) as (keyof ShortcutOverrides)[]) {
              this.plugin.settings.shortcuts[k] = value;
            }
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Each group is independent. Switching one off returns exactly those keys to Obsidian and leaves the rest alone.',
    });

    for (const key of Object.keys(SHORTCUT_GROUP_LABELS) as (keyof ShortcutOverrides)[]) {
      new Setting(containerEl)
        .setName(SHORTCUT_GROUP_LABELS[key])
        .setClass('lgp-shortcut-group')
        .addToggle((t) =>
          t.setValue(this.plugin.settings.shortcuts[key]).onChange(async (v) => {
            this.plugin.settings.shortcuts[key] = v;
            await this.plugin.saveSettings();
            // Re-render so the master dropdown flips to "Custom".
            this.display();
          }),
        );
    }

    // ---------- Outline guide line ----------
    const levelOptions = {
      '1': '1 level',
      '2': '2 levels',
      '3': '3 levels',
      '4': '4 levels',
      '5': '5 levels',
      '0': 'All levels',
    };

    new Setting(containerEl)
      .setName('Fold any block')
      .setDesc(
        'Show the collapse caret on every block whose body spans more than one line — headings, code fences, tables, quotes, images and multi-line paragraphs — not just list items with children. Click folds to a one-line summary; Alt+click folds all the way to a type chip. The state is saved as a `collapsed::` property in your markdown, exactly like a list block\'s.',
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.foldEnabled !== false)
          .onChange(async (v) => {
            this.plugin.settings.foldEnabled = v;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          }),
      );

    new Setting(containerEl)
      .setName('Hidden block properties')
      .setDesc(
        'Comma-separated property names that stay in your markdown but are not drawn as a `key:: value` row. Hiding is view-only: the property is still parsed, still indexed for queries, and still editable from the block properties menu. `collapsed` is hidden by default so folding does not litter the view.',
      )
      .addText((t) =>
        t
          .setPlaceholder('collapsed')
          .setValue(this.plugin.settings.hiddenProps ?? '')
          .onChange(async (v) => {
            this.plugin.settings.hiddenProps = v;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          }),
      );

    new Setting(containerEl)
      .setName('Guide-line collapse depth')
      .setDesc(
        'Clicking the vertical guide line folds the content inside it: the first-level blocks stay visible as folded rows while everything below them hides. This sets how many levels carry the folded state (direct children = level 1); deeper levels stay folded when you expand again. "All levels" = fold everything below the first level.',
      )
      .addDropdown((d) =>
        d
          .addOptions(levelOptions)
          .setValue(String(this.plugin.settings.guideLineCollapseLevels))
          .onChange(async (v) => {
            this.plugin.settings.guideLineCollapseLevels = Number(v);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Guide-line expand depth')
      .setDesc(
        'Clicking the line of folded content unfolds this many levels at once (direct children = level 1; the clicked block itself always opens if it was folded). "1 level" = open one step per click; "All levels" = unfold everything below.',
      )
      .addDropdown((d) =>
        d
          .addOptions(levelOptions)
          .setValue(String(this.plugin.settings.guideLineExpandLevels))
          .onChange(async (v) => {
            this.plugin.settings.guideLineExpandLevels = Number(v);
            await this.plugin.saveSettings();
          }),
      );

    // ---------- Safety: backups & operation log ----------
    containerEl.createEl('h3', { text: 'Safety (backups & log)' });

    new Setting(containerEl)
      .setName('Automatic backups')
      .setDesc('Before any write the plugin makes to your notes, save the original to .logseq-editor/backups/ (10 most recent per file). Restore via the command palette.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.backupsEnabled).onChange(async (v) => {
          this.plugin.settings.backupsEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Operation log')
      .setDesc('Record every sync/write operation (time, file, result) to .logseq-editor/log.jsonl and show it via "Show the operation log".')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.opLogEnabled).onChange(async (v) => {
          this.plugin.settings.opLogEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    // ---------- Journal (daily notes) ----------
    containerEl.createEl('h3', { text: 'Journal (daily notes)' });

    new Setting(containerEl)
      .setName('Journal folder')
      .setDesc('Folder for daily notes. Empty = use the core Daily notes plugin setting, or vault root.')
      .addText((t) =>
        t
          .setPlaceholder('e.g. journals')
          .setValue(this.plugin.settings.journalFolder)
          .onChange(async (v) => {
            this.plugin.settings.journalFolder = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Journal date format')
      .setDesc('Tokens: YYYY MM DD HH mm ss. Empty = use the core Daily notes plugin setting, or YYYY-MM-DD.')
      .addText((t) =>
        t
          .setPlaceholder('YYYY-MM-DD')
          .setValue(this.plugin.settings.journalFormat)
          .onChange(async (v) => {
            this.plugin.settings.journalFormat = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Journal template')
      .setDesc('Text written into a newly created journal file (markdown, Logseq blocks welcome).')
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.journalTemplate).onChange(async (v) => {
          this.plugin.settings.journalTemplate = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 4;
        t.inputEl.cols = 40;
      });

    // ---------- External mounts ----------
    containerEl.createEl('h3', { text: '外部挂载' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        '把库外的文件夹挂到挂载面板。Markdown 在原地编辑并存回原文件，不会复制进库。' +
        '每个挂载可以用包含 / 排除两条正则过滤；在面板里右键任意条目还可以把它链接进库，' +
        '之后就能用原生块编辑器打开（反链、块引用、搜索全部生效）。',
    });

    const mounts = this.plugin.settings.externalMounts ?? [];
    if (mounts.length === 0) {
      containerEl.createDiv({ cls: 'setting-item-description', text: '暂无外部挂载。' });
    }
    for (const m of mounts) {
      new Setting(containerEl)
        .setName(mountDisplayName(m))
        .setDesc(m.path)
        .addExtraButton((b) =>
          b
            .setIcon('settings')
            .setTooltip('编辑这个挂载')
            .onClick(() => this.plugin.editMount(m)),
        )
        .addExtraButton((b) =>
          b
            .setIcon('trash')
            .setTooltip('卸载')
            .onClick(async () => {
              await this.plugin.removeMount(m);
              this.display();
            }),
        );
    }

    const mountActions = new Setting(containerEl).setName('管理');
    mountActions.addButton((b) =>
      b
        .setButtonText('打开挂载面板')
        .setCta()
        .onClick(() => void this.plugin.activatePanel(VIEW_TYPE_MOUNT_PANEL)),
    );
    mountActions.addButton((b) =>
      b.setButtonText('添加挂载').onClick(() => this.plugin.promptAddMount()),
    );
    mountActions.addButton((b) =>
      b.setButtonText('管理全部').onClick(() => new MountListModal(this.plugin).open()),
    );
    mountActions.addButton((b) => b.setButtonText('重新扫描').onClick(() => this.plugin.refreshMounts()));

    new Setting(containerEl)
      .setName('代码编辑器不换行（横向滚动）')
      .setDesc(
        '默认长行会自动折行。开启后改为横向滚动而不折行——深层缩进的代码更易读；' +
          '配置文件和注释里的长文本则更适合保持折行。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.externalCodeNoWrap === true).onChange(async (v) => {
          this.plugin.settings.externalCodeNoWrap = v;
          await this.plugin.saveSettings();
          this.plugin.rerenderExternalViews();
        }),
      );

    new Setting(containerEl)
      .setName('显示库外文件提示栏')
      .setDesc(
        '在库外文件上方显示「库外」提示栏（含相对路径与保存按钮）。' +
          '它说明了文件实际在哪里，但会占用一些纵向空间；' +
          '关闭后文件一样会按原有的自动保存节奏写回原文件。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.externalBanner !== false).onChange(async (v) => {
          this.plugin.settings.externalBanner = v;
          await this.plugin.saveSettings();
          this.plugin.rerenderExternalViews();
        }),
      );

    // ---------- Templates ----------
    containerEl.createEl('h3', { text: 'Templates' });

    new Setting(containerEl)
      .setName('Custom template variables')
      .setDesc('One "name = value" per line. Use in any block as <% name %>. Built-ins: today, yesterday, tomorrow, now, time, current page.')
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.customTemplateVars).onChange(async (v) => {
          this.plugin.settings.customTemplateVars = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 4;
        t.inputEl.cols = 40;
      });
    // ---------- SQLite secondary index ----------
    containerEl.createEl('h3', { text: 'SQLite index (secondary)' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'A rebuildable database derived from your markdown. Markdown stays the source of truth — ' +
        'the database never writes to a note, and Rebuild re-derives it from the files.',
    });

    new Setting(containerEl)
      .setName('Enable the SQLite index')
      .setDesc('Keep a queryable database of blocks, tags, links, properties and block references.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.sqliteIndexEnabled).onChange(async (v) => {
          this.plugin.settings.sqliteIndexEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.applySqliteSettings();
          this.display();
        }),
      );

    if (this.plugin.settings.sqliteIndexEnabled) {
      new Setting(containerEl)
        .setName('Keep a snapshot on disk')
        .setDesc('Save the database between sessions so restarts only re-index what changed.')
        .addToggle((t) =>
          t.setValue(this.plugin.settings.sqlitePersist).onChange(async (v) => {
            this.plugin.settings.sqlitePersist = v;
            await this.plugin.saveSettings();
          }),
        );

      new Setting(containerEl)
        .setName('Sync when files change')
        .setDesc('Re-index a file as soon as it is edited, created, renamed or deleted — including by other apps.')
        .addToggle((t) =>
          t.setValue(this.plugin.settings.sqliteAutoSync).onChange(async (v) => {
            this.plugin.settings.sqliteAutoSync = v;
            await this.plugin.saveSettings();
          }),
        );

      const stats = this.plugin.sqliteIndex?.stats;
      const detail = stats
        ? `${stats.files} files · ${stats.blocks} blocks · ${stats.tags} tags · ${stats.links} links · ${stats.refs} refs (last run ${stats.ms} ms)`
        : 'not started yet';
      new Setting(containerEl).setName('Index').setDesc(detail).addButton((b) =>
        b.setButtonText('Console').onClick(() => new SqliteConsoleModal(this.plugin).open()),
      );

      const actions = new Setting(containerEl).setName('Markdown → database');
      actions.addButton((b) =>
        b.setButtonText('Sync').onClick(async () => {
          const idx = this.plugin.sqliteIndex;
          if (!idx) return;
          const s = await idx.sync();
          new Notice(`Synced: +${s.added} ~${s.changed} -${s.removed} (${s.unchanged} unchanged)`);
          this.display();
        }),
      );
      actions.addButton((b) =>
        b.setButtonText('Rebuild').onClick(async () => {
          const idx = this.plugin.sqliteIndex;
          if (!idx) return;
          const s = await idx.rebuild();
          new Notice(`Rebuilt from markdown: ${s.files} files, ${s.blocks} blocks (${s.ms} ms)`);
          this.display();
        }),
      );
      actions.addButton((b) =>
        b.setButtonText('Verify').onClick(async () => {
          const idx = this.plugin.sqliteIndex;
          if (!idx) return;
          const v = await idx.verify();
          new Notice(
            v.drift.length === 0 && v.missing.length === 0
              ? `Matches the files (${v.checked} checked)`
              : `Stale — drift ${v.drift.length}, missing ${v.missing.length}`,
          );
        }),
      );
    }
  }
}
