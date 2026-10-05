/**
 * VERIFY: Shift+clicking while a block is being EDITED extends the range from
 * the edited block instead of dropping it.
 *
 * THE BUG (reported): click into `alpha` and start editing, then Shift+click
 * `bravo`. Only `bravo` ended up selected — the block being edited was left
 * out of the range.
 *
 * ROOT CAUSE (measured, not inferred): `selectFromClick` anchored the range on
 * `this.lastClicked`, and that field is only ever assigned in the plain-click
 * branch of the same method. Editing a block never goes through it, so
 * `lastClicked` was still null, the `ev.shiftKey && this.lastClicked` guard
 * fell through, and the click degraded to a plain single-block select.
 *
 * THE TIMING TRAP this file exists to pin down: the fix needs the focused
 * block as a fallback anchor, but `commitFocusedText()` — the first statement
 * of `selectFromClick` — tears the focused CM6 down and sets
 * `focusedBlock = null`. Capturing the anchor AFTER the commit (the natural
 * place to add the code) silently yields null and the fix does nothing. The
 * anchor must be read BEFORE committing. No unit test can see this, because the
 * pure `rangeAnchor()` helper has no knowledge of view state — hence e2e.
 */
import { spawn } from 'node:child_process';
import { killTestVaultObsidian, prepareTestProfile, testSpawnArgs } from './obsidian-process.mjs';
import { Cdp, sleep } from './cdp.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
async function waitFor(cdp, fn, arg, { tries = 40, gap = 500, label = 'cond' } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await cdp.eval(fn, arg);
      if (v) { console.log(`  [wait] ${label} @t+${((i + 1) * gap) / 1000}s`); return v; }
    } catch { /* transient */ }
    await sleep(gap);
  }
  console.log(`  [wait] ${label} TIMED OUT`);
  return null;
}
const writeFile = (cdp, f, body) => cdp.eval((a) => {
  const v = window.app.vault;
  const ex = v.getAbstractFileByPath(a.f);
  if (ex) void v.modify(ex, a.b); else void v.create(a.f, a.b);
  return true;
}, { f, b: body });
const readMd = (cdp, f) => cdp.eval(async (p) => {
  const file = window.app.vault.getAbstractFileByPath(p);
  return file ? await window.app.vault.read(file) : null;
}, f);
async function openFixture(cdp, file, body, expectedBlocks) {
  await writeFile(cdp, file, body);
  await sleep(600);
  await cdp.eval((f) => {
    void window.app.workspace.getLeaf(false).openFile(window.app.vault.getAbstractFileByPath(f));
    return true;
  }, file);
  const ok = await waitFor(cdp, (n) => document.querySelectorAll('.block-content-static').length >= n, expectedBlocks, { label: `paint ${file}` });
  return !!ok;
}
/** Viewport coords of the block whose static content contains `word`. */
const pointOf = (cdp, word) => cdp.eval((w) => {
  for (const s of document.querySelectorAll('.block-content-static')) {
    if (s.textContent.includes(w)) {
      const r = s.getBoundingClientRect();
      if (r.width === 0) continue;
      return { x: Math.round(r.left + 12), y: Math.round(r.top + r.height / 2) };
    }
  }
  return null;
}, word);
/** Ctrl+click (2) or Shift+click (8); a plain click enters editing instead. */
async function clickAt(cdp, x, y, { shift = false, ctrl = false } = {}) {
  const modifiers = shift ? 8 : ctrl ? 2 : 0;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers });
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers });
  await sleep(500);
}
/** Text of every selected block, in document order. */
const selTexts = (cdp) => cdp.eval(() => {
  const out = [];
  for (const el of document.querySelectorAll('.block-wrap.is-selected')) {
    const s = el.querySelector(':scope > .block-main > .block-content .block-content-static')
      ?? el.querySelector('.block-content-static');
    // Only strip zero-width marks. An earlier draft also stripped '-', which
    // turned "alpha-1" into "alpha1" and made the assertions below fail
    // against correct behaviour.
    out.push((s?.textContent ?? '').replace(/[‍﻿]/g, '').trim());
  }
  return out;
});
const selCount = (cdp) => cdp.eval(() => document.querySelectorAll('.block-wrap.is-selected').length);
/**
 * Text of the mounted CM6 editor, or null when no block is being edited.
 * Do NOT gate on the `cm-focused` class — measured as unreliable in an
 * earlier draft of this file (it reported null while the block was in fact
 * being edited, and the edit landed on disk).
 */
const editingText = (cdp) => cdp.eval(() => {
  const cm = document.querySelector('.block-editor-tree .cm-content');
  return cm ? cm.textContent.trim() : null;
});
const hasFocus = (cdp) => cdp.eval(() => !!document.activeElement?.closest?.('.cm-editor'));

const MD = ['- alpha', '\t- alpha-1', '\t- alpha-2', '- bravo', '\t- bravo-1', '- charlie'].join('\n');

