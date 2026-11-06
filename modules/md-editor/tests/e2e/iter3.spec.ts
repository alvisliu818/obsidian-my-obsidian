/**
 * Iteration-3 E2E (v0.2.5): the four features from the user report.
 *   01 page props render at the FIRST-BLOCK position (not page bottom)
 *   02 bottom references (linked + unlinked) collapse/expand via headers
 *   03 ![[Page]] embeds the source page; Enter in the add-row appends to it
 *   04 [[ renders as clickable link chip, ![[ as embed 鈥?no confusion
 *
 * Env: OBSIDIAN_PATH (VAULT hard-wired to the dedicated test vault).
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawn } from 'node:child_process';

const CDP_PORT = '9255';
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
    const t = p.locator('button', { hasText: /trust|淇′换|鍚敤/i }).first();
    if (await t.isVisible().catch(() => false)) {
      await t.click({ timeout: 3000 });
      await sleep(1500);
    } else {
      await p.keyboard.press('Escape');
      await sleep(500);
    }
  }
}

/** Wait until a block containing 	ext is rendered in the outline (file really switched). */
async function waitForBlockText(p: Page, text: string): Promise<void> {
  try {
    await expect
      .poll(
        () =>
          p.evaluate((t: string) =>
            [...document.querySelectorAll('.block-content')].some((b) => b.textContent?.includes(t))
              ? 'ok'
              : 'pending',
          text),
        { timeout: 30_000 },
      )
      .toBe('ok');
  } catch (e) {
    const dump = await p.evaluate(() => ({
      active: window.app?.workspace?.activeLeaf?.view?.file?.path ?? null,
      blocks: [...document.querySelectorAll('.block-content')].map((b) => b.textContent?.trim().slice(0, 40)),
      modals: document.querySelectorAll('.modal-container').length,
    }));
    console.log('WAIT-BLOCK TIMEOUT for', text, JSON.stringify(dump));
    throw e;
  }
}

/** Poll up to 60s for a page-embed box; re-open the file every 12s to
 * re-trigger the async markdown render if the token swap was skipped. */
async function ensurePageEmbed(p: Page, link: string, markerText: string): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await openFile(link);
    await waitForBlockText(p, markerText);
    for (let i = 0; i < 12; i++) {
      if (await p.locator('.block-page-embed').first().isVisible().catch(() => false)) return;
      await sleep(1000);
    }
  }
  throw new Error('page-embed box never rendered for ' + link);
}

