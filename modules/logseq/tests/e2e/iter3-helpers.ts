/**
 * Shared helpers for iter3 spec files: launch Obsidian over CDP, open a file,
 * wait for rendered state. Each spec file launches its OWN Obsidian instance
 * (per-test isolation avoids the shared-instance render race). The instance
 * uses a DEDICATED user-data-dir whose registry only knows the test vault —
 * the user's main-vault instance (no CDP port) is never touched.
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawn } from 'node:child_process';

export const CDP_PORT = '9259';
export const CDP = `http://127.0.0.1:${CDP_PORT}`;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const VAULT = 'E:\\HOME\\Local\\logseq-e2e-vault';
export const TEST_VAULT_URI = 'obsidian://open?path=' + encodeURI(VAULT);
/** Dedicated profile dir — a separate Electron singleton from the main vault. */
export const TEST_PROFILE = 'E:\\HOME\\Local\\logseq-e2e-obsidian-profile';

/**
 * Kill ONLY the Obsidian instances the test harness spawned (they carry our
 * CDP debug port). The user's main-vault instance must stay untouched.
 */
function killTestVaultObsidian(): void {
  const ps =
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ' +
    "Where-Object { $_.Name -eq 'Obsidian.exe' -and $_.CommandLine -match 'remote-debugging-port=92' } " +
    '| ForEach-Object { $_.ProcessId }"';
  let pids: string[] = [];
  try {
    pids = execSync(ps, { stdio: 'pipe', timeout: 30_000 })
      .toString()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l));
  } catch {
    /* none running */
  }
  for (const pid of pids) {
    try {
      execSync('taskkill /PID ' + pid + ' /T /F', { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
}

export interface Ctx {
  browser: Browser | null;
  page: Page;
}

export async function launchObsidian(ctx: Ctx, fixtures: Record<string, string>): Promise<void> {
  killTestVaultObsidian();
  await sleep(2000);
  for (const [rel, content] of Object.entries(fixtures)) {
    writeFileSync(join(VAULT, rel), content);
  }
  // Pin the take-over settings: the vault is shared with manual testing, and
  // a hand-tuned scope (folders / exclusions) would silently un-take-over the
  // fixture folders and fail every suite at the openFile step.
  writeFileSync(
    join(VAULT, '.obsidian', 'plugins', 'obsidian-logseq', 'data.json'),
    JSON.stringify(
      {
        excludedFolders: '',
        saveDebounceMs: 800,
        takeOverByDefault: true,
        scopeMode: 'all',
        includedFolders: '',
        journalFolder: '',
        journalFormat: '',
        journalTemplate: '',
        customTemplateVars: '',
        backupsEnabled: true,
        opLogEnabled: true,
      },
      null,
      2,
    ),
  );
  // Dedicated user-data-dir: Obsidian is single-instance per profile, so the
  // test instance can never interact with (or forward into) the user's main
  // vault instance. The profile's registry opens the test vault directly.
  mkdirSync(TEST_PROFILE, { recursive: true });
  writeFileSync(
    join(TEST_PROFILE, 'obsidian.json'),
    JSON.stringify({ vaults: { e2e0000000000000: { path: VAULT, ts: Date.now(), open: true } } }),
  );
  spawn(
    process.env.OBSIDIAN_PATH!,
    ['--user-data-dir=' + TEST_PROFILE, '--remote-debugging-port=' + CDP_PORT, TEST_VAULT_URI],
    {
      detached: true,
      stdio: 'ignore',
    },
  ).unref();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${CDP}/json/version`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  await sleep(3000);
  ctx.browser = await chromium.connectOverCDP(CDP);
  let page: Page | null = null;
  for (const c of ctx.browser.contexts()) {
    for (const p of c.pages()) {
      if (p.url().startsWith('app://') || p.url().includes('obsidian')) page = p;
    }
  }
  if (!page) throw new Error('Obsidian page not found');
  ctx.page = page;
  await page.waitForLoadState('domcontentloaded');
  await page.bringToFront();
  // Guard: the harness must act on the TEST vault only — the user's main
  // vault may be running in another instance right now.
  let onTestVault = false;
  for (let w = 0; w < 30; w++) {
    const base = await page
      .evaluate(() => (window as unknown as { app?: { vault?: { adapter?: { basePath?: string } } } }).app?.vault?.adapter?.basePath)
      .catch(() => null);
    if (base && /logseq-e2e-vault/i.test(base)) {
      onTestVault = true;
      break;
    }
    await sleep(500);
  }
  if (!onTestVault) throw new Error('Connected Obsidian is NOT the test vault — aborting');
  // Trust dialog (click trust — Escape means safe mode = plugin disabled).
  for (let k = 0; k < 10; k++) {
    const modal = await page.locator('.modal-container.mod-dim').first().isVisible().catch(() => false);
    if (!modal) break;
    const t = page.locator('button', { hasText: /trust|信任|启用/i }).first();
    if (await t.isVisible().catch(() => false)) {
      await t.click({ timeout: 3000 });
      await sleep(1500);
    } else {
      await page.keyboard.press('Escape');
      await sleep(500);
    }
  }
  for (let i = 0; i < 3; i++) {
    try {
      await page.keyboard.press('Escape');
      await sleep(300);
    } catch {
      /* ignore */
    }
  }
}

export async function closeObsidian(ctx: Ctx): Promise<void> {
  try {
    ctx.browser?.close();
  } catch {
    /* ignore */
  }
  killTestVaultObsidian();
}

/** Open a file and wait for the block editor container + dismiss any modal. */
export async function openFile(ctx: Ctx, link: string): Promise<void> {
  const { page } = ctx;
  await page.evaluate(async (l: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText(l, '', false);
  }, link);
  await expect(page.locator('.block-editor-container').first()).toBeVisible({ timeout: 60_000 });
  await page.bringToFront();
  await dismissModals(page);
}

async function dismissModals(page: Page): Promise<void> {
  for (let k = 0; k < 10; k++) {
    const modal = await page.locator('.modal-container.mod-dim').first().isVisible().catch(() => false);
    if (!modal) return;
    const t = page.locator('button', { hasText: /trust|信任|启用/i }).first();
    if (await t.isVisible().catch(() => false)) {
      await t.click({ timeout: 3000 });
      await sleep(1500);
    } else {
      await page.keyboard.press('Escape');
      await sleep(500);
    }
  }
}

/** Wait until a block containing `text` is rendered in the outline. */
export async function waitForBlockText(ctx: Ctx, text: string): Promise<void> {
  await expect
    .poll(
      () =>
        ctx.page.evaluate((t: string) =>
          [...document.querySelectorAll('.block-content')].some((b) => b.textContent?.includes(t))
            ? 'ok'
            : 'pending',
        text),
      { timeout: 30_000 },
    )
    .toBe('ok');
}
