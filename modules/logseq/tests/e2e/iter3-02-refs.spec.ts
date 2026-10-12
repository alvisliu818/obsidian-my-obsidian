/**
 * iter3-02: bottom references (Linked/Unlinked) render under the outline and
 * each section collapses/expands via its header. Isolated instance.
 */

import { test, expect, type Page } from '@playwright/test';
import { launchObsidian, closeObsidian, openFile, sleep, type Ctx } from './iter3-helpers';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ctx: Ctx = { browser: null, page: null as unknown as Page };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  await launchObsidian(ctx, {
    'E2E/U0Target.md': '- the U0Target page content',
    'E2E/U1Source.md': '- talking about U0Target here\n- another block',
  });
});

test.afterAll(async () => {
  await closeObsidian(ctx);
});

test('02 bottom references collapse/expand via headers', async () => {
  test.setTimeout(180_000);
  await openFile(ctx, 'E2E/U0Target');
  await expect(ctx.page.locator('.page-references').first()).toBeVisible({ timeout: 30_000 });
  // The unlinked mentions render once the vault-wide index has rebuilt.
  await expect
    .poll(
      () =>
        ctx.page.evaluate(() =>
          document.querySelectorAll('.page-unlinked-item').length > 0 ? 'ok' : 'pending',
        ),
      { timeout: 60_000, intervals: [1000, 2000, 4000] },
    )
    .toBe('ok');
  // Collapse linked: body gets is-collapsed and becomes hidden.
  await ctx.page.locator('.page-references > .refs-collapse-header', { hasText: 'Linked references' }).first().click();
  const collapsedBody = ctx.page.locator('.refs-collapse-body.is-collapsed').first();
  await expect(collapsedBody).toHaveCount(1, { timeout: 10_000 });
  // Expand linked again.
  await ctx.page.locator('.page-references > .refs-collapse-header', { hasText: 'Linked references' }).first().click();
  await expect(ctx.page.locator('.refs-collapse-body.is-collapsed')).toHaveCount(0, { timeout: 10_000 });
  // Collapse unlinked the same way.
  await ctx.page.locator('.page-references > .refs-collapse-header', { hasText: 'Unlinked references' }).first().click();
  await expect(ctx.page.locator('.refs-collapse-body.is-collapsed').first()).toHaveCount(1, { timeout: 10_000 });
  // Expand unlinked.
  await ctx.page.locator('.page-references > .refs-collapse-header', { hasText: 'Unlinked references' }).first().click();
  await expect(ctx.page.locator('.refs-collapse-body.is-collapsed')).toHaveCount(0, { timeout: 10_000 });
});
