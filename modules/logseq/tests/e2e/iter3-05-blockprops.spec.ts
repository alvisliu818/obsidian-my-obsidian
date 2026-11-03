/**
 * iter3-05: Logseq-style properties.
 * - Block props: `key:: value` lines appear in the editor, edits commit into
 *   the block's props (row + indented lines on disk), deleting the line
 *   removes the prop.
 * - Page props: a FIRST block holding only properties is promoted into the
 *   page-props header (file-top `key:: value` lines), Logseq md format.
 * Isolated instance.
 */

import { test, expect } from '@playwright/test';
import { launchObsidian, closeObsidian, openFile, sleep, VAULT, type Ctx } from './iter3-helpers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ctx: Ctx = { browser: null, page: null as unknown as Page };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  await launchObsidian(ctx, {
    'UX3/Props-Edit.md': '- existing block\n\tpriority:: high\n- second block',
    'UX3/Props-First.md': '- starter block',
  });
});

test.afterAll(async () => {
  await closeObsidian(ctx);
});

const propRow = (page: Page, key: string) =>
  page.locator('.block-prop-item', { has: page.locator(`.block-prop-key:text-is("${key}")`) });

test('05a editor shows prop lines; value edits commit', async () => {
  test.setTimeout(180_000);
  await openFile(ctx, 'UX3/Props-Edit');
  const first = ctx.page.locator('.block-content').first();
  await expect(propRow(ctx.page, 'priority')).toContainText('high', { timeout: 30_000 });
  // Click to edit: the doc must show the text AND the prop line below it.
  await first.click();
  await ctx.page.waitForSelector('.cm-editor .cm-content', { timeout: 15_000 });
  const lineTexts = await ctx.page.evaluate(() =>
    [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent),
  );
  expect(lineTexts).toEqual(['existing block', 'priority:: high']);
  // Change the value: End (end of the text line) → Shift+Enter (soft break)
  // → type a new `priority::` line (same key overrides the old value).
  // Commit by clicking the other block (a real blur; Esc never reaches the
  // CM6 keymap inside Obsidian's host DOM).
  await ctx.page.keyboard.press('End');
  await ctx.page.keyboard.press('Shift+Enter');
  await ctx.page.keyboard.type('priority:: low');
  await ctx.page.locator('.block-content').nth(1).click();
  await sleep(600);
  await expect(propRow(ctx.page, 'priority')).toContainText('low', { timeout: 15_000 });
  await expect
    .poll(() => (readFileSync(join(VAULT, 'UX3', 'Props-Edit.md'), 'utf8').includes('priority:: low') ? 'ok' : 'pending'), {
      timeout: 45_000,
    })
    .toBe('ok');
});

test('05b typing a new prop line adds a property; deleting removes it', async () => {
  test.setTimeout(180_000);
  const second = ctx.page.locator('.block-content').nth(1);
  await second.click();
  await ctx.page.waitForSelector('.cm-editor .cm-content', { timeout: 15_000 });
  await ctx.page.keyboard.press('End');
  await ctx.page.keyboard.press('Shift+Enter'); // soft line break inside the block
  await ctx.page.keyboard.type('status:: done');
  await ctx.page.locator('.block-content').first().click(); // blur = commit
  await sleep(600);
  await expect(propRow(ctx.page, 'status')).toContainText('done', { timeout: 15_000 });
  await expect
    .poll(
      () =>
        readFileSync(join(VAULT, 'UX3', 'Props-Edit.md'), 'utf8').split('\n').some((l) => l.trim() === 'status:: done')
          ? 'ok'
          : 'pending',
      { timeout: 45_000 },
    )
    .toBe('ok');
  // Delete the prop line again: prop disappears from row and disk.
  await second.click();
  await ctx.page.waitForSelector('.cm-editor .cm-content', { timeout: 15_000 });
  await ctx.page.keyboard.press('End');
  await ctx.page.keyboard.press('Home');
  await ctx.page.keyboard.press('Shift+End');
  await ctx.page.keyboard.press('Backspace');
  await ctx.page.keyboard.press('Backspace'); // the preceding newline too
  await ctx.page.locator('.block-content').first().click(); // blur = commit
  await sleep(600);
  await expect(ctx.page.locator('.block-prop-item', { hasText: 'status' })).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(
      () =>
        readFileSync(join(VAULT, 'UX3', 'Props-Edit.md'), 'utf8').includes('status:: done') ? 'pending' : 'ok',
      { timeout: 45_000 },
    )
    .toBe('ok');
});

