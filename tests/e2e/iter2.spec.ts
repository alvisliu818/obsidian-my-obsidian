/**
 * Iteration-2 E2E (v0.2.4): the three features from the user report.
 *   01 embed-block Enter creates a new block below in the HOST page
 *   02 page-props card shows empty state and allows adding properties
 *   03 unlinked mentions section lists + one-click converts to [[link]]
 *
 * Env: OBSIDIAN_PATH (VAULT hard-wired to the dedicated test vault).
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawn } from 'node:child_process';

const CDP_PORT = '9254';
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VAULT = 'E:\\HOME\\Local\\logseq-e2e-vault';

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

async function dismissModals(p: Page): Promise<void> {
  for (let k = 0; k < 10; k++) {
    const modal = await p.locator('.modal-container.mod-dim').first().isVisible().catch(() => false);
    if (!modal) return;
    const t = p.locator('button', { hasText: /trust|信任|启用/i }).first();
    if (await t.isVisible().catch(() => false)) {
      await t.click({ timeout: 3000 });
      await sleep(1500);
    } else {
      await p.keyboard.press('Escape');
      await sleep(500);
    }
  }
}

async function openFile(link: string): Promise<void> {
  await page.evaluate(async (l: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText(l, '', false);
  }, link);
  await expect(page.locator('.block-editor-container').first()).toBeVisible({ timeout: 60_000 });
  await page.bringToFront();
  await dismissModals(page);
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  try {
    execSync('taskkill /IM Obsidian.exe /F /T', { stdio: 'ignore' });
  } catch {
    /* none */
  }
  await sleep(2000);
  writeFileSync(join(VAULT, 'UX', 'Embed.md'), '- top block\n- embed me\n\tid:: 88888888-8888-4888-8888-888888888888\n- after embed');
  writeFileSync(join(VAULT, 'UX', 'EmbedHost.md'), '- host page\n  {{embed ((88888888-8888-4888-8888-888888888888))}}\n- tail');
  writeFileSync(join(VAULT, 'UX', 'Empty-Props.md'), '- just one block, no page props yet');
  // Mentions: 'Journal-2' appears as plain text in Mentions.md (no [[ ]]).
  writeFileSync(join(VAULT, 'UX', 'Mentions.md'), '- plain mention of Journal-2 here\n- and Journal-2 again');
  writeFileSync(join(VAULT, 'UX', 'Journal-2.md'), '- journal page that gets mentioned');
  spawn(process.env.OBSIDIAN_PATH!, ['--remote-debugging-port=' + CDP_PORT], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  await waitForCdp(90_000);
  await sleep(3000);
  browser = await chromium.connectOverCDP(CDP);
  page = await findObsidianPage(browser);
  await page.waitForLoadState('domcontentloaded');
  await page.bringToFront();
  await dismissModals(page);
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

test('01 embed-block Enter creates a new block below in the host page', async () => {
  test.setTimeout(180_000);
  await openFile('UX/EmbedHost');
  const row = page.locator('.block-embed .embed-content').first();
  await row.click({ timeout: 20_000 });
  await expect(page.locator('.block-embed .embed-content .cm-editor')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' v24 tail');
  await page.keyboard.press('Enter');
  // Focus lands in the NEW outline block below the embed.
  await expect(page.locator('.block-content.is-editing .cm-content')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.type('fresh block v24');
  await page.keyboard.press('Escape');
  // Persisted: embed text intact, new block below the host block.
  await expect
    .poll(
      () => (readFileSync(join(VAULT, 'UX', 'EmbedHost.md'), 'utf8').includes('fresh block v24') ? 'ok' : 'pending'),
      { timeout: 45_000, intervals: [500, 1000, 2000, 4000] },
    )
    .toBe('ok');
  const disk = readFileSync(join(VAULT, 'UX', 'EmbedHost.md'), 'utf8');
  expect(disk).toContain('{{embed ((88888888-8888-4888-8888-888888888888))}}');
  expect(disk).toContain('- fresh block v24');
  // Embed source file untouched by the Enter (only the typed text commit).
});

test('02 page-props card empty state + add first property', async () => {
  test.setTimeout(180_000);
  await openFile('UX/Empty-Props');
  // Empty-state card visible.
  await expect(page.locator('.page-props-card.is-empty').first()).toBeVisible({ timeout: 30_000 });
  // Enter edit mode and add a property.
  await page.locator('.page-props-edit').first().click();
  await expect(page.locator('.page-props-card.is-editing')).toBeVisible({ timeout: 10_000 });
  await page.locator('.page-prop-row.is-add-row .page-prop-input-key').fill('type');
  await page.locator('.page-prop-row.is-add-row .page-prop-input-value').fill('book');
  await page.locator('.page-prop-add').first().click();
  await page.locator('.page-props-btns .mod-cta').click();
  await expect
    .poll(
      () => (readFileSync(join(VAULT, 'UX', 'Empty-Props.md'), 'utf8').includes('type:: book') ? 'ok' : 'pending'),
      { timeout: 45_000, intervals: [500, 1000, 2000, 4000] },
    )
    .toBe('ok');
  // Card re-renders non-empty with the new prop; original block intact.
  await expect(page.locator('.page-prop-key', { hasText: 'type' }).first()).toBeVisible({ timeout: 30_000 });
  expect(readFileSync(join(VAULT, 'UX', 'Empty-Props.md'), 'utf8')).toContain('- just one block, no page props yet');
});

test('03 unlinked mentions listed + one-click convert to link', async () => {
  test.setTimeout(180_000);
  await openFile('UX/Journal-2');
  // Bottom section lists the plain-text mentions from Mentions.md.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const sec = document.querySelector('.page-unlinked');
          if (!sec) return 'missing';
          return sec.textContent?.includes('plain mention of Journal-2') ? 'ok' : 'no-hit';
        }),
      { timeout: 30_000 },
    )
    .toBe('ok');
  // Click the first row → converts to [[Journal-2]] in Mentions.md.
  await page.locator('.page-unlinked-item').first().click();
  await expect
    .poll(
      () => (readFileSync(join(VAULT, 'UX', 'Mentions.md'), 'utf8').includes('[[Journal-2]]') ? 'ok' : 'pending'),
      { timeout: 45_000, intervals: [500, 1000, 2000, 4000] },
    )
    .toBe('ok');
  const disk = readFileSync(join(VAULT, 'UX', 'Mentions.md'), 'utf8');
  expect(disk).toContain('- plain mention of [[Journal-2]] here');
  // The converted line no longer counts as unlinked; the section refreshes.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const sec = document.querySelector('.page-unlinked');
          if (!sec) return 'missing';
          const rows = sec.querySelectorAll('.page-unlinked-item').length;
          return rows;
        }),
      { timeout: 30_000 },
    )
    .toBe(1); // 'and Journal-2 again' remains
});