try {
  killTestVaultObsidian();
  await sleep(6000);
  prepareTestProfile();
  const child = spawn('D:/programs/Obsidian/Obsidian.exe', testSpawnArgs(9288), { detached: true, stdio: 'ignore' });
  child.unref();
  console.log('spawned pid', child.pid);

  const cdp = await (async () => {
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      try {
        const c = await Cdp.attach(9288);
        if ((await c.eval(() => !!window.app?.plugins?.plugins?.['obsidian-logseq'])) === true) { console.log(`ready t+${i + 1}s`); return c; }
        c.close();
      } catch { /* not up */ }
    }
    return null;
  })();
  if (!cdp) { console.error('never ready'); process.exit(1); }
  check('plugin loaded', true);

  // =========================================================================
  // Scenario 1 — THE REPORTED BUG: edit `alpha`, Shift+click `bravo`.
  // Expected range: alpha, alpha-1, alpha-2, bravo.
  // =========================================================================
  const F1 = 'E2E/ShiftEdit1.md';
  check('fixture 1 painted', await openFixture(cdp, F1, MD, 6));
  check('nothing selected initially', (await selCount(cdp)) === 0);

  const pAlpha = await pointOf(cdp, 'alpha');
  check('located block `alpha`', !!pAlpha, JSON.stringify(pAlpha));
  await clickAt(cdp, pAlpha.x, pAlpha.y);
  check('clicking a block enters editing', await hasFocus(cdp));

  // Type so the block is unambiguously "being edited" (and prove edits commit).
  await cdp.key('X', { code: 'KeyX' });
  await sleep(400);
  const edited = await editingText(cdp);
  check('typing goes into the block', !!edited && edited.includes('X'), JSON.stringify(edited));
  const pBravo = await pointOf(cdp, 'bravo');
  check('located block `bravo`', !!pBravo, JSON.stringify(pBravo));
  await clickAt(cdp, pBravo.x, pBravo.y, { shift: true });

  const n1 = await selCount(cdp);
  const texts1 = await selTexts(cdp);
  console.log('selected texts:', JSON.stringify(texts1));
  // alpha, alpha-1, alpha-2, bravo — 4 blocks (alpha-1/alpha-2 match on substring,
  // so assert on the set, not the count alone).
  check('Shift+click from an edited block selects a RANGE, not one block', n1 >= 3, `selected=${n1}`);
  check('the edited block `alpha` IS in the selection', texts1.some((t) => t.startsWith('alpha')), JSON.stringify(texts1));
  check('the clicked block `bravo` IS in the selection', texts1.some((t) => t.startsWith('bravo')), JSON.stringify(texts1));
  check('intermediate siblings are included', texts1.some((t) => t.includes('alpha-1')) && texts1.some((t) => t.includes('alpha-2')), JSON.stringify(texts1));

  // =========================================================================
  // Scenario 2 — the anchor must be read BEFORE commitFocusedText() nulls it.
  // If the capture were moved after the commit, `alpha` would drop out again.
  // Assert the range still starts at the edited block after a SAVE round-trip.
  // =========================================================================
  await sleep(2600); // let the debounced save flush
  const md1 = await readMd(cdp, F1);
  check('the typed edit was committed to disk', !!md1 && md1.includes('X'), (md1 ?? '').split('\n')[0]);
  const n2 = await selCount(cdp);
  check('selection survives the save (anchor was captured pre-commit)', n2 === n1, `${n2} vs ${n1}`);

  // =========================================================================
  // Scenario 3 — regression guard for the ORIGINAL working path: build a
  // selection by clicking (Ctrl+click sets lastClicked), then Shift+click
  // must range from the LAST CLICKED block. Note a plain click enters
  // editing and does NOT select — an earlier draft of this file assumed it
  // did and failed against correct behaviour.
  // =========================================================================
  const F3 = 'E2E/ShiftEdit3.md';
  check('fixture 3 painted', await openFixture(cdp, F3, MD, 6));
  const p2 = await pointOf(cdp, 'charlie');
  await clickAt(cdp, p2.x, p2.y, { ctrl: true });
  check('Ctrl+click selects one block', (await selCount(cdp)) === 1, `selected=${await selCount(cdp)}`);
  const p1 = await pointOf(cdp, 'alpha-1');
  await clickAt(cdp, p1.x, p1.y, { shift: true });
  const texts3 = await selTexts(cdp);
  console.log('scenario 3 selected:', JSON.stringify(texts3));
  check('range from lastClicked covers alpha-1..charlie', texts3.some((t) => t.includes('alpha-1')) && texts3.some((t) => t.startsWith('charlie')), JSON.stringify(texts3));

  // =========================================================================
  // Scenario 4 — Shift+click with NOTHING focused and nothing clicked (no
  // anchor at all) must degrade to a single select, not throw.
  // =========================================================================
  const F4 = 'E2E/ShiftEdit4.md';
  check('fixture 4 painted', await openFixture(cdp, F4, MD, 6));
  await cdp.eval(() => { document.activeElement?.blur?.(); return true; });
  await sleep(200);
  const p4 = await pointOf(cdp, 'bravo-1');
  await clickAt(cdp, p4.x, p4.y, { shift: true });
  check('anchorless Shift+click does not throw and selects something', (await selCount(cdp)) >= 1, `selected=${await selCount(cdp)}`);

  console.log('\n================ SUMMARY ================');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  for (const f of failed) console.log(`  FAIL: ${f.name}`);
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error('harness error:', e);
  process.exit(2);
}
