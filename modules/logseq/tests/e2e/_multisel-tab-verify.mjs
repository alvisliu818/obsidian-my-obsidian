/**
 * VERIFY: Tab / Shift+Tab over a multi-selection indents / outdents the
 * whole selection (Logseq parity).
 *
 * Behavioural, not structural: keys are dispatched for real and the result is
 * read back off disk. `notes/testing.md` records why — "the hotkey is declared"
 * is never a valid assertion, and neither is "the handler is wired".
 *
 * TWO MEASURED FACTS the implementation rests on (both re-checked here rather
 * than assumed):
 *   1. After a Ctrl+click the focused CM6 is destroyed and focus falls to
 *      <body>, where a keydown NEVER reaches the view's container listener —
 *      so Tab was dead until the tree element was made focusable.
 *   2. `indentSelected` forces a full re-render, so focus must be re-asserted
 *      or only the FIRST Tab would take effect.
 *
 * SEMANTICS under test — deliberately per-block, identical to single-block Tab:
 * every selected block moves under ITS OWN previous sibling. A block that is
 * already the first child of its parent has no previous sibling, so it stays
 * put while the rest of the group moves. An earlier draft of this file
 * asserted "the whole group always moves one level" and failed against correct
 * code; the expectation was the bug, not the implementation.
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
const ctrlClick = async (cdp, x, y) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers: 2 });
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers: 2 });
  await sleep(500);
};
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
/** Open `body` as `file` and wait for the outline to paint. */
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
/** Ctrl+click every block whose text contains one of `words`. */
async function selectBlocks(cdp, words) {
  const pts = await cdp.eval((ws) => {
    const out = [];
    for (const s of document.querySelectorAll('.block-content-static')) {
      if (ws.some((w) => s.textContent.includes(w))) {
        const r = s.getBoundingClientRect();
        out.push({ x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2) });
      }
    }
    return out;
  }, words);
  for (const p of pts) await ctrlClick(cdp, p.x, p.y);
  return pts.length;
}
const selState = (cdp) => cdp.eval(() => ({
  selected: document.querySelectorAll('.block-wrap.is-selected').length,
  inTree: document.activeElement?.classList?.contains('block-editor-tree') ?? false,
}));
/** Indentation depth of the line mentioning `word` (a tab counts as one level). */
const depthOf = (md, word) => {
  const line = (md ?? '').split('\n').find((l) => l.includes(word));
  if (line === undefined) return null;
  const m = /^[\t ]*/.exec(line)[0];
  return m.includes('\t') ? m.split('\t').length - 1 : Math.floor(m.length / 2);
};
const settle = () => sleep(2600); // plugin save is debounced (~800ms) + async flush

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
  // Scenario 1 — the headline feature: two top-level siblings, Tab indents
  // BOTH under the preceding block; Shift+Tab puts both back.
  // =========================================================================
  const F1 = 'E2E/MultiSelTab1.md';
  check('fixture 1 painted', await openFixture(cdp, F1, ['- alpha', '- bravo', '- charlie'].join('\n'), 3));
  check('clicked both target blocks', (await selectBlocks(cdp, ['bravo', 'charlie'])) === 2);

  let st = await selState(cdp);
  check('two blocks selected', st.selected === 2, `selected=${st.selected}`);
  check('focus parked inside the editor (not <body>)', st.inTree, JSON.stringify(st));

  await cdp.key('Tab', { code: 'Tab' });
  await settle();
  const t1 = await readMd(cdp, F1);
  console.log('--- after Tab ---\n' + t1);
  check('Tab indented BOTH selected blocks', depthOf(t1, 'bravo') === 1 && depthOf(t1, 'charlie') === 1,
    `bravo=${depthOf(t1, 'bravo')} charlie=${depthOf(t1, 'charlie')}`);
  check('unselected block stayed at top level', depthOf(t1, 'alpha') === 0, `alpha=${depthOf(t1, 'alpha')}`);

  st = await selState(cdp);
  check('selection survives the re-render', st.selected === 2, `selected=${st.selected}`);
  check('focus survives the re-render (so a 2nd Tab can work)', st.inTree, JSON.stringify(st));

  // Per-block semantics: bravo is now alpha's FIRST child (no previous
  // sibling) so it cannot go deeper; charlie follows bravo down one level.
  await cdp.key('Tab', { code: 'Tab' });
  await settle();
  const t2 = await readMd(cdp, F1);
  console.log('--- after 2nd Tab ---\n' + t2);
  check('2nd Tab: head of the group stays (it has no previous sibling)',
    depthOf(t2, 'bravo') === 1, `bravo=${depthOf(t2, 'bravo')}`);
  check('2nd Tab: the rest of the group moves one more level',
    depthOf(t2, 'charlie') === 2, `charlie=${depthOf(t2, 'charlie')}`);

  // Outdent back out. NOTE the state after two Tabs: bravo is now charlie's
  // PARENT, and `topSelectedBlocks` drops members whose ancestor is already
  // selected (the same rule every bulk op follows — a selected child travels
  // inside its selected parent rather than being moved twice). So only bravo is
  // outdented and charlie rides along as its child; a second Shift+Tab is then a
  // no-op because bravo is already at the top level. Sibling outdents — the
  // case users actually hit — are covered by scenario 2.
  await cdp.key('Tab', { code: 'Tab', shift: true });
  await settle();
  const t3 = await readMd(cdp, F1);
  console.log('--- after Shift+Tab ---\n' + t3);
  check('Shift+Tab lifted the group head back to top level', depthOf(t3, 'bravo') === 0, `bravo=${depthOf(t3, 'bravo')}`);
  check('its selected child travelled inside it (not outdented twice)',
    depthOf(t3, 'charlie') === 1, `charlie=${depthOf(t3, 'charlie')}`);

  const t3b = await readMd(cdp, F1);
  await cdp.key('Tab', { code: 'Tab', shift: true });
  await settle();
  const t4 = await readMd(cdp, F1);
  check('Shift+Tab at the top level is a no-op (no crash, no drift)', t3b === t4,
    JSON.stringify({ t3b, t4 }));

  // =========================================================================
  // Scenario 2 — outdent a selection that sits UNDER a parent: both members
  // come out one level, in the right order.
  // =========================================================================
  const F2 = 'E2E/MultiSelTab2.md';
  check('fixture 2 painted', await openFixture(cdp, F2, ['- parent', '\t- kid1', '\t- kid2', '- tail'].join('\n'), 4));
  check('clicked both child blocks', (await selectBlocks(cdp, ['kid1', 'kid2'])) === 2);
  st = await selState(cdp);
  check('scenario 2: two children selected', st.selected === 2, `selected=${st.selected}`);

  await cdp.key('Tab', { code: 'Tab', shift: true });
  await settle();
  const o1 = await readMd(cdp, F2);
  console.log('--- scenario 2 after Shift+Tab ---\n' + o1);
  check('Shift+Tab lifted BOTH children out to top level',
    depthOf(o1, 'kid1') === 0 && depthOf(o1, 'kid2') === 0,
    `kid1=${depthOf(o1, 'kid1')} kid2=${depthOf(o1, 'kid2')}`);
  check('their former parent is untouched', depthOf(o1, 'parent') === 0, `parent=${depthOf(o1, 'parent')}`);
  check('the sibling below is untouched', depthOf(o1, 'tail') === 0, `tail=${depthOf(o1, 'tail')}`);

  // =========================================================================
  // Scenario 3 — the guards: no selection, and Escape.
  // =========================================================================
  await cdp.key('Escape', { code: 'Escape' });
  await sleep(600);
  st = await selState(cdp);
  check('Escape clears the selection', st.selected === 0, `selected=${st.selected}`);
  check('focus released after Escape (Tab goes back to Obsidian)', !st.inTree, JSON.stringify(st));

  const before = await readMd(cdp, F2);
  await cdp.key('Tab', { code: 'Tab' });
  await cdp.key('Tab', { code: 'Tab', shift: true });
  await sleep(2000);
  const afterLoose = await readMd(cdp, F2);
  check('Tab/Shift+Tab with NO selection leave the document alone', before === afterLoose,
    JSON.stringify({ before, afterLoose }));

  // =========================================================================
  // Scenario 4 — a single-block selection is the degenerate case of the same
  // path and must behave like plain single-block Tab.
  // =========================================================================
  const F4 = 'E2E/MultiSelTab4.md';
  check('fixture 4 painted', await openFixture(cdp, F4, ['- one', '- two', '- three'].join('\n'), 3));
  check('clicked a single block', (await selectBlocks(cdp, ['two'])) === 1);
  await cdp.key('Tab', { code: 'Tab' });
  await settle();
  const s1 = await readMd(cdp, F4);
  console.log('--- scenario 4 after Tab ---\n' + s1);
  check('single-block selection indents that block', depthOf(s1, 'two') === 1, `two=${depthOf(s1, 'two')}`);
  check('single-block selection leaves its neighbours alone',
    depthOf(s1, 'one') === 0 && depthOf(s1, 'three') === 0,
    `one=${depthOf(s1, 'one')} three=${depthOf(s1, 'three')}`);

  console.log('\n=== VERDICT ===');
  console.log(results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`).join('\n'));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  cdp.close();
  process.exitCode = failed ? 1 : 0;
} finally {
  killTestVaultObsidian();
}
process.exit(process.exitCode ?? 0);
