import { PluginSettingTab, Setting, type App } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import type { ScopeMode } from '../types';

export class LogseqEditorSettingTab extends PluginSettingTab {
  plugin: LogseqEditorPlugin;

  constructor(app: App, plugin: LogseqEditorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
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
  }
}
