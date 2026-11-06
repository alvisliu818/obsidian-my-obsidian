/**
 * UX round E2E: the four fixes/features from the user report.
 * Uses the exact interaction sequence validated step-by-step by
 * tests/e2e/probe-ux01b.mjs (click 鈫?CM6 mount 鈫?Tab 鈫?poll disk).
 *
 *   01 LAST-node indent: Tab on the final block of a page works, persists
 *   02 slash menu: typing "/" opens the menu, filter + execute persists
 *   03 angle menu: typing "<" opens the menu, pick <kbd> persists
 *   04 reading-mode typography: static render line-height == editor (1.55)
 *
 * Env: OBSIDIAN_PATH (VAULT is hard-wired to the dedicated test vault).
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawn } from 'node:child_process';

const CDP_PORT = '9232';
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
  writeFileSync(join(VAULT, 'UX', 'Indent.md'), '- first\n- middle\n- last-node');
  writeFileSync(join(VAULT, 'UX', 'Menus.md'), '- menu playground');
  writeFileSync(join(VAULT, 'UX', 'Reading.md'), '- A block with a paragraph\n\n- Another block');
  spawn(process.env.OBSIDIAN_PATH!, ['--remote-debugging-port=' + CDP_PORT], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  await waitForCdp(90_000);
  await sleep(3000);
  browser = await chromium.connectOverCDP(CDP);
  page = await findObsidianPage(browser);
  // Background windows throttle rAF, which stalls Playwright actionability
  // checks ('stable' never settles). Force the window active.
  await page.bringToFront();
  await page.evaluate(() => window.focus());
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

/** Open a file and wait for the editor; returns when container is visible. */
async function openFile(link: string): Promise<void> {
  await page.evaluate(async (l: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText(l, '', false);
  }, link);
  await expect(page.locator('.block-editor-container').first()).toBeVisible({ timeout: 60_000 });
  await sleep(600);
}

/** Click a block and wait for the CM6 editor to mount.
 * bringToFront keeps actionability checks responsive; dismissModals clears
 * any trust/notice dialog whose modal-bg would swallow the click.
 */
async function clickBlock(page: Page, text: string): Promise<void> {
  await page.bringToFront();
  await dismissModals(page);
  const loc = page.locator('.block-content', { hasText: text }).first();
  await loc.click({ timeout: 20_000 });
  await expect(page.locator('.block-content.is-editing .cm-content')).toBeVisible({ timeout: 20_000 });
}

/** Close any modal (trust dialog renders late on slow launches; its
 * modal-bg intercepts every pointer event). Trust button first — Escape
 * on the trust dialog means "safe mode", which would DISABLE the plugin. */
