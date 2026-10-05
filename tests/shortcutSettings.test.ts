/**
 * Shortcut-group settings: which Logseq bindings stay ours, and which are
 * handed back to Obsidian.
 *
 * The invariant that actually matters: `createBlockKeymap` (what we bind) and
 * `ownedDefaultKeys` (what we strip from CM6) must be driven by the SAME
 * settings. If a disabled group were still stripped from CM6 while
 * `createBlockKeymap` returned no binding for it, the key would be dead —
 * swallowed by nobody, handled by nobody.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUT_OVERRIDES,
  SHORTCUT_GROUP_LABELS,
  shortcutOverridesFrom,
  type ShortcutOverrides,
} from '../src/types';
import { ownedDefaultKeys } from '../src/interactions/defaultKeymapOwnership';

const allOff = Object.fromEntries(
  Object.keys(DEFAULT_SHORTCUT_OVERRIDES).map((k) => [k, false]),
) as unknown as ShortcutOverrides;

describe('shortcutOverridesFrom', () => {
  it('defaults every group to ON when nothing is stored', () => {
    // A config written before these settings existed has no `shortcuts` key
    // and must keep stock Logseq behavior.
    expect(shortcutOverridesFrom(undefined)).toEqual(DEFAULT_SHORTCUT_OVERRIDES);
    expect(shortcutOverridesFrom(null)).toEqual(DEFAULT_SHORTCUT_OVERRIDES);
    expect(shortcutOverridesFrom({})).toEqual(DEFAULT_SHORTCUT_OVERRIDES);
  });

  it('fills missing groups with defaults instead of leaving them undefined', () => {
    const merged = shortcutOverridesFrom({ indent: false });
    expect(merged.indent).toBe(false);
    expect(merged.newBlock).toBe(true);
    expect(merged.undoRedo).toBe(true);
  });

  it('ignores non-boolean junk', () => {
    const merged = shortcutOverridesFrom({ indent: 'nope', newBlock: false });
    expect(merged.indent).toBe(true);
    expect(merged.newBlock).toBe(false);
  });

  it('never mutates the defaults', () => {
    const before = { ...DEFAULT_SHORTCUT_OVERRIDES };
    shortcutOverridesFrom({ indent: false, todoCycle: false });
    expect(DEFAULT_SHORTCUT_OVERRIDES).toEqual(before);
  });
});

describe('shortcut group registry', () => {
  it('has a label for every group', () => {
    for (const k of Object.keys(DEFAULT_SHORTCUT_OVERRIDES)) {
      expect(SHORTCUT_GROUP_LABELS[k as keyof ShortcutOverrides], `label for ${k}`).toBeTruthy();
    }
    expect(Object.keys(SHORTCUT_GROUP_LABELS).sort()).toEqual(
      Object.keys(DEFAULT_SHORTCUT_OVERRIDES).sort(),
    );
  });
});

describe('keymap and defaultKeymap stripping stay in sync', () => {
  it('every enabled group contributes bindings, every disabled one contributes none', () => {
    const on = ownedDefaultKeys(DEFAULT_SHORTCUT_OVERRIDES);
    expect(on.has('Enter')).toBe(true); // newBlock
    expect(on.has('Shift-Enter')).toBe(true); // newBlock
    expect(on.has('Mod-Enter')).toBe(true); // todoCycle
    expect(on.has('Tab')).toBe(true); // indent
    expect(on.has('Backspace')).toBe(true); // blockMerge
    expect(on.has('ArrowUp')).toBe(true); // blockNavigation

    const off = ownedDefaultKeys(allOff);
    for (const k of ['Enter', 'Shift-Enter', 'Mod-Enter', 'Tab', 'Shift-Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(off.has(k), `${k} must go back to CM6 when its group is off`).toBe(false);
    }
  });

  it('Mod-f / Mod-h are stripped in EVERY configuration', () => {
    // These are not user-configurable: CM6 binds them to `openSearchPanel`,
    // which needs the `search()` extension we never mount. Left in, they
    // swallow Ctrl+F and nothing opens.
    expect(ownedDefaultKeys(DEFAULT_SHORTCUT_OVERRIDES).has('Mod-f')).toBe(true);
    expect(ownedDefaultKeys(DEFAULT_SHORTCUT_OVERRIDES).has('Mod-h')).toBe(true);
    expect(ownedDefaultKeys(allOff).has('Mod-f')).toBe(true);
    expect(ownedDefaultKeys(allOff).has('Mod-h')).toBe(true);
  });

  it('a partially-disabled config only releases that group\'s keys', () => {
    const onlyNavOff: ShortcutOverrides = { ...DEFAULT_SHORTCUT_OVERRIDES, blockNavigation: false };
    const owned = ownedDefaultKeys(onlyNavOff);
    expect(owned.has('ArrowUp')).toBe(false);
    expect(owned.has('Enter')).toBe(true);
    expect(owned.has('Backspace')).toBe(true);
  });
});
