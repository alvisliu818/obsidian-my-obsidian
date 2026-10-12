/**
 * Regression guard for the Ctrl+F key conflict.
 *
 * Root cause (found by probing a real Obsidian instance, not by reading code):
 * CM6's `defaultKeymap` binds `Mod-f` to `openSearchPanel`, which requires the
 * `search()` extension. This plugin never mounts it — it provides its own
 * outline-level find bar. So while a block was being edited, CM6 consumed
 * Ctrl+F on its own keymap, called `preventDefault()`, and opened nothing:
 *
 *   - the key never reached Obsidian's keymap, so our `find-in-page` command
 *     (registered with `hotkeys`) never fired;
 *   - no ancestor DOM listener could intercept it either, because CM6 consumes
 *     the event on the target itself, below every ancestor.
 *
 * Fix: strip `Mod-f` / `Mod-h` from every `defaultKeymap` we install, so the
 * key bubbles to Obsidian.
 *
 * The assertions below are deliberately about the SHAPE of the filter set, not
 * about CM6 internals, so they keep working when CM6 is upgraded.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Keys CM6's defaultKeymap binds to features this plugin does not mount. */
const MUST_NOT_BE_IN_DEFAULT_KEYMAP = ['Mod-f', 'Mod-h'];

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('CM6 defaultKeymap filtering', () => {
  const extensionsSrc = read('src/editor/extensions.ts');
  const codeEditSrc = read('src/blocks/codeBlockEdit.ts');

  it('ALWAYS_STRIPPED_DEFAULT_KEYS lists Mod-f and Mod-h', () => {
    // The always-stripped set moved to interactions/defaultKeymapOwnership.ts
    // so it can be unit-tested without loading obsidian.
    const ownershipSrc = read('src/interactions/defaultKeymapOwnership.ts');
    const block = ownershipSrc.slice(ownershipSrc.indexOf('ALWAYS_STRIPPED_DEFAULT_KEYS'));
    const end = block.indexOf(';');
    const setBody = block.slice(0, end);
    for (const k of MUST_NOT_BE_IN_DEFAULT_KEYMAP) {
      expect(setBody, `${k} must be filtered out of defaultKeymap`).toContain(`'${k}'`);
    }
  });

  it('every defaultKeymap install goes through a Mod-f/Mod-h filter', () => {
    // createEditorExtensions + createEmbedExtensions filter via
    // ownedDefaultKeys(); codeBlockEdit filters inline. Nothing may spread
    // `...defaultKeymap` unfiltered.
    const rawSpreads = [
      ...extensionsSrc.matchAll(/\.\.\.defaultKeymap(?!\.filter)/g),
      ...codeEditSrc.matchAll(/\.\.\.defaultKeymap(?!\.filter)/g),
    ];
    expect(rawSpreads.map((m) => m[0]), 'unfiltered defaultKeymap spread found').toEqual([]);

    const filtered = [
      ...extensionsSrc.matchAll(/defaultKeymap\.filter\(/g),
      ...codeEditSrc.matchAll(/defaultKeymap\.filter\(/g),
    ];
    expect(filtered.length, 'expected every install site to filter').toBeGreaterThanOrEqual(3);
  });

  it('the code-block editor also drops Mod-f and Mod-h explicitly', () => {
    const filterLine = codeEditSrc
      .split('\n')
      .find((l) => l.includes('defaultKeymap.filter'));
    expect(filterLine, 'codeBlockEdit must filter defaultKeymap').toBeTruthy();
    for (const k of MUST_NOT_BE_IN_DEFAULT_KEYMAP) {
      expect(filterLine).toContain(`'${k}'`);
    }
  });

  it('find/replace are routed through Obsidian commands, not a DOM listener', () => {
    const mainSrc = read('src/main.ts');
    // The commands must declare `hotkeys`, otherwise nothing dispatches them.
    expect(mainSrc).toMatch(/id:\s*CMD_FIND[\s\S]{0,200}?hotkeys:\s*\[\{\s*modifiers:\s*\['Mod'\],\s*key:\s*'f'/);
    expect(mainSrc).toMatch(/id:\s*CMD_REPLACE[\s\S]{0,200}?hotkeys:\s*\[\{\s*modifiers:\s*\['Mod'\],\s*key:\s*'h'/);
  });
});
