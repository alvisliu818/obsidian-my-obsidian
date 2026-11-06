/**
 * iter3-07: selection context menu (native-editor parity). Right-clicking
 * inside the focused editor with a text selection offers Cut / Copy / Paste /
 * Select all over the CM6 selection — the same items the native Obsidian
 * editor shows. Right-click outside an editor still opens the block menu.
 * Isolated instance.
 */

import { test, expect } from '@playwright/test';
import { launchObsidian, closeObsidian, openFile, sleep, type Ctx } from './iter3-helpers';

const ctx: Ctx = { browser: null, page: null as unknown as Page };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  await launchObsidian(ctx, {
    'UX3/Menu.md': '- context menu target block',
  });
  // Surface page-side errors during the native slash flow.
  ctx.page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 300)));
  ctx.page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[console.error]', msg.text().slice(0, 600));
  });
});

test.afterAll(async () => {
  await closeObsidian(ctx);
});

const menuItem = (title: string) =>
  ctx.page.locator('.menu .menu-item', { has: ctx.page.locator(`.menu-item-title:text-is("${title}")`) });

test('07 selection right-click offers cut/copy/paste/select-all (native parity)', async () => {
  test.setTimeout(180_000);
  await openFile(ctx, 'UX3/Menu');
  const content = ctx.page.locator('.cm-content').first();
  await ctx.page.locator('.block-content').first().click();
  await content.waitFor({ timeout: 15_000 });
  await sleep(300);
  await ctx.page.keyboard.press('Control+a');
  await ctx.page.keyboard.type('hello world');
  await sleep(200);
  await ctx.page.keyboard.press('Control+a');
  await sleep(200);

  // Right-click on the selection → native-editor items.
  await content.click({ button: 'right' });
  await expect(ctx.page.locator('.menu').first()).toBeVisible({ timeout: 10_000 });
  for (const title of ['Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all', 'Insert link', 'Insert external link', 'Formatting', 'Paragraph', 'Insert']) {
    await expect(menuItem(title)).toBeVisible();
  }

  // The Formatting submenu holds the native toggle items.
  await menuItem('Formatting').click();
  await sleep(300);
  for (const title of ['Bold', 'Italic', 'Strikethrough', 'Highlight', 'Code', 'Math', 'Comment', 'Clear formatting']) {
    await expect(ctx.page.locator('.menu .menu-item', { has: ctx.page.locator(`.menu-item-title:text-is("${title}")`) }).last()).toBeVisible();
  }

  // The editor-menu workspace event is triggered with a working adapter:
  // a listener registered on the app contributes an item, exactly like the
  // native editor does for plugins. (A fresh right-click dismisses the
  // previous menu — Esc would commit and leave the editor instead.)
  await ctx.page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.app.workspace.on('editor-menu', (menu: any, editor: any) => {
      const value = editor?.getValue?.() ?? '';
      if (typeof value === 'string' && value.includes('hello world')) {
        menu.addItem((item: any) => item.setTitle('PROBE_CONTRIBUTION'));
      }
    });
  });
  await content.click({ button: 'right' });
  await expect(ctx.page.locator('.menu').first()).toBeVisible({ timeout: 10_000 });
  await expect(menuItem('PROBE_CONTRIBUTION')).toBeVisible({ timeout: 10_000 });

  // Copy puts the selection on the clipboard.
  await menuItem('Copy').click();
  await sleep(300);
  const copied = await ctx.page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe('hello world');

  // Paste replaces the selection with clipboard content.
  await ctx.page.evaluate(() => navigator.clipboard.writeText('XYZ'));
  await content.click({ button: 'right' });
  await expect(ctx.page.locator('.menu').first()).toBeVisible({ timeout: 10_000 });
  await menuItem('Paste').click();
  await sleep(300);
  await expect(content).toHaveText('XYZ', { timeout: 10_000 });

  // Cut removes the selection into the clipboard.
  await ctx.page.keyboard.press('Control+a');
  await sleep(200);
  await content.click({ button: 'right' });
  await expect(ctx.page.locator('.menu').first()).toBeVisible({ timeout: 10_000 });
  await menuItem('Cut').click();
  await sleep(300);
  await expect(content).toHaveText('', { timeout: 10_000 });
  const cut = await ctx.page.evaluate(() => navigator.clipboard.readText());
  expect(cut).toBe('XYZ');

  // Select all via the menu: type text, then Select all selects the doc —
  // verified by typing over it.
  await ctx.page.keyboard.type('abc');
  await sleep(200);
  await content.click({ button: 'right' });
  await expect(ctx.page.locator('.menu').first()).toBeVisible({ timeout: 10_000 });
  await menuItem('Select all').click();
  await sleep(200);
  await ctx.page.keyboard.type('!');
  await expect(content).toHaveText('!', { timeout: 10_000 });
});

