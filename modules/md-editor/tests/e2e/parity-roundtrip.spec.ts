/**
 * Parity round-trip (isolated): in-app edit 鈫?save 鈫?reopen 鈫?verify props,
 * hierarchy, and links survive; then cross-check the file with Logseq md
 * conventions. Runs in its OWN Obsidian instance so panel/journal leftovers
 * from the core parity suite cannot interfere.
 *
 * Env: OBSIDIAN_PATH, OBSIDIAN_VAULT (plugin deployed, registry switched).
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawn } from 'node:child_process';

const CDP_PORT = '9231';
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VAULT = 'E:\\\\HOME\\\\Local\\\\logseq-e2e-vault';

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
  throw new Error(`CDP ${CDP} did not come up`);
}

async function findObsidianPage(b: Browser): Promise<Page> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const ctx of b.contexts()) {
      for (const p of ctx.pages()) {
        if (p.url().startsWith('app://') || p.url().includes('obsidian')) return p;
      }
    }
    await sleep(500);
  }
  throw new Error('Obsidian page not found');
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  try {
    execSync('taskkill /IM Obsidian.exe /F /T', { stdio: 'ignore' });
  } catch {
    /* none */
  }
  await sleep(2000);
  // Deterministic fixture.
  writeFileSync(join(VAULT, 'Parity', 'Props.md'), 'type:: book\nrating:: 5\n\n- content block\n');
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
      .locator('button', { hasText: /trust|淇′换/i })
      .first()
      .click({ timeout: 12_000 });
    await sleep(2500);
  } catch {
    /* no dialog */
  }
  for (let i = 0; i < 3; i++) {
    try {
      await page.keyboard.press('Escape');
      await sleep(300);
    } catch {
      /* ignore */
    }
  }
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

test('06 file round-trip: props and blocks survive reopen (isolated)', async () => {
  test.setTimeout(180_000);
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText('Parity/Props', '', false);
  });
  await expect(page.locator('.page-props-card').first()).toBeVisible({ timeout: 60_000 });

  // Edit a block in-app (assert the CM6 editor mounted).
  const block = page.locator('.block-content', { hasText: 'content block' }).first();
  await block.click();
  await expect(page.locator('.block-content.is-editing .cm-content')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('End');
  await page.keyboard.type(' edited');
  await expect(page.locator('.block-content.is-editing .cm-content')).toContainText('content block edited', {
    timeout: 10_000,
  });
  await page.keyboard.press('Escape');
  // Save lands on disk before reopen (isolates save vs reopen bugs).
  await expect
    .poll(() => readFileSync(join(VAULT, 'Parity', 'Props.md'), 'utf8'), { timeout: 45_000 })
    .toContain('- content block edited');

  // Detach + reopen the file.
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (window as any).app;
    a.workspace.activeLeaf?.detach?.();
    await sleep(1500);
    await a.workspace.openLinkText('Parity/Props', '', false);
  });
  await expect(page.locator('.page-props-card').first()).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('.block-wrap', { hasText: 'content block edited' })).toHaveCount(1, { timeout: 30_000 });

  // Logseq md conventions preserved on disk: page props + block content.
  const onDisk = readFileSync(join(VAULT, 'Parity', 'Props.md'), 'utf8');
  expect(onDisk).toContain('type:: book');
  expect(onDisk).toContain('rating:: 5');
  expect(onDisk).toContain('- content block edited');
});

