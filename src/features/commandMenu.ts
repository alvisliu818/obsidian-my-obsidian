/**
 * Command menus for the block editor.
 *
 * - `/` opens the NATIVE slash-command menu (Obsidian core "Slash commands"
 *   feature) driven through workspace.editorSuggest with our editor adapter:
 *   it lists every editor command — core, this plugin's built-ins, and every
 *   plugin's editorCallback commands — with native fuzzy filtering.
 * - `<` opens the self-drawn angle menu (HTML snippets & entities).
 * - registerSlashEditorCommands registers the built-in slash commands as
 *   editor commands so they appear in the native menu and the command palette.
 */

import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import type { BlockEditorView } from '../view/BlockEditorView';
import type { Extension } from '@codemirror/state';
import { Marker } from '../types';
import { createEditorAdapter } from '../interactions/textSelectionMenu';

export type MenuKind = 'slash' | 'angle';

export interface CommandItem {
  label: string;
  group: string;
  detail: string;
  /** Text inserted at the trigger point (replacing the trigger query). */
  insert?: string;
  /** Caret offset inside the inserted text after insertion. */
  caret?: number;
  /** Block-model command executed through the host instead of text insert. */
  block?: (host: BlockEditorView) => void;
  /** Obsidian editor-command id (core or plugin): executed through the
   *  command registry against workspace.activeEditor (our adapter). */
  cmdId?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

const todayLink = (): string => {
  const d = new Date();
  return `[[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}]]`;
};

const nowTime = (): string => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const todayISO = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const SLASH_COMMANDS: CommandItem[] = [
  { label: 'TODO', group: 'Task state', detail: 'set marker', block: (h) => setMarker(h, 'TODO') },
  { label: 'DOING', group: 'Task state', detail: 'set marker', block: (h) => setMarker(h, 'DOING') },
  { label: 'DONE', group: 'Task state', detail: 'set marker', block: (h) => setMarker(h, 'DONE') },
  { label: 'Priority A', group: 'Task state', detail: 'priority:: A', block: (h) => setProp(h, 'priority', 'A') },
  { label: 'Priority B', group: 'Task state', detail: 'priority:: B', block: (h) => setProp(h, 'priority', 'B') },
  { label: 'Priority C', group: 'Task state', detail: 'priority:: C', block: (h) => setProp(h, 'priority', 'C') },
  { label: 'Scheduled', group: 'Task state', detail: 'scheduled:: today', block: (h) => setProp(h, 'scheduled', todayISO()) },
  { label: 'Deadline', group: 'Task state', detail: 'deadline:: today', block: (h) => setProp(h, 'deadline', todayISO()) },
  { label: 'Heading 1', group: 'Formatting', detail: 'large heading', insert: '# ' },
  { label: 'Heading 2', group: 'Formatting', detail: 'medium heading', insert: '## ' },
  { label: 'Heading 3', group: 'Formatting', detail: 'small heading', insert: '### ' },
  { label: 'Divider', group: 'Formatting', detail: 'horizontal rule', insert: '---' },
  { label: 'Code block', group: 'Formatting', detail: 'fenced code', insert: '```\n\n```', caret: 4 },
  { label: 'Quote', group: 'Formatting', detail: 'blockquote', insert: '> ' },
  { label: 'Bold', group: 'Formatting', detail: '**text**', insert: '****', caret: 2 },
  { label: 'Italic', group: 'Formatting', detail: '*text*', insert: '**', caret: 1 },
  { label: 'Highlight', group: 'Formatting', detail: '==text==', insert: '====', caret: 2 },
  { label: "Today's date", group: 'Insert', detail: "link to today's journal", insert: todayLink() },
  { label: 'Current time', group: 'Insert', detail: 'HH:mm', insert: nowTime() },
  { label: 'Link to page', group: 'Insert', detail: '[[wiki link]]', insert: '[[', caret: 2 },
  { label: 'Block reference', group: 'Insert', detail: '((block-id))', insert: '((', caret: 2 },
  { label: 'Embed block', group: 'Insert', detail: 'inline another block', insert: '{{embed ((', caret: 9 },
  { label: 'Query', group: 'Advanced', detail: '{{query}} live results', insert: '{{query (TODO)}}' },
  { label: 'Query table', group: 'Advanced', detail: '{{query-table}} with columns', insert: '{{query-table (TODO)}}' },
  {
    label: 'Indent block',
    group: 'Structure',
    detail: 'nest under block above (Tab)',
    block: (h) => h.handleTabFromCommand(false),
  },
  {
    label: 'Outdent block',
    group: 'Structure',
    detail: 'move one level up (Shift+Tab)',
    block: (h) => h.handleTabFromCommand(true),
  },
  {
    label: 'New block below',
    group: 'Structure',
    detail: 'insert sibling after this block',
    block: (h) => h.handleEnterFromCommand(),
  },
  {
    label: 'Delete block',
    group: 'Structure',
    detail: 'remove block, children move up',
    block: (h) => h.deleteFocusedBlock(),
  },
  {
    label: 'Current page',
    group: 'Templates',
    detail: '<% current page %>',
    insert: '<% current page %>',
  },
  { label: 'Yesterday', group: 'Templates', detail: '<% yesterday %>', insert: '<% yesterday %>' },
  { label: 'Tomorrow', group: 'Templates', detail: '<% tomorrow %>', insert: '<% tomorrow %>' },
  { label: 'Now', group: 'Templates', detail: '<% now %>', insert: '<% now %>' },
];

const ANGLE_COMMANDS: CommandItem[] = [
  { label: 'div', group: 'HTML', detail: 'block container', insert: '<div>\n\n</div>', caret: 6 },
  { label: 'span', group: 'HTML', detail: 'inline container', insert: '<span></span>', caret: 6 },
  { label: 'br', group: 'HTML', detail: 'line break', insert: '<br>' },
  { label: 'mark', group: 'HTML', detail: 'highlight', insert: '<mark></mark>', caret: 6 },
  { label: 'u', group: 'HTML', detail: 'underline', insert: '<u></u>', caret: 3 },
  { label: 'sub', group: 'HTML', detail: 'subscript', insert: '<sub></sub>', caret: 5 },
  { label: 'sup', group: 'HTML', detail: 'superscript', insert: '<sup></sup>', caret: 5 },
  { label: 'kbd', group: 'HTML', detail: 'keyboard key', insert: '<kbd></kbd>', caret: 5 },
  { label: 'center', group: 'HTML', detail: 'centered content', insert: '<center>\n\n</center>', caret: 9 },
  { label: 'font color', group: 'HTML', detail: 'colored text', insert: '<font color="#1a4fa0"></font>', caret: 22 },
  {
    label: 'details',
    group: 'HTML',
    detail: 'collapsible section',
    insert: '<details>\n<summary>title</summary>\n\n</details>',
    caret: 38,
  },
  { label: 'nbsp', group: 'Entities', detail: 'non-breaking space', insert: '&nbsp;' },
  { label: 'lt', group: 'Entities', detail: 'literal <', insert: '&lt;' },
  { label: 'gt', group: 'Entities', detail: 'literal >', insert: '&gt;' },
  { label: 'amp', group: 'Entities', detail: 'literal &', insert: '&amp;' },
  { label: 'copy', group: 'Entities', detail: '漏 symbol', insert: '&copy;' },
];

function setMarker(host: BlockEditorView, marker: Marker): void {
  const b = host.focusedBlock;
  if (!b) return;
  host.mutate(
    () => {
      b.marker = marker;
    },
    () => ({ subtree: b }),
  );
}

function setProp(host: BlockEditorView, key: string, value: string): void {
  const b = host.focusedBlock;
  if (!b) return;
  host.mutate(
    () => {
      b.props[key] = value;
    },
    () => ({ subtree: b }),
  );
}

interface MenuState {
  kind: MenuKind;
  /** Editor offset where the trigger char (/ or <) sits. */
  triggerFrom: number;
  /** Current filter text (typed after the trigger). */
  query: string;
  selected: number;
  items: CommandItem[];
  el: HTMLElement | null;
  host: BlockEditorView;
  view: EditorView;
}

let menu: MenuState | null = null;

/** The keymap extension: swallows nav keys while the self-drawn menu is open. */
export function commandMenuKeymap(): Extension {
  return Prec.highest(
    keymap.of([
      {
        key: 'ArrowUp',
        run: () => (menu ? (moveSelection(-1), true) : false),
      },
      {
        key: 'ArrowDown',
        run: () => (menu ? (moveSelection(1), true) : false),
      },
      {
        key: 'Enter',
        run: (v) => {
          if (!menu) return false;
          executeSelected(v);
          return true;
        },
      },
      {
        key: 'Tab',
        run: (v) => {
          if (!menu) return false;
          executeSelected(v);
          return true;
        },
      },
      {
        key: 'Escape',
        run: () => {
          if (!menu) return false;
          closeMenu();
          return true;
        },
      },
    ]),
  );
}

let nativeSlashActive = false;

/**
 * Detect a trigger char typed at line-start/whitespace.
 *
 * `/` opens the NATIVE slash-command menu (Obsidian core Slash commands
 * feature) driven through workspace.editorSuggest with our editor adapter:
 * it lists every editor command — core, this plugin's built-ins, and every
 * plugin's editorCallback commands — with native fuzzy filtering. Typing
 * re-filters, and removing the `/` closes it. The native suggest also pushes
 * a keymap scope while open, so arrows/enter/escape are handled natively;
 * our escHandler yields when the suggest is showing.
 *
 * `<` keeps the self-drawn angle menu (HTML snippets & entities).
 */
export function maybeOpenMenu(view: EditorView, host: BlockEditorView): void {
  if (menu) {
    updateFilter(view);
    return;
  }
  const head = view.state.selection.main.head;
  // Logseq parity: `/` (line-start or after whitespace) plus any query chars
  // opens the NATIVE slash-command menu; typing re-filters it, and removing
  // the `/` closes it — checked against the FULL line before the caret
  // (a 2-char window would miss the trigger as soon as the query grows).
  const lineBefore = view.state.doc.lineAt(head).text.slice(0, head - view.state.doc.lineAt(head).from);
  if (/(^|\s)\/\S*$/.test(lineBefore)) {
    triggerNativeSlash(view, host);
  } else if (nativeSlashActive) {
    closeNativeSlash();
    nativeSlashActive = false;
  }
  if (/(^|\s)<$/.test(lineBefore)) {
    openMenu(view, host, 'angle', head - 1);
  }
}

/** Built-in slash items for the native suggest (block-model actions). */
export function builtinSlashItems(): Array<{ label: string; block: (h: BlockEditorView) => void }> {
  return SLASH_COMMANDS.filter((c) => c.block).map((c) => ({ label: c.label, block: c.block! }));
}

function closeNativeSlash(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const es = (window as any).app?.workspace?.editorSuggest;
  es?.close?.();
  nativeSlashActive = false;
}

/**
 * Drive the native EditorSuggest system with our editor adapter: trigger()
 * walks every registered suggest (the core slash suggest checks the `/`
 * trigger, collects the available commands, and shows the native popup).
 */
export function triggerNativeSlash(view: EditorView, host: BlockEditorView): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const es = (window as any).app?.workspace?.editorSuggest;
  if (!es?.trigger) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter: any = createEditorAdapter(view, host);
  // The native suggest requires the triggering keyboard event (its onTrigger
  // returns null when evt is missing).
  const evt = (window as unknown as { __lastKeyEvent?: KeyboardEvent }).__lastKeyEvent;
  es.trigger(adapter, host.file ?? null, evt);
  nativeSlashActive = true;
}

