/**
 * E2E: core block-editor interactions inside a real Obsidian instance.
 *
 * Run:  npm run e2e
 * Env:  OBSIDIAN_PATH = path to Obsidian.exe
 *       OBSIDIAN_VAULT = path to a test vault with this plugin enabled and
 *                        an "E2E/Home.md" file containing `- alpha`.
 */

import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';

const HOME = 'E2E/Home';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const exe = process.env.OBSIDIAN_PATH;
  const vault = process.env.OBSIDIAN_VAULT;
  test.skip(!exe || !vault, 'OBSIDIAN_PATH / OBSIDIAN_VAULT not set');
  app = await _electron.launch({ executablePath: exe!, args: [vault!] });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Open the fixture page through Obsidian's own workspace API.
  await page.evaluate(async (link: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText(link, '', false);
  }, HOME);
  await expect(page.locator('.block-editor-container')).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
  // Restore the fixture content for reproducible runs.
  if (page) {
    await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = (window as any).app;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const f = a.vault.getAbstractFileByPath('E2E/Home.md');
      if (f) await a.vault.modify(f, '- alpha\n');
    });
  }
  await app?.close();
});

test('file opens in the block editor with list blocks', async () => {
  await expect(page.locator('.block-wrap', { hasText: 'alpha' })).toBeVisible();
});

test('click focuses a block into CM6, Enter splits it', async () => {
  const block = page.locator('.block-content', { hasText: 'alpha' }).first();
  await block.click();
  await expect(page.locator('.block-content.is-editing .cm-editor')).toBeVisible();
  await page.keyboard.press('End');
  await page.keyboard.type(' beta');
  await page.keyboard.press('Enter');
  await page.keyboard.type('gamma');
  await page.keyboard.press('Escape');
  await expect(page.locator('.block-wrap', { hasText: 'alpha beta' })).toBeVisible();
  await expect(page.locator('.block-wrap', { hasText: 'gamma' })).toBeVisible();
});

test('Tab indents the focused block under its previous sibling', async () => {
  const block = page.locator('.block-content', { hasText: 'gamma' }).first();
  await block.click();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  // gamma is now a child of alpha-beta → one .block-children container exists.
  await expect(page.locator('.block-children .block-wrap', { hasText: 'gamma' })).toBeVisible();
});

test('Ctrl+Enter cycles the TODO marker', async () => {
  const block = page.locator('.block-content', { hasText: 'alpha' }).first();
  await block.click();
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.block-marker.todo').first()).toBeVisible();
});

test('Ctrl+F opens the in-page search bar', async () => {
  await page.keyboard.press('Control+f');
  await expect(page.locator('.block-editor-searchbar')).toBeVisible();
  await page.keyboard.type('gamma');
  await expect(page.locator('.block-editor-searchbar mark').first()).toBeVisible();
  await page.keyboard.press('Escape');
});

test('multi-select via Ctrl+click and bulk delete', async () => {
  await page.locator('.block-content', { hasText: 'alpha' }).first().click();
  const gamma = page.locator('.block-content', { hasText: 'gamma' }).first();
  await page.keyboard.press('Control');
  await gamma.click({ modifiers: ['Control'] });
  await page.keyboard.up('Control');
  await expect(page.locator('.block-wrap.is-selected').first()).toBeVisible();
  await page.keyboard.press('Control+d'); // duplicate both
  await expect(page.locator('.block-wrap', { hasText: 'alpha' })).toHaveCount(2, { timeout: 10_000 });
});