test('05c first block with only properties is the page-properties block (ordinary item)', async () => {
  test.setTimeout(180_000);
  await openFile(ctx, 'UX3/Props-First');
  const first = ctx.page.locator('.block-content').first();
  await first.click();
  await ctx.page.waitForSelector('.cm-editor .cm-content', { timeout: 15_000 });
  await ctx.page.keyboard.press('Control+a');
  await ctx.page.keyboard.type('type:: book');
  await ctx.page.keyboard.press('Enter');
  // The FIRST block stays in the outline as an ordinary list item with empty
  // content, showing the property in its props row (Logseq parity).
  const firstWrap = ctx.page.locator('.block-editor-tree > .block-wrap').first();
  await expect(firstWrap.locator('.block-prop-key', { hasText: 'type' })).toBeVisible({ timeout: 20_000 });
  await expect(firstWrap.locator('.block-prop-value', { hasText: 'book' })).toBeVisible();
  await expect(firstWrap.locator('.block-main > .block-controls .block-bullet')).toBeVisible();
  // The file uses Logseq md page-props format (unindented top lines).
  await expect
    .poll(() => (readFileSync(join(VAULT, 'UX3', 'Props-First.md'), 'utf8').trimStart().startsWith('type:: book') ? 'ok' : 'pending'), {
      timeout: 45_000,
    })
    .toBe('ok');
});

test('05d Escape reliably commits the props edit', async () => {
  test.setTimeout(180_000);
  await openFile(ctx, 'UX3/Props-First');
  const first = ctx.page.locator('.block-content').first();
  await first.click();
  await ctx.page.waitForSelector('.cm-editor .cm-content', { timeout: 15_000 });
  await ctx.page.keyboard.press('Control+End');
  await ctx.page.keyboard.press('Shift+Enter');
  await ctx.page.keyboard.type('owner:: bob');
  await ctx.page.keyboard.press('Escape');
  await sleep(800);
  await ctx.page.screenshot({ path: 'test-results/05d-escape.png' });
  // Esc MUST land the edit (previously it was swallowed by Obsidian's host
  // DOM and the edit silently never committed).
  await expect
    .poll(
      async () =>
        await ctx.page.evaluate(() => {
          const cm = document.querySelector('.cm-content');
          const cmPath = cm ? (() => { let el = cm, p = []; for (let i = 0; i < 6 && el; i++) { p.push(el.tagName + '.' + String(el.className).split(' ')[0]); el = el.parentElement; } return p.join(' > '); })() : null;
          const firstWrap = document.querySelector('.block-editor-tree > .block-wrap');
          const row = firstWrap?.querySelector(':scope > .block-props-row');
          return {
            keys: row ? [...row.querySelectorAll('.block-prop-key')].map((k) => k.textContent).join(',') : '',
            wraps: document.querySelectorAll('.block-editor-tree > .block-wrap').length,
            editing: !!document.querySelector('.cm-content'),
            editorLines: [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent),
            focused: !!document.activeElement?.classList?.contains('cm-content') || !!document.activeElement?.closest?.('.cm-content'),
            escCount: (window as any).__escCount ?? 0,
            cmPath,
            completion: null as string | null,
            escCount: (window as any).__escCount ?? 0,
            escError: (window as any).__escError ?? null,
            commitCount: (window as any).__commitCount ?? 0,
            commitInfo: (window as any).__commitInfo ?? null,
          };
        }),
      { timeout: 15_000, intervals: [500, 1000, 2000] },
    )
    .toMatch(/owner/);
  await expect
    .poll(() => (readFileSync(join(VAULT, 'UX3', 'Props-First.md'), 'utf8').includes('owner:: bob') ? 'ok' : 'pending'), {
      timeout: 45_000,
    })
    .toBe('ok');
});
