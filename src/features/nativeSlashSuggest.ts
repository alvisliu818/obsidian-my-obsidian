/**
 * Native slash menu (Logseq parity) via the public EditorSuggest API.
 *
 * A `#`-free `/` typed at line start (or after whitespace) opens a popup
 * listing EVERY editor command available in the vault — this plugin's
 * built-in slash commands, Obsidian's core editor commands, and every
 * plugin's editorCallback/editorCheckCallback commands — exactly like the
 * native editor's slash menu. Selection executes through
 * workspace.activeEditor (the block editor's native-Editor adapter), so
 * commands operate on the block editor's selection and text.
 *
 * The popup and its keyboard handling (arrows/enter/escape via a keymap
 * scope) are provided by the EditorSuggest base class; we only trigger it
 * manually from our own CM6 mount.
 */

import { EditorSuggest, type App, type Editor, type EditorPosition, type EditorSuggestTriggerInfo, type EditorSuggestContext } from 'obsidian';
import type { BlockEditorView } from '../view/BlockEditorView';

export interface SlashSuggestion {
  id: string;
  name: string;
  detail: string;
  /** Obsidian editor-command id: executed through the command registry. */
  cmdId?: string;
  /** Built-in insert: text placed at the trigger point. */
  insert?: string;
  /** Built-in block-model command run through the host. */
  run?: (host: BlockEditorView) => void;
}

export class NativeSlashSuggest extends EditorSuggest<SlashSuggestion> {
  constructor(plugin: unknown) {
    super((plugin as unknown as { app: unknown }).app as App);
    (window as unknown as { __nativeSlashConstructed?: boolean }).__nativeSlashConstructed = true;
  }

  /** Trigger on `/` at line start or after whitespace. */
  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    // Block editors only: in the native editor, `editor` is Obsidian's real
    // Editor (no adapter marker) and the core slash suggest (when enabled)
    // should own `/` like it does without this plugin.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(editor as any).__blockEditorAdapter) return null;
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    if (!/(^|\s)\/$/.test(before)) return null;
    return {
      start: { line: cursor.line, ch: cursor.ch - 1 },
      end: { line: cursor.line, ch: cursor.ch },
      query: '',
    };
  }

  getSuggestions(context: EditorSuggestContext): SlashSuggestion[] {
    const all = this.buildItems();
    const q = (context.query || '').toLowerCase().replace(/^\//, '');
    // No cap: the native core menu lists every matching command in a
    // scrollable popup — capping hides commands depending on registry order.
    if (!q) return all;
    return all.filter((s) => s.name.toLowerCase().includes(q) || s.detail.toLowerCase().includes(q));
  }

  /** Built-ins + core editor commands + every plugin's editor commands. */
  private buildItems(): SlashSuggestion[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const cmds = w.app?.commands?.commands as Record<string, any> | undefined;
    const items: SlashSuggestion[] = [];
    // Built-in Logseq slash commands (marker/prop actions) FIRST: they are
    // this plugin's parity commands, and the empty-query list is capped —
    // appended-last they would fall off whenever the command registry is
    // large (plugin load order varies between profiles/sessions).
    for (const item of BUILT_IN_SLASH()) {
      items.push({ id: 'logseq-' + item.label, name: item.label, detail: 'Logseq', run: item.block });
    }
    if (cmds) {
      for (const [id, cmd] of Object.entries(cmds)) {
        if (!cmd || (!cmd.editorCallback && !cmd.editorCheckCallback)) continue;
        let ok = true;
        try {
          ok = cmd.checkCallback ? !!cmd.checkCallback(true) : true;
        } catch {
          ok = false;
        }
        if (!ok) continue;
        const pluginId = id.includes(':') ? id.slice(0, id.indexOf(':')) : '';
        items.push({
          id,
          name: String(cmd.name ?? id),
          detail: pluginId === 'editor' || pluginId === 'app' ? 'Obsidian' : pluginId,
          cmdId: id,
        });
      }
    }
    return items;
  }

  renderSuggestion(item: SlashSuggestion, el: HTMLElement): void {
    el.createEl('div', { cls: 'native-slash-item' }, (row) => {
      row.createEl('span', { cls: 'native-slash-name', text: item.name });
      row.createEl('span', { cls: 'native-slash-detail', text: item.detail });
    });
  }

  selectSuggestion(item: SlashSuggestion, evt: KeyboardEvent | MouseEvent): void {
    const ctx = this.context;
    this.close();
    if (!ctx) return;
    const editor = ctx.editor;
    // Remove the `/` trigger character so commands start from clean text.
    editor.replaceRange('', ctx.start, ctx.end);
    if (item.cmdId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).app?.commands?.executeCommandById(item.cmdId);
      return;
    }
    if (item.run) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const host = (w2().app?.workspace?.activeEditor as any)?.__host;
      if (host) item.run(host);
      return;
    }
    void evt;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w2 = (): any => window as any;

/** Minimal built-in slash items (marker / property actions need the host). */
const BUILT_IN_SLASH = (): Array<{ label: string; block: (h: BlockEditorView) => void }> => {
  // The built-in command bodies live in commandMenu.ts (SLASH_COMMANDS);
  // they are injected here at registration time to avoid a module cycle.
  return BUILT_IN_SLASH_PROVIDER.fn?.() ?? [];
};

// Set by commandMenu.ts at plugin load.
export const BUILT_IN_SLASH_PROVIDER: { fn?: () => Array<{ label: string; block: (h: BlockEditorView) => void }> } = {};

export function setBuiltinSlashProvider(fn: () => Array<{ label: string; block: (h: BlockEditorView) => void }>): void {
  BUILT_IN_SLASH_PROVIDER.fn = fn;
}
