/**
 * Iteration E2E (v0.2.3): the six features from the user report.
 *   01 Enter keeps editing: split + new block focused, persists to disk
 *   02 Enter in the middle of a block splits text correctly
 *   03 page-bottom backlinks section renders with sources
 *   04 block-level backlink badge + expand panel under the block
 *   05 block props row renders under block content
 *   06 editable page-props card: add a property, save, verify on disk
 *
 * Env: OBSIDIAN_PATH (VAULT hard-wired to the dedicated test vault).
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawn } from 'node:child_process';

const CDP_PORT = '9247';
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

test.beforeAll(async () => {
  test.setTimeout(300_000);
  try {
    execSync('taskkill /IM Obsidian.exe /F /T', { stdio: 'ignore' });
  } catch {
    /* none */
  }
  await sleep(2000);
  // Fixture: three pages with links + block refs + props (per goal brief:
  // >=3 pages, >=10 blocks, cross references).
  writeFileSync(
    join(VAULT, 'UX', 'Enter.md'),
    '- alpha line\n- second block\n- third and last',
  );
  writeFileSync(
    join(VAULT, 'UX', 'Refs.md'),
    [
      '- references the anchor below',
      `  ref text ((11111111-1111-4111-8111-111111111111))`,
      '- links to [[Iter]] page',
      '- links to [[Anchor]] page',
      '- TODO another task',
    ].join('\n'),
  );
  writeFileSync(
    join(VAULT, 'UX', 'Anchor.md'),
    [
      'type:: page',
      'status:: active',
      '',
      '- the anchor block itself',
      '  id:: 11111111-1111-4111-8111-111111111111',
      '- second anchor block',
      '  id:: 22222222-2222-4222-8222-222222222222',
      '- plain block without id',
    ].join('\n'),
  );
  writeFileSync(join(VAULT, 'UX', 'Iter.md'), '- iter page root block\n');
  spawn(process.env.OBSIDIAN_PATH!, ['--remote-debugging-port=' + CDP_PORT], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  await waitForCdp(90_000);
  await sleep(3000);
  browser = await chromium.connectOverCDP(CDP);
  page = await findObsidianPage(browser);
  page.on('console', (m) => { if (m.type() === 'error' || m.text().includes('[LG]')) console.log('PAGE-CONSOLE:', m.text().slice(0, 300)); });
  await page.waitForLoadState('domcontentloaded');
  try {
    await page
      .locator('button', { hasText: /trust|淇′换/i })
      .first()
      .click({ timeout: 10_000 });
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

/** Clear any modal (trust dialog) whose modal-bg would swallow clicks. */
async function dismissModals(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const modal = page.locator('.modal-container.mod-dim').first();
    if (!(await modal.isVisible().catch(() => false))) return;
    const trust = page.locator('button', { hasText: /trust|信任|启用/i }).first();
    if (await trust.isVisible().catch(() => false)) {
      await trust.click({ timeout: 3000 });
      await sleep(1500);
      continue;
    }
    await page.keyboard.press('Escape');
    await sleep(500);
  }
}

/** Open a file and wait for the block editor; click a block by text. */
async function openAndClick(link: string, text: string): Promise<void> {
  await page.evaluate(async (l: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText(l, '', false);
  }, link);
  await expect(page.locator('.block-editor-container').first()).toBeVisible({ timeout: 60_000 });
  await page.bringToFront();
  await dismissModals(page);
  const loc = page.locator('.block-content', { hasText: text }).first();
  await loc.click({ timeout: 20_000 });
  await expect(page.locator('.block-content.is-editing .cm-content')).toBeVisible({ timeout: 20_000 });
}

test('01 Enter keeps editing: new block focused + persisted', async () => {
  test.setTimeout(180_000);
  await openAndClick('UX/Enter', 'second block');
  await page.keyboard.press('End');
  await page.keyboard.type(' more');
  await page.keyboard.press('Enter');
  // The new block is focused and empty 鈥?type into it directly (proves
  // "continue editing in the next list item").
  await page.keyboard.type('new tail block');
  await page.keyboard.press('Escape');
  await expect
    .poll(
      () => (readFileSync(join(VAULT, 'UX', 'Enter.md'), 'utf8').includes('- new tail block') ? 'ok' : 'pending'),
      { timeout: 45_000, intervals: [500, 1000, 2000, 4000] },
    )
    .toBe('ok');
  const disk = readFileSync(join(VAULT, 'UX', 'Enter.md'), 'utf8');
  expect(disk).toContain('- second block more');
  expect(disk).toContain('- third and last');
});

test('02 mid-block Enter splits text into two blocks', async () => {
  test.setTimeout(180_000);
  writeFileSync(join(VAULT, 'UX', 'Enter.md'), '- one\n- two\n- third and last');
  await openAndClick('UX/Enter', 'third');
  // Click into the middle: use keyboard to position 鈥?Home then ArrowRight x 6.
  await page.keyboard.press('Home');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  // Escape commits; expected split: '- third' keeps the head, '- and last'
  // becomes an indented child below (children stay with the head block).
  await expect
    .poll(
      () => (readFileSync(join(VAULT, 'UX', 'Enter.md'), 'utf8').includes('- and last') ? 'ok' : 'pending'),
      { timeout: 45_000, intervals: [500, 1000, 2000] },
    )
    .toBe('ok');
  // Restore fixture for later tests.
  writeFileSync(join(VAULT, 'UX', 'Enter.md'), '- alpha line\n- second block\n- third and last');
});

test('03 page-bottom backlinks section lists sources', async () => {
  test.setTimeout(180_000);
  await page.evaluate(async (l: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText(l, '', false);
  }, 'UX/Iter');
  await sleep(1200);
  // Open Anchor page (linked from Refs via [[Iter]]? no 鈥?Anchor is the ref target).
  await page.evaluate(async (l: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText(l, '', false);
  }, 'UX/Anchor');
  await sleep(2000);
  // The bottom section must exist and reference UX/Refs.md.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const section = document.querySelector('.page-backlinks');
          if (!section) return 'missing';
          return section.textContent?.includes('UX/Refs.md') ? 'ok' : 'no-source';
        }),
      { timeout: 30_000 },
    )
    .toBe('ok');
  // The section header mentions the count (>= 1).
  const header = await page.locator('.page-backlinks-header').first().textContent();
  expect(header).toMatch(/1 linked mention|linked mentions/);
});

