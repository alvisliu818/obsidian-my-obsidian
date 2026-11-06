/**
 * Acceptance E2E against a REAL Obsidian instance 鈥?CDP mode, single session.
 *
 * Obsidian 鈮?.13 runs on Electron 鈮?9 (Chromium 鈮?29), which removed the
 * pipeline Playwright's _electron.launch() depends on. Instead we launch
 * Obsidian with --remote-debugging-port and drive it through CDP.
 *
 * IMPORTANT: the fixture file is only rewritten while Obsidian is CLOSED
 * (beforeAll). Rewriting it while the block editor has the file open would
 * trip the plugin's external-change conflict modal (by design!).
 *
 * Tests run in order within one Obsidian session (workers=1) and build on
 * each other: commands 鈫?log modal 鈫?settings 鈫?write+backup 鈫?log trail 鈫? * restore 鈫?reopen idempotency 鈫?hard-kill recovery.
 *
 * Env: OBSIDIAN_PATH = Obsidian.exe, OBSIDIAN_VAULT = clean test vault with
 * the plugin installed & enabled and an E2E/Home.md file.
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const HOME = 'E2E/Home';
/** Dedicated throwaway test vault — hard-wired so Playwright worker
 * processes don't depend on env-var propagation through npx → worker. */
const VAULT = 'E:\\HOME\\Local\\logseq-e2e-vault';
const HOME_PATH = () => join(VAULT, 'E2E', 'Home.md');
const CDP_PORT = process.env.OBSIDIAN_CDP_PORT ?? '9222';
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let browser: Browser | null = null;
let page: Page;
let obsidianPids: number[] = [];

function currentPids(): number[] {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-Process Obsidian -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join \',\'"',
    )
      .toString()
      .trim();
    return out ? out.split(',').map(Number) : [];
  } catch {
    return [];
  }
}

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
  // Fixture reset happens while Obsidian is closed 鈥?never mid-session.
  try {
    execSync('taskkill /IM Obsidian.exe /F /T', { stdio: 'ignore' });
  } catch {
    /* none running */
  }
  await sleep(2000);
  // ALWAYS deploy the current build into the vault 鈥?a stale main.js here
  // makes the whole suite validate yesterday's bugs.
  const plugDir = join(VAULT, '.obsidian', 'plugins', 'obsidian-logseq');
  mkdirSync(plugDir, { recursive: true });
  copyFileSync(join(REPO, 'main.js'), join(plugDir, 'main.js'));
  copyFileSync(join(REPO, 'manifest.json'), join(plugDir, 'manifest.json'));
  copyFileSync(join(REPO, 'styles.css'), join(plugDir, 'styles.css'));
  // Deterministic state: wipe plugin test data (backups/log) from earlier runs.
  const plugData = join(VAULT, '.logseq-editor');
  if (existsSync(plugData)) rmSync(plugData, { recursive: true, force: true });
  writeFileSync(HOME_PATH(), '- alpha\n');
  spawn(process.env.OBSIDIAN_PATH!, ['--remote-debugging-port=' + CDP_PORT], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  await waitForCdp(90_000);
  await sleep(3000);
  obsidianPids = currentPids();
  browser = await chromium.connectOverCDP(CDP);
  page = await findObsidianPage(browser);
  await page.waitForLoadState('domcontentloaded');
  // Community-plugin trust dialog (button text may be localized 鈥?Chinese
  // vaults show "淇′换浠撳簱浣滆€呭苟鍚敤鎻掍欢").
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
  await page.evaluate(async (link: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText(link, '', false);
  }, HOME);
  await expect(page.locator('.block-editor-container').first()).toBeVisible({ timeout: 60_000 });
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

async function editFirstBlock(text: string): Promise<void> {
  const block = page.locator('.block-content', { hasText: 'alpha' }).first();
  await block.click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
}

test('01 plugin registers its commands (palette-reachable)', async () => {
  const ids = await page.evaluate(() =>
    Object.keys(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((window as any).app.commands.commands as Record<string, unknown>),
    ).filter((id) => id.startsWith('obsidian-logseq:')),
  );
  expect(ids).toContain('obsidian-logseq:show-operation-log');
  expect(ids).toContain('obsidian-logseq:restore-backup');
  expect(ids).toContain('obsidian-logseq:open-with-native-editor');
});

test('02 operation log modal opens from the command', async () => {
  const ok = await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.commands.executeCommandById('obsidian-logseq:show-operation-log'),
  );
  expect(ok).toBeTruthy();
  await expect(page.locator('.modal .oplog-list')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('03 settings persist across plugin disable/enable', async () => {
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (window as any).app.plugins.plugins['obsidian-logseq'];
    p.settings.journalFolder = 'journals-e2e';
    await p.saveSettings();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.plugins.disablePlugin('obsidian-logseq');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.plugins.enablePlugin('obsidian-logseq');
  });
  const folder = await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.plugins.plugins['obsidian-logseq'].settings.journalFolder,
  );
  expect(folder).toBe('journals-e2e');
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (window as any).app.plugins.plugins['obsidian-logseq'];
    p.settings.journalFolder = '';
    await p.saveSettings();
  });
  await page.evaluate(async (link: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).app.workspace.openLinkText(link, '', false);
  }, HOME);
  await expect(page.locator('.block-editor-container').first()).toBeVisible({ timeout: 60_000 });
});

