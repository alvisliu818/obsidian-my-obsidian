/**
 * iter3-03: ![[Target]] page-embed renders the source page; the add-block
 * input row is GONE (removed in this iteration — embeds are read/edited in
 * place via their rows, not through an append form). Isolated instance.
 */

import { test, expect } from '@playwright/test';
import { launchObsidian, closeObsidian, openFile, type Ctx } from './iter3-helpers';

const ctx: Ctx = { browser: null, page: null as unknown as Page };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  await launchObsidian(ctx, {
    'UX3/Target.md': '- target page block A\n- target page block B',
    'UX3/Host-Embed.md': '- host root\n![[Target]]\n- after the embed',
  });
});

test.afterAll(async () => {
  await closeObsidian(ctx);
});

test('03 ![[Target]] embeds the page; no add-block input row', async () => {
  test.setTimeout(180_000);
  await openFile(ctx, 'UX3/Host-Embed');
  // The page-embed box renders both target blocks.
  await expect(ctx.page.locator('.block-page-embed').first()).toBeVisible({ timeout: 45_000 });
  await expect(ctx.page.locator('.block-page-embed .embed-row', { hasText: 'target page block A' })).toBeVisible({ timeout: 30_000 });
  await expect(ctx.page.locator('.block-page-embed .embed-row', { hasText: 'target page block B' })).toBeVisible();
  // The add-block input row must not exist anywhere in the embed.
  await expect(ctx.page.locator('.page-embed-add')).toHaveCount(0);
  await expect(ctx.page.locator('.page-embed-add-input')).toHaveCount(0);
});
