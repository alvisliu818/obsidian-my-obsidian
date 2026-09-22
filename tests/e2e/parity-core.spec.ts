/**
 * Parity E2E 鈥?new Logseq-md-parity features in a real Obsidian instance:
 *   01 collapse-all / expand-all via real commands (collapsed:: prop round-trip)
 *   02 page-props card renders for files with top-level key:: value props
 *   03 tags panel opens and lists tags
 *   04 backlinks panel linked/unlinked tabs
 *   05 journal prev/next navigation creates + opens adjacent day file
 *
 * Test 06 (file round-trip) lives in parity-roundtrip.spec.ts with its own
 * Obsidian instance 鈥?in-suite it intermittently starved on click timing.
 *
 * Env: OBSIDIAN_PATH, OBSIDIAN_VAULT (plugin deployed, registry switched).
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawn } from 'node:child_process';

const CDP_PORT = '9229';
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
  test.setTimeout(300_000);
  try {
    execSync('taskkill /IM Obsidian.exe /F /T', { stdio: 'ignore' });
  } catch {
    /* none */
  }
  await sleep(2000);
  // Parity fixtures.
  writeFileSync(join(VAULT, 'Parity', 'Props.md'), 'type:: book\nrating:: 5\n\n- content block\n');
  writeFileSync(
    join(VAULT, 'Parity', 'Journal-like.md'),
    '- 2026-09-20 entry\n\t- folded child\n\t\t- deep kid\n- TODO task one',
  );
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

test('01 collapse-all / expand-all commands round-trip', async () => {
  test.setTimeout(120_000);
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText('Parity/Journal-like', '', false);
  });
  await expect(page.locator('.block-editor-container').first()).toBeVisible({ timeout: 60_000 });
  const containersBefore = await page.locator('.block-children-container').count();
  expect(containersBefore).toBeGreaterThan(0);
  // Collapse all through the real command id.
  await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.commands.executeCommandById('obsidian-logseq:collapse-all'),
  );
  await expect(page.locator('.block-children-container')).toHaveCount(0, { timeout: 30_000 });
  // Persisted to disk in Logseq format (debounced save may take a moment).
  await expect
    .poll(() => readFileSync(join(VAULT, 'Parity', 'Journal-like.md'), 'utf8'), { timeout: 30_000 })
    .toContain('collapsed:: true');
  // Expand all restores.
  await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.commands.executeCommandById('obsidian-logseq:expand-all'),
  );
  await expect
    .poll(() => readFileSync(join(VAULT, 'Parity', 'Journal-like.md'), 'utf8'), { timeout: 30_000 })
    .not.toContain('collapsed:: true');
  expect(await page.locator('.block-children-container').count()).toBe(containersBefore);
});

test('02 page-props card renders and stays out of the outline', async () => {
  test.setTimeout(120_000);
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText('Parity/Props', '', false);
  });
  await expect(page.locator('.page-props-card').first()).toBeVisible({ timeout: 60_000 });
  const key = await page.locator('.page-prop-key', { hasText: 'rating' }).first().textContent();
  expect(key).toContain('rating');
  const value = await page.locator('.page-prop-value').first().textContent();
  expect(value?.trim().length).toBeGreaterThan(0);
  // Page props are NOT outline blocks.
  await expect(page.locator('.block-wrap', { hasText: 'type:: book' })).toHaveCount(0);
  // File on disk unchanged (read-only card).
  expect(readFileSync(join(VAULT, 'Parity', 'Props.md'), 'utf8')).toContain('rating:: 5');
});

test('03 tags panel opens and lists tags', async () => {
  test.setTimeout(120_000);
  const ok = await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.commands.executeCommandById('obsidian-logseq:open-tag-panel'),
  );
  expect(ok).toBeTruthy();
  await expect(page.locator('.logseq-panel-tagcloud').first()).toBeVisible({ timeout: 30_000 });
});

test('04 backlinks panel linked/unlinked tabs', async () => {
  test.setTimeout(120_000);
  const ok = await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.commands.executeCommandById('obsidian-logseq:open-backlink-panel'),
  );
  expect(ok).toBeTruthy();
  await expect(page.locator('.logseq-panel-tabs .logseq-panel-tab').first()).toBeVisible({ timeout: 30_000 });
});

test('05 journal prev/next navigation creates adjacent day', async () => {
  test.setTimeout(150_000);
  // Open (create) today's journal first.
  await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.commands.executeCommandById('obsidian-logseq:open-today-journal'),
  );
  await sleep(2000);
  // Next day from today.
  await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.commands.executeCommandById('obsidian-logseq:open-next-journal'),
  );
  await sleep(2500);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  expect(readFileSync(join(VAULT, name + '.md'), 'utf8')).toBeDefined();
  // Prev twice from tomorrow lands on yesterday 鈥?anchored on the OPEN file.
  await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.commands.executeCommandById('obsidian-logseq:open-prev-journal'),
  );
  await sleep(2000);
  await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.commands.executeCommandById('obsidian-logseq:open-prev-journal'),
  );
  await sleep(2500);
  const yest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const yname = `${yest.getFullYear()}-${pad(yest.getMonth() + 1)}-${pad(yest.getDate())}`;
  expect(readFileSync(join(VAULT, yname + '.md'), 'utf8')).toBeDefined();
});

