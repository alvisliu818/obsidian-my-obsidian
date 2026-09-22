/**
 * Journal (daily note) integration: resolve today's note path from the
 * plugin settings, falling back to the core daily-notes plugin config,
 * then create-on-demand and open it (the block editor takes over opening).
 */

import { Notice, TFile, normalizePath } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { expandTemplates, formatDate } from './template';
import { logOp } from './logger';
import { addDays, journalDateOf } from '../core/journalDate';

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
  return journalPathForDate(plugin, date);
}

/** Resolve the journal path for a specific date (plugin settings → core fallback). */
function journalPathForDate(plugin: LogseqEditorPlugin, date: Date): string {
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

/** Extract the journal date from a file name (default format, alt compact); null when not a journal. */
export function journalDateFromName(name: string): Date | null {
  return journalDateOf(name, 'YYYY-MM-DD') ?? journalDateOf(name, 'YYYYMMDD');
}

/** Open (and create if missing) today's journal note. */
export async function openJournal(plugin: LogseqEditorPlugin): Promise<void> {
  await openJournalFor(plugin, 0);
}

/**
 * Open the journal `days` from `base` (default: today). Logseq md parity:
 * navigation anchors on the CURRENT file's date when it is itself a journal,
 * so Alt+← / Alt+→ walk day by day from wherever you are.
 */
export async function openJournalFor(
  plugin: LogseqEditorPlugin,
  days = 0,
  base?: Date | null,
): Promise<void> {
  const anchor = base ?? new Date();
  const target = addDays(anchor, days);
  const path = journalPathForDate(plugin, target);
  let f = plugin.app.vault.getAbstractFileByPath(path);
  if (!f) {
    try {
      f = await plugin.app.vault.create(path, expandTemplates(plugin.settings.journalTemplate || '', target));
      logOp(plugin, 'journal.create', path, 'ok');
      new Notice(`Created journal: ${path}`);
    } catch (e) {
      logOp(plugin, 'journal.create', path, 'error', String(e));
      new Notice(`Failed to create journal: ${String(e)}`);
      return;
    }
  }
  if (f instanceof TFile) {
    await plugin.app.workspace.openLinkText(f.path, '', false);
  }
}
