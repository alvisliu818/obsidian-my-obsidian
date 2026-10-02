/**
 * iter3-04: [[ renders as a clickable link chip, ![[ as a live page-embed
 * box — on the SAME line, without confusing each other. Isolated instance.
 */

import { test, expect } from '@playwright/test';
import { launchObsidian, closeObsidian, openFile, sleep, VAULT, type Ctx } from './iter3-helpers';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ctx: Ctx = { browser: null, page: null as unknown as Page };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  await launchObsidian(ctx, {
    'UX3/Target.md': '- target page block A\n- target page block B',
    'UX3/Syntax.md': '- a [[Target]] link and an ![[Target]] embed on one line',
    'UX3/CodeColumn.md': [
      '- parent',
      '\t- ```py',
      '\t\tx = 1',
      '\t\ty = 2',
      '\t\t```',
      '- parent2',
      '\t- ```py',
      '\t\t\tmodel = nn.Linear(1, 1)',
      '\t\t```',
      '',
    ].join('\n'),
  });
});

test.afterAll(async () => {
  await closeObsidian(ctx);
});

test('04 [[ and ![[ do not confuse each other', async () => {
  test.setTimeout(180_000);
  await openFile(ctx, 'UX3/Syntax');
  // RENDERED-STATE assertions (raw syntax is consumed by the renderer):
  // 1) the ![[Target]] becomes a live page-embed box —
  await expect(ctx.page.locator('.block-page-embed').first()).toBeVisible({ timeout: 45_000 });
  // 2) the [[Target]] becomes a clickable link chip —
  await expect(ctx.page.locator('a.internal-link, .block-ref', { hasText: 'Target' }).first()).toBeVisible({ timeout: 20_000 });
  // 3) both on the same line, disk unchanged (pure render enhancement).
  expect(readFileSync(join(VAULT, 'UX3', 'Syntax.md'), 'utf8')).toContain('a [[Target]] link and an ![[Target]] embed');
});

test('04b nested code fence body renders flush to the content column', async () => {
  test.setTimeout(180_000);
  await openFile(ctx, 'UX3/CodeColumn');
  // Logseq dedents fence body lines to the block's content column: a nested
  // `- ```py` block with body lines at marker-depth+1 renders FLUSH code, and
  // indentation beyond the column stays as the code's own indent.
  await expect(ctx.page.locator('.block-content-static pre').first()).toBeVisible({ timeout: 45_000 });
  const leading = await ctx.page.evaluate(() =>
    [...document.querySelectorAll('.block-content-static pre code')].map((c) =>
      (c.textContent ?? '').split('\n').map((t) => t.length - t.trimStart().length),
    ),
  );
  // block 1 (depth 1, body at depth 2 = column): every line flush.
  expect(leading[0]).toEqual([0, 0, 0]);
  // block 2 (depth 1, body at depth 3 = column + 1 tab): the extra unit
  // survives as the code line's own indent (one tab = 1 leading char).
  // Rendered code text has no language line; trailing '' after the last \n.
  expect(leading[1]).toEqual([1, 0]);
});
