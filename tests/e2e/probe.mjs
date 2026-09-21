/**
 * Diagnostic probe: launch real Obsidian against the E2E vault and dump what
 * is actually on screen (modals, plugin state, workspace views) step by step.
 * Not a test — run directly:  node tests/e2e/probe.mjs
 */

import { _electron } from '@playwright/test';

const exe = process.env.OBSIDIAN_PATH ?? 'D:\\programs\\Obsidian\\Obsidian.exe';
console.log('launching', exe);
const app = await _electron.launch({ executablePath: exe });
const page = await app.firstWindow();
console.log('window obtained');
await page.waitForLoadState('domcontentloaded');
console.log('dom loaded');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(8000);

async function dump(label) {
  const info = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = window.app;
    const out = {};
    out.hasApp = !!a;
    if (a) {
      out.vaultName = a.vault?.getName?.() ?? null;
      out.vaultPath = a.vault?.adapter?.basePath ?? null;
      out.enabledPlugins = [...(a.plugins?.enabledPlugins ?? [])];
      out.pluginsLoaded = Object.keys(a.plugins?.plugins ?? {});
      out.workspaceViews = a.workspace?.getLeavesOfType?.('markdown')?.length ?? -1;
      out.blockEditorLeaves = a.workspace?.getLeavesOfType?.('logseq-block-editor')?.length ?? -1;
      try {
        out.commandsSample = Object.keys(a.commands.commands).filter((c) => c.startsWith('obsidian-logseq')).length;
      } catch { out.commandsSample = 'err'; }
    }
    const modals = [...document.querySelectorAll('.modal-container')].map((m) => m.textContent?.slice(0, 300));
    out.modals = modals;
    out.bodyClasses = document.body.className;
    out.buttons = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter(Boolean).slice(0, 20);
    out.blockEditorContainer = !!document.querySelector('.block-editor-container');
    return out;
  });
  console.log(`--- ${label} ---`);
  console.log(JSON.stringify(info, null, 2));
}

await dump('initial');

// Try clicking any trust-looking button.
const trustBtn = page.locator('button', { hasText: /trust/i }).first();
if (await trustBtn.isVisible().catch(() => false)) {
  console.log('trust dialog found, clicking');
  await trustBtn.click();
  await sleep(4000);
} else {
  console.log('no trust dialog visible');
}
await dump('after-trust');

// Try opening the fixture file.
try {
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window.app).workspace.openLinkText('E2E/Home', '', false);
  });
  console.log('openLinkText resolved');
} catch (e) {
  console.log('openLinkText FAILED:', String(e).slice(0, 200));
}
await sleep(5000);
await dump('after-open');

await app.close().catch(() => {});
console.log('probe done');
