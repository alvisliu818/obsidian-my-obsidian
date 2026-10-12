/**
 * iter3-01: page props render at the FIRST-BLOCK position (not page bottom).
 * Isolated Obsidian instance.
 */

import { test, expect } from '@playwright/test';
import { launchObsidian, closeObsidian, openFile, waitForBlockText, sleep, VAULT, type Ctx } from './iter3-helpers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ctx: Ctx = { browser: null, page: null as unknown as Page };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  await launchObsidian(ctx, {
    'UX3/Props-Page.md': 'type:: book\nstatus:: reading\n\n- first outline block\n- second block',
    'UX3/Target.md': '- target page block A\n- target page block B',
  });
});

test.afterAll(async () => {
  await closeObsidian(ctx);
});

test('01 page props render as the FIRST-BLOCK (ordinary list item) position, not page bottom', async () => {
  test.setTimeout(180_000);
  await openFile(ctx, 'UX3/Props-Page');
  await waitForBlockText(ctx, 'first outline block');
  await sleep(1500);
  const pos = await ctx.page.evaluate(() => {
    const tree = document.querySelector('.block-editor-tree');
    if (!tree) return null;
    // Logseq model: the properties are the FIRST block of the outline — an
    // ordinary block with empty content and its props row below it.
    const firstWrap = tree.querySelector(':scope > .block-wrap');
    const propsRow = firstWrap?.querySelector(':scope > .block-props-row') ?? null;
    const bullet = firstWrap?.querySelector(':scope > .block-main > .block-controls .block-bullet') ?? null;
    const keys = [...(propsRow?.querySelectorAll('.block-prop-key') ?? [])].map((k) => k.textContent);
    const secondWrap = firstWrap?.nextElementSibling?.classList.contains('block-wrap')
      ? (firstWrap.nextElementSibling as HTMLElement)
      : null;
    const bottomCard = document.querySelector('.block-editor-container > .page-props-card');
    return {
      propsRow: !!propsRow,
      bullet: !!bullet,
      keys,
      secondIsContent: !!secondWrap && (secondWrap.textContent ?? '').includes('first outline block'),
      bottomCard: !!bottomCard,
    };
  });
  expect(pos?.propsRow).toBe(true);
  expect(pos?.bullet).toBe(true);
  expect(pos?.keys).toEqual(['type', 'status']);
  expect(pos?.secondIsContent).toBe(true);
  expect(pos?.bottomCard).toBe(false);
  // Editable content persisted on disk.
  expect(readFileSync(join(VAULT, 'UX3', 'Props-Page.md'), 'utf8')).toContain('type:: book');
});