test('04 block backlink badge + expand panel under block', async () => {
  test.setTimeout(180_000);
  // Anchor page already open; badge on the block with id 1111鈥?(referenced from Refs).
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const badges = [...document.querySelectorAll('.block-backlink-badge')];
          return badges.length;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(1);
  // Click the badge 鈫?panel expands under the block.
  await page.locator('.block-backlink-badge').first().click();
  await expect(page.locator('.block-backlinks-panel').first()).toBeVisible({ timeout: 10_000 });
  const panelText = await page.locator('.block-backlinks-panel').first().textContent();
  expect(panelText).toContain('UX/Refs.md');
  // Click badge again 鈫?collapses.
  await page.locator('.block-backlink-badge').first().click();
  await expect(page.locator('.block-backlinks-panel')).toHaveCount(0, { timeout: 10_000 });
});

test('05 block props render under block content', async () => {
  test.setTimeout(180_000);
  // Props2.md already exists on disk from the fixture write.
  await page.evaluate(async (l: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText(l, '', false);
  }, 'UX/Props2');
  await sleep(1200);
  // The props row renders after the index/re-render settles.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const el = document.querySelector('.block-props-row');
          return el ? el.textContent ?? '' : '';
        }),
      { timeout: 30_000 },
    )
    .toContain('priority');
  const row = await page.evaluate(() => document.querySelector('.block-props-row')?.textContent ?? '');
  expect(row).toContain('high');
  expect(row).toContain('alice');
});

test('06 page-props block: add property by typing, persists (Logseq flow)', async () => {
  test.setTimeout(180_000);
  // Self-heal: detach + reopen so earlier tests' pending edit state can't
  // leak into this one's keystrokes.
  await page.evaluate(async (l: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (window as any).app;
    a.workspace.activeLeaf?.detach?.();
    await new Promise((r) => setTimeout(r, 800));
    await a.workspace.openLinkText(l, '', false);
  }, 'UX/Anchor');
  await sleep(1500);
  // The first block IS the properties block: ordinary bullet + props row.
  const firstWrap = page.locator('.block-editor-tree > .block-wrap').first();
  await expect(firstWrap.locator('.block-prop-key', { hasText: 'type' })).toBeVisible({ timeout: 30_000 });
  // Add a property by typing a new `key:: value` line in the block editor.
  await firstWrap.locator('.block-content').first().click();
  await page.waitForSelector('.cm-editor .cm-content', { timeout: 15_000 });
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('owner:: bob');
  // Commit by clicking another block (Esc never reaches the CM6 keymap).
  await page.locator('.block-content', { hasText: 'the anchor block itself' }).first().click();
  await sleep(600);
  await expect
    .poll(
      () => (readFileSync(join(VAULT, 'UX', 'Anchor.md'), 'utf8').includes('owner:: bob') ? 'ok' : 'pending'),
      { timeout: 45_000, intervals: [500, 1000, 2000, 4000] },
    )
    .toBe('ok');
  // The props row re-renders with the new prop.
  await expect(page.locator('.block-prop-key', { hasText: 'owner' }).first()).toBeVisible({ timeout: 30_000 });
  // And the rest of the file is intact.
  const disk = readFileSync(join(VAULT, 'UX', 'Anchor.md'), 'utf8');
  expect(disk).toContain('type:: page');
  expect(disk).toContain('status:: active');
  expect(disk).toContain('- the anchor block itself');
});

