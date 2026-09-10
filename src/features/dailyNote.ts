/**
 * Journal (daily note) integration: resolve today's note path from the
 * plugin settings, falling back to the core daily-notes plugin config,
 * then create-on-demand and open it (the block editor takes over opening).
 */

import { Notice, TFile, normalizePath } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { expandTemplates, formatDate } from './template';

interface DailyNotesCoreOptions {
  folder?: string;
  format?: string;
}

/** Read the core daily-notes plugin config (best effort, version-dependent). */
function coreDailyNotesConfig(plugin: LogseqEditorPlugin): DailyNotesCoreOptions {
  try {
    const internal = (
      plugin.app as unknown as {
        internalPlugins?: {
          getPluginById?: (id: string) => { instance?: { options?: DailyNotesCoreOptions } } | undefined;
        };
      }
    ).internalPlugins;
    return internal?.getPluginById?.('daily-notes')?.instance?.options ?? {};
  } catch {
    return {};
  }
}

export function journalPathFor(plugin: LogseqEditorPlugin, date = new Date()): string {
  const s = plugin.settings;
  let folder = s.journalFolder;
  let format = s.journalFormat;
  if (!folder || !format) {
    const core = coreDailyNotesConfig(plugin);
    if (!folder && core.folder) folder = core.folder;
    if (!format && core.format && core.format !== 'optional') format = core.format;
  }
  const name = formatDate(format || 'YYYY-MM-DD', date);
  return normalizePath((folder ? folder.replace(/[\\/]+$/, '') + '/' : '') + name + '.md');
}

/** Open (and create if missing) today's journal note. */
export async function openJournal(plugin: LogseqEditorPlugin): Promise<void> {
  const path = journalPathFor(plugin);
  let f = plugin.app.vault.getAbstractFileByPath(path);
  if (!f) {
    try {
      f = await plugin.app.vault.create(path, expandTemplates(plugin.settings.journalTemplate || ''));
      new Notice(`Created journal: ${path}`);
    } catch (e) {
      new Notice(`Failed to create journal: ${String(e)}`);
      return;
    }
  }
  if (f instanceof TFile) {
    await plugin.app.workspace.openLinkText(f.path, '', false);
  }
}
