/**
 * Which shortcuts the outline editor may claim via a DOM listener, and which
 * must fall through to Obsidian's own keymap.
 *
 * THREE separate things had to be fixed to make Ctrl+F (and every other global
 * shortcut) work while a block is being edited. This file is only concerned
 * with the THIRD one, and the first two are recorded here because they look
 * like they belong here and they do not:
 *
 * 1. OWNERSHIP. Calling `preventDefault()` for keys we do not own would break
 *    the user's own bindings. `classifyGlobalKey` returns `none` for those and
 *    the caller must leave the event completely alone.
 *
 * 2. WHO ACTUALLY SEES THE EVENT. An earlier version tried to catch Ctrl+F with
 *    a CAPTURE-phase listener on the view container. Measured on real
 *    Obsidian: it NEVER fires. Obsidian's keymap listens on `window` in the
 *    capture phase and calls `preventDefault()` first — a listener registered
 *    LAST on window-capture already observes `defaultPrevented === true` — so
 *    the event is consumed before it can reach the container. Owning these
 *    keys via the DOM is not possible.
 *
 * 3. THEREFORE: keys we want must be declared as `hotkeys` on real Obsidian
 *    commands (see main.ts). Obsidian's keymap runs first and dispatches the
 *    command itself. `classifyGlobalKey` therefore does NOT list them — a DOM
 *    listener claiming them could only double-fire.
 *
 * The rule is the mirror image of `createBlockKeymap`: this module lists ONLY
 * the keys the outline genuinely owns AND that survive the capture race —
 * i.e. block-level editing operations. Everything else is forwarded to Obsidian.
 */

// types.ts is dependency-free, so importing from it keeps this module
// loadable under plain node (required by tests/hotkeys.test.ts).
import { DEFAULT_SHORTCUT_OVERRIDES, type ShortcutOverrides } from '../types';

/**
 * Our own Ctrl+F / Ctrl+H: browser-style in-page find over the rendered tree.
 *
 * These are registered as Obsidian commands WITH `hotkeys` declarations, so
 * Obsidian's keymap owns the key path — a DOM listener cannot (see the note at
 * the top of this file). The ids must stay BARE: `Plugin.addCommand` prefixes
 * them with the plugin id, so an already-prefixed id would register as
 * `obsidian-logseq:obsidian-logseq:…` and a registry lookup by the un-doubled
 * id would silently find nothing.
 */
export const CMD_FIND = 'find-in-page';
export const CMD_REPLACE = 'replace-in-page';
/** Ctrl+\ — Logseq md parity: toggle collapse-all / expand-all. */
export const CMD_COLLAPSE_ALL = 'toggle-collapse-all';

/** The id Obsidian registers a bare command id under. */
export function qualifiedCommandId(pluginId: string, bareId: string): string {
  return `${pluginId}:${bareId}`;
}

export interface HotkeyModifiers {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export function modifiersOf(ev: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): HotkeyModifiers {
  return { ctrl: ev.ctrlKey, meta: ev.metaKey, shift: ev.shiftKey, alt: ev.altKey };
}

/** True when the platform's primary modifier (Ctrl on win/linux, Cmd on mac) is down. */
export function hasMod(m: HotkeyModifiers): boolean {
  return m.ctrl || m.meta;
}

export type ShortcutAction =
  | { kind: 'none' }
  | { kind: 'bulk'; op: 'select-all' | 'cut' | 'copy' | 'duplicate' }
  /** Tab / Shift+Tab over a multi-selection: indent / outdent every member. */
  | { kind: 'indent-selection'; shift: boolean }
  | { kind: 'undo' }
  | { kind: 'redo' };

/**
 * Classify a keydown for the block view's global handler.
 *
 * Returns `none` for everything we do not own — the caller must then leave the
 * event completely alone (no preventDefault) so Obsidian's keymap can act on
 * it. That fall-through is the whole point: it is what makes the editor obey
 * the user's Obsidian keymap instead of a hardcoded list.
 *
 * `shortcuts` is the user's Settings → Shortcuts configuration. A group that
 * is switched off must classify as `none` here too, otherwise the global
 * handler would still claim the key while the CM6 keymap had already
 * surrendered it — the two must agree.
 */
export function classifyGlobalKey(
  key: string,
  m: HotkeyModifiers,
  opts: { hasSelection: boolean; editing: boolean; shortcuts?: ShortcutOverrides },
): ShortcutAction {
  const k = key.toLowerCase();
  // Absent `shortcuts` = stock Logseq behavior (used by tests and by any
  // caller that has not loaded settings yet).
  const on = opts.shortcuts ?? DEFAULT_SHORTCUT_OVERRIDES;

  // Tab / Shift+Tab over a MULTI-SELECTION: indent / outdent every member.
  //
  // Checked BEFORE the bare-key bail-out below, because Tab carries no
  // modifier. Two conditions keep it from stealing the key:
  //   - `hasSelection` — with nothing selected there is no group to act on,
  //     and Tab must keep bubbling to Obsidian (focus traversal).
  //   - `!editing` — while a block is focused, Tab belongs to the CM6 keymap
  //     (`handleTab`, the single-block indent path).
  // It is gated on the `indent` group, not `bulkSelection`: Tab/Shift+Tab is
  // the indent group's key in both the single- and multi-block case, so one
  // switch owns it everywhere.
  if (k === 'tab' && !hasMod(m) && !m.alt && on.indent && opts.hasSelection && !opts.editing) {
    return { kind: 'indent-selection', shift: m.shift };
  }

  // Single keys with no modifier belong to the focused text (typing).
  if (!hasMod(m) && !m.alt) return { kind: 'none' };

  // Alt-combos are block navigation (jump / move) — claimed by the CM6 keymap.
  if (m.alt && !hasMod(m)) return { kind: 'none' };

  if (!hasMod(m)) return { kind: 'none' };

  // Mod+Shift+z / Mod+y — redo; Mod+z — undo (only when NOT editing: while a
  // block is focused CM6's own history handles it, exactly like the native
  // editor).
  if (on.undoRedo && !opts.editing) {
    if (k === 'z') return m.shift ? { kind: 'redo' } : { kind: 'undo' };
    if (k === 'y') return { kind: 'redo' };
  }

  // Bulk ops only make sense with a block selection, and only when not typing.
  if (on.bulkSelection && opts.hasSelection && !opts.editing) {
    if (k === 'a') return { kind: 'bulk', op: 'select-all' };
    if (k === 'x') return { kind: 'bulk', op: 'cut' };
    if (k === 'c') return { kind: 'bulk', op: 'copy' };
    if (k === 'd') return { kind: 'bulk', op: 'duplicate' };
  }

  // Mod+f / Mod+h / Mod+\ are NOT here: they are declared as `hotkeys` on real
  // commands so Obsidian's keymap routes them. Claiming them from a DOM
  // listener cannot work (see the note at the top of this file), and doing it
  // anyway would double-fire the command.

  // Everything else (Ctrl+P quick switcher, Ctrl+O, Ctrl+Shift+N, Mod+Alt+…,
  // and whatever the user bound themselves) belongs to Obsidian.
  return { kind: 'none' };
}