/**
 * Register the built-in slash commands as editor commands so they appear in
 * the NATIVE slash-command menu alongside core and plugin commands. Block
 * commands resolve their host through the live activeEditor pseudo-view.
 */
export function registerSlashEditorCommands(plugin: { addCommand(cmd: unknown): void; app: unknown }): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const slug = (label: string): string =>
    label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cmd';
  for (const item of SLASH_COMMANDS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugin.addCommand({
      id: 'slash-' + slug(item.label),
      name: item.label,
      editorCallback: (editor: any) => {
        // The active editor is our block editor (synced via activeEditor):
        // resolve its host for block-model commands.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const host = (w.app.workspace.activeEditor as any)?.__host;
        if (item.block) {
          if (host) item.block(host);
          return;
        }
        if (item.insert !== undefined) {
          editor.replaceSelection(item.insert);
          if (item.caret !== undefined) {
            // Cursor inside the inserted text (e.g. "{{embed ((", "# ").
            const pos = editor.getCursor('from');
            const line = editor.getLine(pos.line);
            const abs = line.slice(0, pos.ch).length - item.insert.length + (item.caret ?? 0);
            editor.setCursor({ line: pos.line, ch: Math.max(0, abs) });
          }
        }
      },
    });
  }
}

function openMenu(view: EditorView, host: BlockEditorView, kind: MenuKind, triggerFrom: number): void {
  closeMenu();
  menu = {
    kind,
    triggerFrom,
    query: '',
    selected: 0,
    items: [],
    el: null,
    host,
    view,
  };
  renderMenu();
}