test('04 first write creates an automatic backup of the original', async () => {
  await editFirstBlock(' beta');
  await page.waitForTimeout(3000);
  const backups = await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.vault.adapter.list('.logseq-editor/backups'),
  );
  const names: string[] = backups.files ?? [];
  expect(names.some((n) => n.includes('E2E--Home.md-'))).toBe(true);
  // Serializer emits no trailing newline (canonical Logseq-editor output).
  expect(readFileSync(HOME_PATH(), 'utf8')).toBe('- alpha beta');
});

test('05 operation log records edits and backups', async () => {
  await page.waitForTimeout(2500);
  const log = await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.vault.adapter.read('.logseq-editor/log.jsonl'),
  );
  expect(log).toContain('"op":"blocks.edit"');
  expect(log).toContain('"op":"backup.create"');
  expect(log).toContain('"file":"E2E/Home.md"');
});

test('06 backup restore modal returns the original content', async () => {
  await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.commands.executeCommandById('obsidian-logseq:restore-backup'),
  );
  await expect(page.locator('.modal .backup-row').first()).toBeVisible();
  await page.locator('.modal .backup-row button', { hasText: 'Restore' }).first().click();
  await page.waitForTimeout(2500);
  // The view may re-save the adopted state in the serializer-canonical form
  // (no trailing newline) 鈥?content-wise both are the restored original.
  expect(readFileSync(HOME_PATH(), 'utf8')).toMatch(/^- alpha\n?$/);
  const backups = await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).app.vault.adapter.list('.logseq-editor/backups'),
  );
  expect((backups.files ?? []).length).toBeGreaterThanOrEqual(2); // pre-edit + pre-restore
});

test('07 file re-open re-parses identically (no duplication)', async () => {
  test.setTimeout(150_000);
  await editFirstBlock(' beta');
  await page.waitForTimeout(3500);
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (window as any).app;
    a.workspace.activeLeaf?.detach?.();
    await sleep(1500);
    await a.workspace.openLinkText('E2E/Home', '', false);
  });
  await expect(page.locator('.block-editor-container').first()).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('.block-wrap', { hasText: 'alpha beta' })).toHaveCount(1, { timeout: 30_000 });
  expect(readFileSync(HOME_PATH(), 'utf8')).toMatch(/^- alpha beta\n?$/);
});

test('08 hard kill mid-debounce leaves the file intact and restorable', async () => {
  test.setTimeout(90_000);
  await editFirstBlock(' gamma');
  // Let the session backup land, but NOT the debounced save (800 ms).
  await page.waitForTimeout(400);
  for (const pid of obsidianPids) {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
  obsidianPids = [];
  browser = null;
  // The on-disk file must be one of the last fully-written versions 鈥?never
  // garbage (serializer may or may not keep the fixture's trailing newline).
  const onDisk = readFileSync(HOME_PATH(), 'utf8');
  expect(/^(- alpha( beta)?( gamma)?)\n?$/.test(onDisk)).toBe(true);
  // A pre-edit backup must exist 鈫?recovery possible.
  const backups = readdirSync(join(VAULT, '.logseq-editor', 'backups'));
  expect(backups.some((n) => n.startsWith('E2E--Home.md-'))).toBe(true);
});

