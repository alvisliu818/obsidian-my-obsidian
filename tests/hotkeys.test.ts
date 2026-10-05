/**
 * Global shortcut routing for the block view.
 *
 * The contract that matters: `classifyGlobalKey` returns `none` for every key
 * the outline does not own, and the view then leaves the event untouched. That
 * fall-through is what makes the editor honor the user's Obsidian keymap — the
 * old handler called preventDefault() for Ctrl+F and killed every global
 * shortcut along with it.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyGlobalKey,
  modifiersOf,
  qualifiedCommandId,
  CMD_FIND,
  CMD_REPLACE,
  type HotkeyModifiers,
} from '../src/interactions/hotkeys';
import { DEFAULT_SHORTCUT_OVERRIDES, type ShortcutOverrides } from '../src/types';

const NONE: HotkeyModifiers = { ctrl: false, meta: false, shift: false, alt: false };
const mod = (over: Partial<HotkeyModifiers> = {}): HotkeyModifiers => ({ ...NONE, ctrl: true, ...over });
const idle = { hasSelection: false, editing: false };
const editing = { hasSelection: false, editing: true };

describe('classifyGlobalKey', () => {
  it('never claims find/replace/collapse — Obsidian keymap owns those keys', () => {
    // These are declared as `hotkeys` on real commands (see main.ts). A DOM
    // listener cannot win: Obsidian's keymap listens on window in the CAPTURE
    // phase and preventDefaults first, verified on a real instance. If this
    // table ever claims 'f' again, the command would double-fire.
    expect(classifyGlobalKey('f', mod(), editing).kind).toBe('none');
    expect(classifyGlobalKey('h', mod(), editing).kind).toBe('none');
    expect(classifyGlobalKey('\\', mod(), idle).kind).toBe('none');
  });

  it('leaves plain typing to the text editor', () => {
    for (const k of ['a', 'f', 'z', 'Enter', ' ', '1']) {
      expect(classifyGlobalKey(k, NONE, editing).kind).toBe('none');
    }
  });

  it('leaves Alt-combos to the block keymap (jump / move)', () => {
    expect(classifyGlobalKey('ArrowUp', { ...NONE, alt: true }, idle).kind).toBe('none');
  });

  it('ignores undo/redo while a block is being edited (CM6 owns history)', () => {
    expect(classifyGlobalKey('z', mod(), editing).kind).toBe('none');
    expect(classifyGlobalKey('z', mod({ shift: true }), editing).kind).toBe('none');
  });

  it('handles undo/redo at the view level when nothing is focused', () => {
    expect(classifyGlobalKey('z', mod(), idle)).toEqual({ kind: 'undo' });
    expect(classifyGlobalKey('z', mod({ shift: true }), idle)).toEqual({ kind: 'redo' });
    expect(classifyGlobalKey('y', mod(), idle)).toEqual({ kind: 'redo' });
  });

  it('only offers bulk ops when blocks are actually selected', () => {
    expect(classifyGlobalKey('a', mod(), { hasSelection: true, editing: false })).toEqual({
      kind: 'bulk',
      op: 'select-all',
    });
    // No selection → Ctrl+A is the native "select all" and must pass through.
    expect(classifyGlobalKey('a', mod(), idle).kind).toBe('none');
  });

  it('does not hijack bulk keys while typing', () => {
    expect(classifyGlobalKey('d', mod(), { hasSelection: true, editing: true }).kind).toBe('none');
  });

  it('falls through for Obsidian-owned shortcuts', () => {
    // Quick switcher, quick switcher with path, new tab, new window, bookmarks,
    // toggle reading view, and anything the user bound themselves.
    const cases: Array<[string, HotkeyModifiers]> = [
      ['p', mod()],
      ['p', mod({ shift: true })],
      ['o', mod()],
      ['n', mod({ shift: true })],
      ['e', mod({ shift: true })],
      ['w', mod({ shift: true })],
      ['q', mod()],
      ['k', mod({ alt: true })],
      ['1', mod()],
    ];
    for (const [k, m] of cases) {
      expect(classifyGlobalKey(k, m, idle), `${k} must fall through`).toEqual({ kind: 'none' });
    }
  });

  it('treats Cmd the same as Ctrl (macOS parity)', () => {
    expect(classifyGlobalKey('z', { ...NONE, meta: true }, idle)).toEqual({ kind: 'undo' });
  });

  it('does not claim Shift+F as find', () => {
    // Shift+F is unbound here; it must reach Obsidian untouched.
    expect(classifyGlobalKey('f', mod({ shift: true }), idle).kind).toBe('none');
  });
});

describe('classifyGlobalKey respects the shortcut-group settings', () => {
  const off: ShortcutOverrides = Object.fromEntries(
    Object.keys(DEFAULT_SHORTCUT_OVERRIDES).map((k) => [k, false]),
  ) as unknown as ShortcutOverrides;

  it('undo/redo fall through to Obsidian when the group is off', () => {
    // Must agree with the CM6 keymap: if this still claimed Ctrl+Z while
    // historyKeymap was released, the two layers would disagree.
    expect(classifyGlobalKey('z', mod(), idle).kind).toBe('undo');
    expect(classifyGlobalKey('z', mod(), { ...idle, shortcuts: off }).kind).toBe('none');
    expect(classifyGlobalKey('y', mod(), { ...idle, shortcuts: off }).kind).toBe('none');
  });

  it('bulk ops fall through when the group is off', () => {
    const sel = { hasSelection: true, editing: false };
    expect(classifyGlobalKey('a', mod(), sel).kind).toBe('bulk');
    expect(classifyGlobalKey('a', mod(), { ...sel, shortcuts: off }).kind).toBe('none');
  });

  it('never claims Mod-f/Mod-h — Obsidian keymap owns them in every mode', () => {
    for (const s of [undefined, DEFAULT_SHORTCUT_OVERRIDES, off]) {
      expect(classifyGlobalKey('f', mod(), { ...editing, shortcuts: s }).kind).toBe('none');
      expect(classifyGlobalKey('h', mod(), { ...editing, shortcuts: s }).kind).toBe('none');
    }
  });
});

describe('modifiersOf', () => {
  it('reads all four modifiers off a KeyboardEvent', () => {
    expect(modifiersOf({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toEqual({
      ctrl: true,
      meta: false,
      shift: true,
      alt: false,
    });
  });

  it('reports no modifiers for a bare key', () => {
    expect(modifiersOf({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toEqual(NONE);
  });
});

describe('command ids', () => {
  it('are bare — addCommand adds the plugin prefix itself', () => {
    // Regression guard: shipping 'obsidian-logseq:find-in-page' as the id made
    // addCommand register 'obsidian-logseq:obsidian-logseq:find-in-page', and
    // the lookup by the un-doubled id returned nothing — Ctrl+F silently did
    // nothing. Command ids must stay bare.
    for (const id of [CMD_FIND, CMD_REPLACE]) {
      expect(id.startsWith('obsidian-logseq:')).toBe(false);
      expect(id).not.toContain(':');
    }
  });

  it('qualifies a bare id into the id Obsidian registers', () => {
    expect(qualifiedCommandId('obsidian-logseq', CMD_FIND)).toBe('obsidian-logseq:find-in-page');
    expect(qualifiedCommandId('obsidian-logseq', CMD_FIND)).not.toBe(
      qualifiedCommandId('obsidian-logseq', qualifiedCommandId('obsidian-logseq', CMD_FIND)),
    );
  });
});