function sourceItems(kind: MenuKind): CommandItem[] {
  return kind === 'slash' ? SLASH_COMMANDS : ANGLE_COMMANDS;
}

function updateFilter(view: EditorView): void {
  if (!menu) return;
  const head = view.state.selection.main.head;
  if (head <= menu.triggerFrom) {
    closeMenu();
    return;
  }
  // Text between the trigger and the caret is the query. Stop the menu when
  // a whitespace char other than the leading one appears (query is one word).
  const raw = view.state.doc.sliceString(menu.triggerFrom + 1, head);
  if (/\s/.test(raw.replace(/^&/, ''))) {
    // allow &-entities like &nbsp; — only cut on real spaces
    if (/\s/.test(raw)) {
      closeMenu();
      return;
    }
  }
  menu.query = raw;
  menu.selected = 0;
  renderMenu();
}

function filteredItems(state: MenuState): CommandItem[] {
  const q = state.query.toLowerCase().replace(/^[\/<]/, '');
  const all = sourceItems(state.kind);
  if (!q) return all;
  return all.filter(
    (c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q) || c.detail.toLowerCase().includes(q),
  );
}

function renderMenu(): void {
  if (!menu) return;
  const { view, kind } = menu;
  const items = filteredItems(menu);
  menu.items = items;
  if (items.length === 0) {
    closeMenu();
    return;
  }
  if (!menu.el) {
    const el = document.createElement('div');
    el.className = 'block-command-menu';
    // Position: under the editor's focused block content (caret coords are
    // available via view.coordsAtPos).
    document.body.appendChild(el);
    menu.el = el;
    // Close on outside pointerdown.
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    window.addEventListener('pointerdown', onOutsidePointer, { capture: true });
  }
  const el = menu.el;
  el.empty();
  el.setAttribute('data-kind', kind);
  items.forEach((c, i) => {
    const row = el.createEl('div', { cls: 'bcm-item' + (i === menu!.selected ? ' is-selected' : '') });
    row.createEl('span', { cls: 'bcm-label', text: c.label });
    row.createEl('span', { cls: 'bcm-detail', text: c.detail });
    row.addEventListener('click', () => {
      menu!.selected = i;
      executeSelected(view);
    });
  });
  // Position under the caret.
  try {
    const coords = view.coordsAtPos(menu.triggerFrom);
    if (coords) {
      el.style.left = `${coords.left}px`;
      el.style.top = `${coords.bottom + 6}px`;
    } else {
      el.style.left = '40px';
      el.style.top = '80px';
    }
  } catch {
    el.style.left = '40px';
    el.style.top = '80px';
  }
  // Keep the selected row in view.
  const sel = el.querySelector('.bcm-item.is-selected');
  sel?.scrollIntoView({ block: 'nearest' });
}

