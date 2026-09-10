import { PluginSettingTab, Setting, type App } from 'obsidian';
import type LogseqEditorPlugin from '../main';

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
