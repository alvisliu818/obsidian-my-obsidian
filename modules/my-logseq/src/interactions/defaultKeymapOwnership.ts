/**
 * Which CM6 `defaultKeymap` keys the outline editor takes over, derived from
 * the user's shortcut-group settings.
 *
 * Lives apart from `editor/extensions.ts` on purpose: that module imports
 * `obsidian` and CodeMirror, so it cannot be loaded under plain node. This one
 * is pure and unit-testable, which is what makes the sync invariant below
 * verifiable.
 *
 * THE INVARIANT: whatever `createBlockKeymap` binds must be stripped from
 * CM6's defaults, and whatever it does NOT bind must be left alone. A key that
 * is stripped but unbound is DEAD — handled by nobody. So both sides must be
 * computed from the same `shortcuts` object.
 */
import { type ShortcutOverrides } from '../types';

/**
 * Stripped from CM6 in EVERY mode, regardless of settings.
 *
 * `Mod-f` / `Mod-h` are bound by CM6 to `openSearchPanel`, which requires the
 * `search()` extension — this plugin never mounts it (it provides its own
 * outline-level find bar). Left in, CM6 consumed Ctrl+F on its own keymap
 * during editing, called `preventDefault()`, and opened nothing: the key never
 * reached Obsidian's keymap, so the `find-in-page` command never fired.
 * Removing them lets the key bubble to Obsidian, which routes it to the
 * command registered with `hotkeys` in main.ts.
 */
export const ALWAYS_STRIPPED_DEFAULT_KEYS: ReadonlySet<string> = new Set(['Mod-f', 'Mod-h']);

/** CM6 default keys the outline overrides, for the currently enabled groups. */
export function ownedDefaultKeys(shortcuts: ShortcutOverrides): Set<string> {
  const owned = new Set<string>(ALWAYS_STRIPPED_DEFAULT_KEYS);
  const add = (k: string) => owned.add(k);

  if (shortcuts.newBlock) {
    add('Enter');
    add('Shift-Enter');
  }
  if (shortcuts.todoCycle) {
    add('Mod-Enter');
    add('Ctrl-Enter');
  }
  if (shortcuts.indent) {
    add('Tab');
    add('Shift-Tab');
  }
  if (shortcuts.blockMerge) add('Backspace');
  if (shortcuts.blockNavigation) {
    add('ArrowUp');
    add('ArrowDown');
    add('ArrowLeft');
    add('ArrowRight');
  }
  return owned;
}