function onOutsidePointer(e: PointerEvent): void {
  if (menu && !menu.el?.contains(e.target as Node)) closeMenu();
}

function moveSelection(dir: -1 | 1): void {
  if (!menu) return;
  const n = menu.items.length;
  menu.selected = (menu.selected + dir + n) % n;
  renderMenu();
}

function executeSelected(view: EditorView): void {
  if (!menu) return;
  const item = menu.items[menu.selected];
  const { triggerFrom, host } = menu;
  closeMenu();
  if (!item) return;
  // Remove the trigger query text ("<div" etc.) from the buffer.
  const head = view.state.selection.main.head;
  const removeFrom = triggerFrom;
  const removeTo = Math.max(head, triggerFrom + 1);
  view.dispatch({ changes: { from: removeFrom, to: removeTo, insert: '' } });
  if (item.block) {
    item.block(host);
    return;
  }
  if (item.insert !== undefined) {
    view.dispatch({
      changes: { from: removeFrom, to: removeFrom, insert: item.insert },
      selection: { anchor: removeFrom + (item.caret ?? item.insert.length) },
    });
    view.focus();
  }
}

export function closeMenu(): void {
  if (!menu) return;
  window.removeEventListener('pointerdown', onOutsidePointer, { capture: true } as EventListenerOptions);
  menu.el?.remove();
  menu = null;
}

export function isMenuOpen(): boolean {
  return menu !== null;
}