test('07c plugin-contributed panels open (Highlightr second menu)', async () => {
  test.setTimeout(180_000);
  const installed = await ctx.page.evaluate(
    () =>
      !!(
        (
          window as unknown as {
            app?: { plugins?: { plugins?: Record<string, unknown> } };
          }
        ).app?.plugins?.plugins?.['highlightr-plugin']
      ),
  );
  test.skip(!installed, 'highlightr-plugin not installed in this vault');
  await openFile(ctx, 'UX3/Menu');
  const content = ctx.page.locator('.cm-content').first();
  await ctx.page.locator('.block-content').first().click();
  await content.waitFor({ timeout: 15_000 });
  await sleep(300);
  await ctx.page.keyboard.press('Control+a');
  await ctx.page.keyboard.type('highlight me');
  await sleep(200);
  await ctx.page.keyboard.press('Control+a');
  await sleep(200);
  await content.click({ button: 'right' });
  await expect(ctx.page.locator('.menu').first()).toBeVisible({ timeout: 10_000 });
  await expect(menuItem('Highlight')).toBeVisible({ timeout: 10_000 });
  // The plugin's second panel (its own color menu) must pop up, and picking
  // a color must APPLY the highlight through the editor-menu adapter.
  await menuItem('Highlight').click();
  const colorMenu = ctx.page.locator('.menu.highlighterContainer').last();
  await expect(colorMenu).toBeVisible({ timeout: 10_000 });
  await colorMenu.locator('.menu-item').first().click();
  await sleep(400);
  await expect(content).toContainText('<mark', { timeout: 10_000 });
  await ctx.page.keyboard.press('Escape');
});

test('07b right-click outside an editor still opens the block menu', async () => {
  test.setTimeout(180_000);
  await ctx.page.locator('.block-content').first().click();
  await ctx.page.waitForSelector('.cm-editor .cm-content', { timeout: 15_000 });
  await sleep(300);
  // Click elsewhere to commit + leave editing mode.
  await ctx.page.keyboard.press('Escape');
  await sleep(600);
  await ctx.page.locator('.block-content').first().click({ button: 'right' });
  await expect(ctx.page.locator('.menu').first()).toBeVisible({ timeout: 10_000 });
  await expect(ctx.page.locator('.menu .menu-item', { hasText: 'Copy block reference' })).toBeVisible();
  await ctx.page.keyboard.press('Escape');
});

test('07d slash key opens the NATIVE slash menu with core + plugin commands', async () => {
  test.setTimeout(180_000);
  await openFile(ctx, 'UX3/Menu');
  // Register a plugin-shaped editor command (what other plugins do).
  await ctx.page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const plugin = w.app.plugins.plugins['highlightr-plugin'] ?? w.app.plugins.plugins['obsidian-logseq'];
    plugin.addCommand({
      id: 'probe-slash-cmd',
      name: 'Probe slash command',
      editorCallback: (editor: any) => editor.replaceSelection('HELLO_FROM_SLASH'),
    });
  });
  const content = ctx.page.locator('.cm-content').first();
  await ctx.page.locator('.block-content').first().click();
  await content.waitFor({ timeout: 15_000 });
  await sleep(300);
  await ctx.page.keyboard.press('Control+a');
  await ctx.page.keyboard.type('/'); // '/' at line start triggers the native menu
  await sleep(800);
  // The NATIVE slash menu is showing (core + plugins + our built-ins).
  const menuState = await ctx.page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es = (window as any).app?.workspace?.editorSuggest;
    const items = [...document.querySelectorAll('.suggestion-item')].map((i) => i.textContent?.trim() ?? '');
    return {
      showing: es?.isShowingSuggestion?.() ?? false,
      count: items.length,
      // Our built-in slash items carry the 'Logseq' detail tag and lead the
      // list ('Open today' was a non-editor command and never rendered here).
      hasOurs: items.some((t) => t?.includes('Logseq')),
      hasCore: items.some((t) => t?.includes('插入表格') || t?.toLowerCase().includes('insert table')),
    };
  });
  console.log('menu:', JSON.stringify(menuState));
  expect(menuState.showing).toBe(true);
  expect(menuState.count).toBeGreaterThan(10);  // Deleting the '/' closes the NATIVE menu (re-evaluation on doc change).
  await ctx.page.keyboard.press('Backspace');
  await sleep(600);
  const closed = await ctx.page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es = (window as any).app?.workspace?.editorSuggest;
    return { showing: es?.isShowingSuggestion?.() ?? false, doc: document.querySelector('.cm-content')?.textContent };
  });

  expect(closed.showing).toBe(false);
  expect(closed.doc).toBe(''); // the '/' itself was deleted
  expect(menuState.hasOurs).toBe(true);
  expect(menuState.hasCore).toBe(true);
  // The editor is still alive with an empty doc: editor commands execute
  // through the activeEditor adapter (exactly like a native menu pick).
  await ctx.page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.commands.executeCommandById('highlightr-plugin:probe-slash-cmd');
  });
  await sleep(500);
  await expect(content).toContainText('HELLO_FROM_SLASH', { timeout: 10_000 });
});