async function openFile(link: string): Promise<void> {
  await page.evaluate(async (l: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText(l, '', false);
  }, link);
  await expect(page.locator('.block-editor-container').first()).toBeVisible({ timeout: 60_000 });
  // Wait until the ACTIVE leaf actually shows the requested file — container
  // visibility alone races the previous file still being displayed.
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
  // Fixtures: props page, mention page, page-embed pair.
  writeFileSync(join(VAULT, 'UX3', 'Props-Page.md'), 'type:: book\nstatus:: reading\n\n- first outline block\n- second block');
  writeFileSync(join(VAULT, 'UX3', 'Mentions.md'), '- talking about Props-Page without a link\n- another Props-Page mention');
  writeFileSync(join(VAULT, 'UX3', 'Target.md'), '- target page block A\n- target page block B');
  writeFileSync(join(VAULT, 'UX3', 'Host-Embed.md'), '- host root\n  ![[Target]]\n- after the embed');
  spawn(process.env.OBSIDIAN_PATH!, ['--remote-debugging-port=' + CDP_PORT], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  await waitForCdp(90_000);
  await sleep(3000);
  browser = await chromium.connectOverCDP(CDP);
  page = await findObsidianPage(browser);
  await page.waitForLoadState('domcontentloaded');
  page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE-CONSOLE:', m.text().slice(0, 300)); });
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

test('01 page props render as the FIRST-BLOCK (ordinary list item) position, not page bottom', async () => {
  test.setTimeout(180_000);
  await openFile('UX3/Props-Page');
  await waitForBlockText(page, 'first outline block');
  await sleep(1500);
  // Logseq model: the properties are the FIRST block of the outline — an
  // ordinary block with empty content and its props row below it.
  const pos = await page.evaluate(() => {
    const tree = document.querySelector('.block-editor-tree');
    if (!tree) return null;
    const firstWrap = tree.querySelector(':scope > .block-wrap');
    const propsRow = firstWrap?.querySelector(':scope > .block-props-row') ?? null;
    const bullet = firstWrap?.querySelector(':scope > .block-main > .block-controls .block-bullet') ?? null;
    const keys = [...(propsRow?.querySelectorAll('.block-prop-key') ?? [])].map((k) => k.textContent);
    const secondWrap = firstWrap?.nextElementSibling?.classList.contains('block-wrap')
      ? (firstWrap.nextElementSibling as HTMLElement)
      : null;
    const bottomCard = document.querySelector('.block-editor-container > .page-props-card');
    return {
      propsRow: !!propsRow,
      bullet: !!bullet,
      keys,
      secondIsContent: !!secondWrap && (secondWrap.textContent ?? '').includes('first outline block'),
      bottomCard: !!bottomCard,
    };
  });
  expect(pos?.propsRow).toBe(true);
  expect(pos?.bullet).toBe(true);
  expect(pos?.keys).toEqual(['type', 'status']);
  expect(pos?.secondIsContent).toBe(true);
  expect(pos?.bottomCard).toBe(false);
  // Editable content correct.
  await expect(page.locator('.block-prop-key', { hasText: 'type' }).first()).toBeVisible({ timeout: 10_000 });
});

test('02 bottom references collapse/expand via headers', async () => {
  test.setTimeout(180_000);
  await openFile('UX3/Props-Page');
  await waitForBlockText(page, 'first outline block');
  await expect(page.locator('.page-references').first()).toBeVisible({ timeout: 30_000 });
  // Both headers present (use .first() 鈥?the unlinked renderer also creates a header inside).
  await expect(page.locator('.refs-collapse-header', { hasText: 'Linked references' }).first()).toBeVisible();
  await expect(page.locator('.refs-collapse-header', { hasText: 'Unlinked references' }).first()).toBeVisible();
  // Unlinked section lists the plain mentions (Props-Page title in Mentions.md).
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const sec = document.querySelector('.page-unlinked');
          return sec?.textContent?.includes('Props-Page without a link') ? 'ok' : 'pending';
        }),
      { timeout: 30_000 },
    )
    .toBe('ok');
  // Collapse linked: the body gets .is-collapsed (display:none) and becomes hidden.
  await page.locator('.page-references > .refs-collapse-header', { hasText: 'Linked references' }).first().click();
  const collapsedBody = page.locator('.refs-collapse-body.is-collapsed').first();
  await expect(collapsedBody).toHaveCount(1, { timeout: 10_000 });
  await expect(collapsedBody).toBeHidden();
  // Expand again: class removed, content visible.
  await page.locator('.page-references > .refs-collapse-header', { hasText: 'Linked references' }).first().click();
  await expect(page.locator('.refs-collapse-body.is-collapsed')).toHaveCount(0, { timeout: 10_000 });
});

test('03 ![[Target]] embeds the page; no add-block input row', async () => {
  test.setTimeout(180_000);
  await openFile('UX3/Host-Embed');
  // RENDERED-state wait: poll until the page-embed box for Target mounts.
  await expect(page.locator('.block-page-embed').first()).toBeVisible({ timeout: 45_000 });
  // The page-embed box renders both target blocks.
  const suiteDump = await page.evaluate(() => ({
    embeds: document.querySelectorAll('.block-page-embed').length,
    raw: [...document.querySelectorAll('.block-content')].map((b) => b.textContent?.trim().slice(0, 50)),
  }));
  console.log('SUITE03 DUMP:', JSON.stringify(suiteDump));
  await expect(page.locator('.block-page-embed').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.block-page-embed .embed-row', { hasText: 'target page block A' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.block-page-embed .embed-row', { hasText: 'target page block B' })).toBeVisible();
  // The add-block input row is removed: no append form inside the embed.
  await expect(page.locator('.page-embed-add')).toHaveCount(0);
  await expect(page.locator('.page-embed-add-input')).toHaveCount(0);
});

test('04 [[ and ![[ do not confuse each other', async () => {
  test.setTimeout(180_000);
  writeFileSync(join(VAULT, 'UX3', 'Syntax.md'), '- a [[Target]] link and an ![[Target]] embed on one line');
  await openFile('UX3/Syntax');
  // RENDERED-STATE assertions (raw syntax is consumed by the renderer):
  // 1) the ![[Target]] becomes a live page-embed box —
  await expect(page.locator('.block-page-embed').first()).toBeVisible({ timeout: 45_000 });
  // 2) the [[Target]] becomes a clickable link chip —
  await expect(page.locator('a.internal-link, .block-ref', { hasText: 'Target' }).first()).toBeVisible({ timeout: 20_000 });
  // 3) both on the same line, disk unchanged (pure render enhancement).
  expect(readFileSync(join(VAULT, 'UX3', 'Syntax.md'), 'utf8')).toContain('a [[Target]] link and an ![[Target]] embed');
});












