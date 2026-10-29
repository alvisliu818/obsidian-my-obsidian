/**
 * Edge-vault E2E — CDP mode (see acceptance.spec.ts for why).
 *
 * Opens EVERY hostile sample file in the real Obsidian block editor and
 * asserts the app never crashes and never throws an uncaught exception.
 *
 * Env: OBSIDIAN_PATH = Obsidian.exe. The plugin build is copied into the
 * edge vault before launch; vault is pre-selected via use-vault.mjs.
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VAULT = join(REPO, 'tests', 'fixtures', 'edge-vault');
const CDP_PORT = process.env.OBSIDIAN_CDP_PORT ?? '9223';
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let browser: Browser | null = null;
let page: Page;
const pageErrors: string[] = [];

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
  throw new Error(`CDP endpoint ${CDP} did not come up`);
}

async function findObsidianPage(b: Browser): Promise<Page> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const ctx of b.contexts()) {
      for (const p of ctx.pages()) {
        const url = p.url();
        if (url.startsWith('app://') || url.includes('obsidian') || url.startsWith('file:')) return p;
      }
    }
    await sleep(500);
  }
  throw new Error('Obsidian main window not found over CDP');
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  const exe = process.env.OBSIDIAN_PATH;
  test.skip(!exe || !existsSync(VAULT), 'OBSIDIAN_PATH not set or edge vault missing');
  const plugDir = join(VAULT, '.obsidian', 'plugins', 'obsidian-logseq');
  copyFileSync(join(REPO, 'main.js'), join(plugDir, 'main.js'));
  copyFileSync(join(REPO, 'manifest.json'), join(plugDir, 'manifest.json'));
  copyFileSync(join(REPO, 'styles.css'), join(plugDir, 'styles.css'));

  try {
    execSync('taskkill /IM Obsidian.exe /F /T', { stdio: 'ignore' });
  } catch {
    /* none running */
  }
  await sleep(2000);
  spawn(exe!, ['--remote-debugging-port=' + CDP_PORT], { detached: true, stdio: 'ignore' }).unref();
  await waitForCdp(90_000);
  await sleep(3000);
  browser = await chromium.connectOverCDP(CDP);
  page = await findObsidianPage(browser);
  await page.waitForLoadState('domcontentloaded');
  try {
    await page
      .locator('button', { hasText: /trust|信任/i })
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
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (window as any).app;
    if (!a) return;
    const enabled =
      a.plugins.enabledPlugins?.has?.('obsidian-logseq') ?? !!a.plugins.plugins['obsidian-logseq'];
    if (!enabled) {
      if (a.plugins.enablePluginAndSave) await a.plugins.enablePluginAndSave('obsidian-logseq');
      else await a.plugins.enablePlugin('obsidian-logseq');
    }
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page.on('pageerror', (e) => pageErrors.push(String(e)));
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
    /* already gone */
  }
});

const samples = existsSync(VAULT) ? readdirSync(VAULT).filter((f) => f.endsWith('.md')) : [];

for (const sample of samples) {
  test(`opens without crashing: ${sample}`, async () => {
    test.setTimeout(120_000);
    const link = sample.replace(/\.md$/, '');
    await page.evaluate(async (l: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).app.workspace.openLinkText(l, '', false);
    }, link);
    await expect(page.locator('.block-editor-container').first()).toBeVisible({ timeout: 60_000 });
    const responsive = await page.evaluate(() => !!document.body);
    expect(responsive).toBe(true);
  });
}

test.afterEach(() => {
  // Uncaught exceptions are fatal for the production-readiness bar.
  expect(pageErrors).toEqual([]);
});