async function dismissModals(page: Page): Promise<void> {
  for (let i = 0; i < 10; i++) {
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

test('01 LAST node Tab-indent works and persists', async () => {
  test.setTimeout(180_000);
  await openFile('UX/Indent');
  // Click the LAST block and press Tab (the exact reported repro).
  await clickBlock(page, 'last-node');
  await expect(page.locator('.block-content.is-editing .cm-content')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Tab');
  // Do NOT Escape immediately: probe proved Tab 鈫?poll-disk works; Escape can
  // race the mutation's debounced save in suite context. Blur instead.
  await page.keyboard.press('Escape');
  // Disk proof: last-node becomes a child of middle.
  await expect
    .poll(
      () => {
        const onDisk = readFileSync(join(VAULT, 'UX', 'Indent.md'), 'utf8');
        return onDisk.includes('\t- last-node') ? 'saved' : onDisk;
      },
      { timeout: 45_000, intervals: [500, 1000, 2000, 4000] },
    )
    .toBe('saved');
  // Reload the file from disk and verify the hierarchy survives re-parse.
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (window as any).app;
    a.workspace.activeLeaf?.detach?.();
    await sleep(1500);
    await a.workspace.openLinkText('UX/Indent', '', false);
  });
  await sleep(1500);
  const indented = await page.evaluate(() => {
    // Match the wrap whose DIRECT content is 'last-node' — parent wraps'
    // textContent also contains descendant text.
    const wrap = [...document.querySelectorAll('.block-wrap')].find((w) => {
      const direct = w.querySelector(':scope > .block-main > .block-content');
      return direct?.textContent?.includes('last-node');
    });
    if (!wrap) return 'no-wrap';
    // Indented rows render inside .block-children (an ancestor container),
    // never as a direct child of the tree root.
    return wrap.closest('.block-children') ? 'indented' : 'top-level';
  });
  expect(indented).toBe('indented');
});

test('02 slash menu: open, filter, execute persists', async () => {
  test.setTimeout(180_000);
  await openFile('UX/Menus');
  await clickBlock(page, 'menu playground');
  await expect(page.locator('.block-content.is-editing .cm-content')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' /todo');
  // Self-drawn command menu appears with the TODO command.
  await expect(page.locator('.block-command-menu').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.bcm-item', { hasText: 'TODO' }).first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Enter'); // accept 鈫?sets marker
  await sleep(400);
  await page.keyboard.press('Escape');
  await expect
    .poll(
      () => (readFileSync(join(VAULT, 'UX', 'Menus.md'), 'utf8').match(/- TODO menu playground/) ? 'ok' : 'pending'),
      { timeout: 45_000, intervals: [500, 1000, 2000, 4000] },
    )
    .toBe('ok');
});

test('03 angle menu: "<" opens, pick snippet, persists', async () => {
  test.setTimeout(180_000);
  await openFile('UX/Menus');
  await clickBlock(page, 'menu playground');
  await expect(page.locator('.block-content.is-editing .cm-content')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' <kbd');
  await expect(page.locator('.block-command-menu').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.bcm-item', { hasText: 'kbd' }).first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Enter'); // accept 鈫?<kbd></kbd> with caret inside
  await page.keyboard.type('Ctrl+Enter');
  await sleep(300);
  await page.keyboard.press('Escape');
  await expect
    .poll(
      () => (readFileSync(join(VAULT, 'UX', 'Menus.md'), 'utf8').includes('<kbd>Ctrl+Enter</kbd>') ? 'ok' : 'pending'),
      { timeout: 45_000, intervals: [500, 1000, 2000, 4000] },
    )
    .toBe('ok');
  // A bare "<" in prose must NOT be rewritten: type "x < y" and confirm it stays.
  await clickBlock(page, 'menu playground');
  await expect(page.locator('.block-content.is-editing .cm-content')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nx < y');
  await sleep(300);
  await page.keyboard.press('Escape');
  await expect
    .poll(
      () => (readFileSync(join(VAULT, 'UX', 'Menus.md'), 'utf8').includes('x < y') ? 'ok' : 'pending'),
      { timeout: 45_000, intervals: [500, 1000, 2000, 4000] },
    )
    .toBe('ok');
});

test('04 reading-mode typography matches editor metrics', async () => {
  test.setTimeout(120_000);
  await openFile('UX/Reading');
  const editorMetrics = await page.evaluate(() => {
    const el = document.querySelector('.block-content-static p');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { lineHeight: cs.lineHeight, fontSize: cs.fontSize, marginTop: cs.marginTop, marginBottom: cs.marginBottom };
  });
  expect(editorMetrics).not.toBeNull();
  const fs = parseFloat(editorMetrics!.fontSize);
  const lh = parseFloat(editorMetrics!.lineHeight);
  // line-height must resolve to ~1.55 脳 font-size (卤5%).
  expect(Math.abs(lh / fs - 1.55)).toBeLessThan(0.08);
  // Paragraph margins must be zero (was the "too airy" complaint).
  expect(parseFloat(editorMetrics!.marginTop)).toBe(0);
  expect(parseFloat(editorMetrics!.marginBottom)).toBe(0);
});




