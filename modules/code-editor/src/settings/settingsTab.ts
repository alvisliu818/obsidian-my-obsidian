/**
 * Code Editor 模块设置页(2026-11-22 用户)。
 *
 * 宿主把模块 addSettingTab 截获进 capturedTabs,设置页「Code Editor」齿轮
 * 进入本页。内容 = Monaco 支持的全部用户可调项(26 条,见 editorSettingsUI):
 * 字体、光标、渲染、换行缩进、Minimap/折叠、补全,以及 settings.json 操作。
 * 任何一项改动都写回 settings.json 并对已打开的编辑器即时生效。
 */
import { App, PluginSettingTab } from 'obsidian';
import type CodeEditorPlugin from '../main';
import { renderEditorSettingsRows } from './editorSettingsUI';

export class CodeEditorSettingTab extends PluginSettingTab {
  plugin: CodeEditorPlugin;

  constructor(app: App, plugin: CodeEditorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h3', { text: '代码编辑器（Monaco）' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '作用于全部 Monaco 编辑器（代码文件视图与文档内代码块）。改动即时生效，并写回 settings.json。',
    });
    // 全部设置行 + settings.json「打开/重载」操作行
    renderEditorSettingsRows(containerEl, this.plugin);
  }
}
