/**
 * Rollback drill: verify that the v0.1.0-baseline build loads and operates in
 * a real Obsidian instance after the v0.2.0 campaign (downgrade simulation).
 *
 * Prereqs: OBSIDIAN_PATH set; the E2E vault's plugin dir already contains the
 * OLD build (the drill script copies it); vault registry pointed at the E2E
 * vault via use-vault.mjs.
 *
 * Checks: app boots → plugin enabled → block editor renders fixture →
 * commands registered (v0.1.0 command set: no operation-log commands).
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { join } from 'node:path';

const CDP_PORT = '9227';
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let browser: Browser | null = null;
let page: Page;

async function waitForCdp(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${CDP}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('CDP did not come up');
}

async function findObsidianPage(b: Browser): Promise<Page> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const ctx of b.contexts()) {
      for (const p of ctx.pages()) {
        const url = p.url();
        if (url.startsWith('app://') || url.includes('obsidian')) return p;
      }
    }
    await sleep(500);
  }
  throw new Error('Obsidian page not found');
}

test('v0.1.0-baseline build loads and operates after downgrade', async () => {
  test.setTimeout(240_000);
  try {
    execSync('taskkill /IM Obsidian.exe /F /T', { stdio: 'ignore' });
  } catch {
    /* none */
  }
  await sleep(2000);
  spawn(process.env.OBSIDIAN_PATH!, ['--remote-debugging-port=' + CDP_PORT], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  await waitForCdp(90_000);
  await sleep(3000);
  browser = await chromium.connectOverCDP(CDP);
  page = await findObsidianPage(browser);
  await page.waitForLoadState('domcontentloaded');
  try {
    await page
      .locator('button', { hasText: /trust|信任/i })
      .first()
      .click({ timeout: 10_000 });
    await sleep(2000);
  } catch {
    /* no dialog */
  }
  // v0.1.0 plugin must be enabled and its editor must render.
  const loaded = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (window as any).app;
    return !!a?.plugins?.plugins?.['obsidian-logseq'];
  });
  expect(loaded).toBe(true);
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText('E2E/Home', '', false);
  });
  await expect(page.locator('.block-editor-container').first()).toBeVisible({ timeout: 60_000 });
  // v0.1.0 command set: editor switch exists; operation-log commands must NOT exist.
  const ids = await page.evaluate(() =>
    Object.keys(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((window as any).app.commands.commands as Record<string, unknown>),
    ).filter((id) => id.startsWith('obsidian-logseq:')),
  );
  expect(ids).toContain('obsidian-logseq:open-with-block-editor');
  expect(ids).not.toContain('obsidian-logseq:show-operation-log');
  // Editing still works on the old version.
  const block = page.locator('.block-content', { hasText: 'alpha' }).first();
  await block.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' rollback-ok');
  await page.keyboard.press('Escape');
  await expect(page.locator('.block-wrap', { hasText: 'rollback-ok' })).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
  try {
    browser?.close();
  } catch {
    /* ignore */
  }
  try {
    execSync('taskkill /IM Obsidian.exe /F /T', { stdio: 'ignore' });
  } catch {
    /* gone */
  }
});
