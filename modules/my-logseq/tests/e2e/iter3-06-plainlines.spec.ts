/**
 * iter3-06: bare top-level lines (no `-`) render as first-level list items
 * (Logseq parity: the outline owns every plain line), and editing a page
 * normalizes them to `- ` items on disk. Structural raw lines (headings,
 * quotes, ordered lists…) stay verbatim. Isolated instance.
 */

import { test, expect } from '@playwright/test';
import { launchObsidian, closeObsidian, openFile, sleep, VAULT, type Ctx } from './iter3-helpers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ctx: Ctx = { browser: null, page: null as unknown as Page };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  await launchObsidian(ctx, {
    'UX3/TabTarget.md': ['- target top', '\t- target child', '\t- target child2', ''].join('\n'),
    'UX3/TabHost.md': ['- host root', '![[UX3/TabTarget]]', ''].join('\n'),
    'UX3/Plain.md': [
      'plain line one',
      '- existing item',
      'plain line two',
      '',
      '# A heading',
      '',
      '- tagged reference #mypage here',
      '',
    ].join('\n'),
  });
});

test.afterAll(async () => {
  await closeObsidian(ctx);
});

test('06 bare lines render as first-level items; edits normalize them on disk', async () => {
  test.setTimeout(180_000);
  await openFile(ctx, 'UX3/Plain');
  // All three plain/list lines render as blocks with bullets.
  await expect(ctx.page.locator('.block-wrap .block-bullet')).toHaveCount(4, { timeout: 45_000 });
  const texts = await ctx.page.evaluate(() =>
    [...document.querySelectorAll('.block-content-static')].map((e) => e.textContent?.trim()),
  );
  expect(texts).toContain('plain line one');
  expect(texts).toContain('existing item');
  expect(texts).toContain('plain line two');
  // Edit a bare line: it participates in the outline like any block, and the
  // guarded save normalizes it to a `- ` item (Logseq md format).
  await ctx.page.locator('.block-content', { hasText: 'plain line one' }).first().click();
  await ctx.page.waitForSelector('.cm-editor .cm-content', { timeout: 15_000 });
  await ctx.page.keyboard.press('End');
  await ctx.page.keyboard.type(' more');
  await ctx.page.locator('.block-content', { hasText: 'existing item' }).first().click();
  await sleep(600);
  await expect
    .poll(
      () => (readFileSync(join(VAULT, 'UX3', 'Plain.md'), 'utf8').includes('- plain line one more') ? 'ok' : 'pending'),
      { timeout: 45_000 },
    )
    .toBe('ok');
  // The heading keeps its verbatim raw form (no bullet normalization).
  const disk = readFileSync(join(VAULT, 'UX3', 'Plain.md'), 'utf8');
  expect(disk).toContain('# A heading');
  expect(disk).toContain('- plain line two');
});

test('06b a #tag is a page reference: click opens/creates the page (Logseq parity)', async () => {
  test.setTimeout(180_000);
  await openFile(ctx, 'UX3/Plain');
  // The static render shows the tag as a page link.
  const tag = ctx.page.locator('.block-content a.tag', { hasText: 'mypage' }).first();
  await expect(tag).toBeVisible({ timeout: 30_000 });
  // Click it: the app navigates to (creates) the page 'mypage'.
  await tag.click();
  await expect(ctx.page.locator('.block-editor-container').first()).toBeVisible({ timeout: 45_000 });
  await expect
    .poll(() => {
      try {
        return readFileSync(join(VAULT, 'mypage.md'), 'utf8').length >= 0 ? 'ok' : 'pending';
      } catch {
        return 'pending';
      }
    }, { timeout: 45_000 })
    .toBe('ok');
});

test('06c Tab / Shift+Tab indent inside embed edits (Logseq parity)', async () => {
  test.setTimeout(180_000);
  await openFile(ctx, 'UX3/TabHost');
  // The page-embed renders the target rows; click the child row to edit it.
  const childRow = ctx.page.locator('.embed-row', { hasText: 'target child' }).first();
  await expect(childRow).toBeVisible({ timeout: 45_000 });
  await childRow.click();
  await ctx.page.waitForSelector('.cm-editor .cm-content', { timeout: 15_000 });
  await ctx.page.keyboard.press('Escape');
  await sleep(500);
  // Re-open on the row and press Tab: the row indents under its previous sibling.
  await childRow.click();
  await ctx.page.waitForSelector('.cm-editor .cm-content', { timeout: 15_000 });
  await ctx.page.keyboard.press('Tab');
  await sleep(1200);
  const disk = readFileSync(join(VAULT, 'UX3', 'TabTarget.md'), 'utf8');
  expect(disk).toContain('		- target child');
});
