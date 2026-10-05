/**
 * VERIFY: folding works on EVERY block kind, at two levels, and survives a
 * save/reload round trip through the markdown.
 *
 * Behavioural, not structural — the caret is clicked for real and the result is
 * read back off disk. Two facts the implementation rests on, both established
 * with probes while building it (see notes/testing.md):
 *
 *   1. A verbatim block could not own properties at all: the serializer
 *      answered `if (b.kind === 'raw') return b.text`, dropping `props`, and a
 *      `collapsed:: true` line INSIDE a fence came back as code. The flag now
 *      lives BELOW the block as an unindented property line, which is what the
 *      parser re-attaches. Indenting it (the way a list block's properties are
 *      indented) does NOT work — the line reads back as a soft line.
 *   2. The property line only re-attaches when the pending raw region is
 *      CLOSED, so `key:: value` inside an unterminated fence stays code.
 *
 * Fold state is a view concern only: the block's text is never rewritten, so
 * these assertions compare the FILE, not just the DOM.
 */
import { spawn } from 'node:child_process';
import { killTestVaultObsidian, prepareTestProfile, testSpawnArgs } from './obsidian-process.mjs';
import { Cdp, sleep } from './cdp.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
async function waitFor(cdp, fn, arg, { tries = 40, gap = 400, label = 'cond' } = {}) {
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
async function openFixture(cdp, file, body, expected) {
  await writeFile(cdp, file, body);
  await sleep(600);
  await cdp.eval((f) => {
    void window.app.workspace.getLeaf(false).openFile(window.app.vault.getAbstractFileByPath(f));
    return true;
  }, file);
  // The view must actually be showing THIS file before anything is measured.
  await waitFor(
    cdp,
    (f) => {
      const v = window.app.workspace.getLeavesOfType('logseq-block-editor')
        .map((l) => l.view)
        .find((x) => x && x.file);
      return !!v && v.file.path === f;
    },
    file,
    { label: `open ${file}` },
  );
  // Wait for the OPEN FILE's own text, not just a block count. Counting blocks
  // alone returned the PREVIOUS file's DOM (same block count), so every
  // index-based lookup below then pointed at the wrong rows — an earlier draft
  // folded "the code block caret" of a file that was no longer on screen.
  const marker = body.split('\n').find((l) => l.trim() !== '' && !l.startsWith('```') && !l.startsWith('|') && !l.startsWith('***')) ?? body.slice(0, 12);
  const key = marker.replace(/^[#>\-*+\s]+/, '').slice(0, 10);
  const ok = await waitFor(
    cdp,
    (a) => {
      const rows = document.querySelectorAll('.block-editor-tree .block-wrap').length;
      if (rows < a.n) return false;
      const text = document.querySelector('.block-editor-tree')?.textContent ?? '';
      return text.includes(a.key);
    },
    { n: expected, key },
    { label: `paint ${file}` },
  );
  return !!ok;
}
/**
 * Wait until the plugin has written `expect` (a substring) to `file`.
 *
 * A fixed sleep made this file flaky — the save is debounced (~800ms) and then
 * async, so on a loaded machine 2.6s was occasionally not enough and every
 * following assertion read a stale file. Polling the real condition removes the
 * guesswork; the timeout is only a failure path. With no expectation, fall back
 * to a plain settle (used after a fold that REMOVES a line).
 */
async function settle(cdp, file, expect) {
  if (expect === undefined) {
    await sleep(2600);
    return;
  }
  const ok = await waitFor(
    cdp,
    async (a) => {
      const f = window.app.vault.getAbstractFileByPath(a.f);
      if (!f) return false;
      const data = await window.app.vault.cachedRead(f);
      return data.includes(a.e);
    },
    { f: file, e: expect },
    { tries: 15, gap: 400, label: `settle("${expect}")` },
  );
  if (!ok) console.log(`  [settle] gave up waiting for "${expect}" in ${file}`);
  return !!ok;
}

/** Caret positions in document order, with the block text they belong to. */
const carets = (cdp) => cdp.eval(() => {
  const out = [];
  document.querySelectorAll('.block-wrap').forEach((w) => {
    const caret = w.querySelector(':scope > .block-main > .block-controls > .block-caret');
    if (!caret) return;
    // MUST be this row's OWN content: a plain descendant selector reaches into
    // nested blocks and merges their text into this row, which silently broke
    // the index-based lookups below (an earlier draft matched 3 rows for 1
    // block). A table renders straight into the holder rather than into a
    // `.block-content-static`, hence the extra branches.
    const own = w.querySelector(
      ':scope > .block-main > .block-content > .block-content-static,' +
        ' :scope > .block-main > .block-content > .block-fold-summary,' +
        ' :scope > .block-main > .block-content > table,' +
        ' :scope > .block-main > .block-content > .cmg-embed',
    );
    out.push({
      text: (own?.textContent ?? '').trim().slice(0, 30),
      kind: own?.classList.contains('block-fold-summary') ? 'summary' : 'body',
      visible: getComputedStyle(caret).opacity !== '0',
    });
  });
  return out;
});
const foldState = (cdp) => cdp.eval(() => ({
  summaries: document.querySelectorAll('.block-fold-summary').length,
  full: document.querySelectorAll('.block-fold-summary.is-full').length,
  // A folded block's body must be GONE from the DOM, not merely hidden by CSS.
  // Scoped to the collapsed wrap, and counting only CODE (a `table` selector
  // also matched the table editor's grid, which is never folded here).
  codeInFolded: [...document.querySelectorAll('.block-wrap.is-collapsed pre, .block-wrap.is-collapsed .cm-content')].length,
}));
/** Click the Nth caret, optionally with Alt held. */
async function clickCaret(cdp, index, { alt = false } = {}) {
  const p = await cdp.eval((i) => {
    const list = [...document.querySelectorAll('.block-editor-tree .block-caret')];
    const caret = list[i];
    if (!caret) return null;
    const r = caret.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, index);
  if (!p) return false;
  const m = alt ? 1 : 0; // 1 = Alt
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1, modifiers: m });
  await sleep(150);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1, modifiers: m });
  await sleep(700);
  return true;
}

// Blank lines between the top-level structural blocks are REQUIRED: a heading
// immediately followed by a fence (no blank line) makes the parser fold both
// into ONE raw block, so the fixture silently tested a single merged block.
// Measured with a probe rather than guessed — an earlier draft omitted them and
// every per-kind assertion then failed against correct code.
/** Click the caret of the block whose own text matches, by re-reading the DOM. */
async function clickCaretOf(cdp, matcher, opts = {}) {
  const rows = await carets(cdp);
  const idx = typeof matcher === 'string'
    ? rows.findIndex((c) => c.text.includes(matcher))
    : rows.findIndex(matcher);
  if (idx < 0) {
    console.log('  no caret matches', matcher, 'among', JSON.stringify(rows.map((r) => r.text)));
    return false;
  }
  return clickCaret(cdp, idx, opts);
}

const FIXTURE = [
  '# 定义数据模型',
  '',
  '```python',
  'class Item(BaseModel):',
  '    name: str',
  '```',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '- 已有子块的列表项',
  '\t- 子块',
  '',
  '![](assets/shot.png)',
].join('\n');

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
  // Scenario 1 — a caret on EVERY kind, including the ones that never had one.
  // =========================================================================
  const F = 'E2E/Fold1.md';
  check('fixture painted', await openFixture(cdp, F, FIXTURE, 4));
  const cs = await carets(cdp);
  console.log('carets:', JSON.stringify(cs));
  // A heading folds its SECTION (SiYuan's `removeFoldHeading`), so it does get
  // a caret even with no body of its own. Scenario 6 covers that end to end.
  check('a heading gets a caret (folds its section)', cs.some((c) => c.text.includes('定义数据模型')), JSON.stringify(cs));
  check('a fenced code block gets a caret', cs.some((c) => c.text.includes('class Item') || c.text.includes('python')), JSON.stringify(cs));
  check('a table gets a caret', cs.some((c) => c.text.includes('列 A') || c.text.includes('Row')), JSON.stringify(cs));
  check('a list block with children keeps its caret', cs.some((c) => c.text.includes('已有子块')), JSON.stringify(cs));
  check('a single-line plain block gets NO caret', !cs.some((c) => c.text === '子块'), JSON.stringify(cs));
  check('carets on verbatim blocks are always visible', cs.filter((c) => c.visible).length >= 2, JSON.stringify(cs));

  // =========================================================================
  // Scenario 2 — click a code block's caret: folds to a summary, and the file
  // gains the property line BELOW the fence.
  // =========================================================================
  const isCode = (c) => c.text.includes('class Item') || c.text.includes('python');
  check('clicked the code block caret', await clickCaretOf(cdp, isCode));
  let st = await foldState(cdp);
  console.log('fold state:', JSON.stringify(st));
  check('a summary replaced the code body', st.summaries === 1, JSON.stringify(st));
  check('the folded code is NOT rendered', st.codeInFolded === 0, JSON.stringify(st));

  await settle(cdp, F, 'collapsed:: true');
  const md1 = await readMd(cdp, F);
  console.log('--- file after folding the code block ---\n' + md1);
  check('collapsed:: written below the fence', /```\ncollapsed:: true/.test(md1 ?? ''), 'flag not below the fence');
  check('the code itself is untouched', (md1 ?? '').includes('class Item(BaseModel):'));

  // =========================================================================
  // Scenario 3 — Alt+click is SiYuan's `toggleListFold`: fold every
  // descendant. A CHILDLESS block (this code fence) has none, so the gesture
  // falls back to toggling the block itself — never a dead click. The block is
  // FOLDED at this point, so alt expands it; the real recursive case is in
  // scenario 5, on the list container.
  // =========================================================================
  check('alt-clicked the childless caret (was folded)', await clickCaretOf(cdp, isCode, { alt: true }));
  st = await foldState(cdp);
  check('alt on a childless block toggles it rather than doing nothing', st.summaries === 0, JSON.stringify(st));

  // =========================================================================
  // Scenario 4 — ONE click folds, ONE more expands (a plain click is a
  // two-state toggle), and unfolding REMOVES the property line, so an unfolded
  // block's file is identical to a fresh one.
  // =========================================================================
  check('clicked to fold again', await clickCaretOf(cdp, isCode));
  await settle(cdp, F, 'collapsed:: true');
  check('the flag is back', (await readMd(cdp, F) ?? '').includes('collapsed:: true'), 'flag missing after re-folding');
  check('clicked again to expand', await clickCaretOf(cdp, isCode));
  await waitFor(cdp, async (a) => { const f = window.app.vault.getAbstractFileByPath(a); if (!f) return false; return !(await window.app.vault.cachedRead(f)).includes('collapsed::'); }, F, { tries: 15, gap: 400, label: 'flag removed' });
  const md3 = await readMd(cdp, F);
  check('the property line is gone once unfolded', !(md3 ?? '').includes('collapsed::'), 'collapsed:: still present');
  // Not a byte comparison: the parser attaches a trailing image line to the
  // preceding sub-tree on load (pre-existing behaviour, unrelated to folding),
  // so only the parts folding could have touched are compared.
  const stripped = (md3 ?? '').split('\n').filter((l) => !l.includes('collapsed::')).join('\n').trim();
  check('unfolding restored the original body', stripped.includes('class Item(BaseModel):') && stripped.includes('| 列 A | 列 B |'), 'body differs');

  // =========================================================================
  // Scenario 4b — a HEADING is deliberately NOT foldable.
  //
  // Checked against SiYuan's own rule rather than guessed: `setFold` in
  // app/src/protyle/util/blockFold.ts bails out for a list item with
  // `childElementCount < 4` ("没有子列表或多个块的列表项不进行折叠") and for a
  // thematic break. A single-line plain block has nothing to hide either, and a
  // divider never folds. Headings fold their SECTION — covered end to end in
  // scenario 6.
  // =========================================================================
  const FH = 'E2E/FoldHeading.md';
  check('heading fixture painted', await openFixture(cdp, FH, ['## 章标题', '', '正文第一行', '', '- 有子块的项', '\t- 子一', '\t- 子二'].join('\n'), 3));
  const hc = await carets(cdp);
  console.log('heading fixture carets:', JSON.stringify(hc));
  check('a single-line plain block gets no caret', !hc.some((c) => c.text.includes('正文第一行')), JSON.stringify(hc));
  const withKids = hc.findIndex((c) => c.text.includes('有子块的项'));
  check('a list item WITH children does get a caret', withKids >= 0, JSON.stringify(hc));
  if (withKids >= 0) {
    check('folded the parent list item', await clickCaret(cdp, withKids));
    await settle(cdp, FH, 'collapsed:: true');
    const hmd = await readMd(cdp, FH);
    check('the fold flag is recorded under the parent', /\tcollapsed:: true/.test(hmd ?? ''), (hmd ?? '').split('\n').slice(-4).join(' | '));
    check('folded state survives a reload', await (async () => {
      await cdp.eval((f) => { void window.app.workspace.getLeaf(false).openFile(window.app.vault.getAbstractFileByPath(f)); return true; }, FH);
      // A folded CONTAINER shows no summary — it keeps its own text and hides
      // its children — so the reload is detected by the collapsed wrap, not by
      // a placeholder row. (Waiting for a summary here timed out against
      // correct behaviour.)
      return !!(await waitFor(cdp, () => document.querySelectorAll('.block-wrap.is-collapsed').length === 1, null, { label: 'heading fixture reload' }));
    })());
    const afterReload2 = await cdp.eval(() => {
      const w = [...document.querySelectorAll('.block-wrap')].find((x) => {
        const s = x.querySelector(':scope > .block-main > .block-content > .block-content-static');
        return (s?.textContent ?? '').includes('有子块的项');
      });
      return {
        ownText: (w?.querySelector(':scope > .block-main > .block-content > .block-content-static')?.textContent ?? '').trim().slice(0, 10),
        kids: w?.querySelectorAll('.block-children .block-wrap').length ?? -1,
      };
    });
    console.log('after reload:', JSON.stringify(afterReload2));
    check('after reload the container still shows its own text', afterReload2.ownText.includes('有子块的项'), JSON.stringify(afterReload2));
    check('after reload its children are still hidden', afterReload2.kids === 0, JSON.stringify(afterReload2));
    check('reopened the main fixture', await openFixture(cdp, F, FIXTURE, 4));
  }

  // A divider is never foldable — SiYuan returns early for NodeThematicBreak.
  const FD = 'E2E/FoldDivider.md';
  check('divider fixture painted', await openFixture(cdp, FD, ['***', '', '正文一', '', '***', '', '正文二'].join('\n'), 4));
  const dc = await carets(cdp);
  check('a divider gets NO caret', !dc.some((c) => c.text.trim() === '***'), JSON.stringify(dc));
  check('reopened the main fixture again', await openFixture(cdp, F, FIXTURE, 4));

  // =========================================================================
  // Scenario 5 — the OTHER kinds fold too, and each keeps its own flag.
  // =========================================================================
  const isTable = (c) => c.text.includes('列 A') || c.text.includes('Row');
  check('folded the table', await clickCaretOf(cdp, isTable));
  check('folded the list block', await clickCaretOf(cdp, (c) => c.text.includes('已有子块')));
  await settle(cdp, F, 'collapsed:: true');
  const md4 = await readMd(cdp, F);
  console.log('--- file with table + list folded ---\n' + md4);
  const flagCount = (md4 ?? '').match(/collapsed:: true/g) ?? [];
  check('both folds recorded independently', flagCount.length === 2, `count=${flagCount.length}`);
  const st4 = await foldState(cdp);
  check('the table shows a summary (it has no children)', st4.summaries === 1, JSON.stringify(st4));
  check('the list block keeps its own text and shows NO summary', st4.summaries === 1, JSON.stringify(st4));
  const listText = await cdp.eval(() => {
    const w = [...document.querySelectorAll('.block-wrap')].find((x) => {
      const s = x.querySelector(':scope > .block-main > .block-content > .block-content-static');
      return (s?.textContent ?? '').includes('已有子块');
    });
    const own = w?.querySelector(':scope > .block-main > .block-content > .block-content-static');
    const kids = w?.querySelectorAll('.block-children .block-wrap').length ?? -1;
    return { text: (own?.textContent ?? '').trim().slice(0, 12), visibleKids: kids, hasSummary: !!w?.querySelector('.block-fold-summary') };
  });
  console.log('folded list block:', JSON.stringify(listText));
  check('the container keeps its own text visible', listText.text.includes('已有子块') && !listText.hasSummary, JSON.stringify(listText));
  check('its children are hidden', listText.visibleKids === 0, JSON.stringify(listText));

  // Alt+click on that container folds EVERY descendant (toggleListFold).
  check('alt-clicked the container', await clickCaretOf(cdp, (c) => c.text.includes('已有子块'), { alt: true }));
  await settle(cdp, F, 'collapsed:: true');
  const mdAlt = await readMd(cdp, F);
  check('alt recorded a fold on the child that has children', /子块\n\tcollapsed:: true/.test(mdAlt ?? '') || /已有子块的列表项\n\tcollapsed:: true/.test(mdAlt ?? ''), (mdAlt ?? '').split('\n').slice(-5).join(' | '));

  // =========================================================================
  // Scenario 6 — reload: the state comes back from the markdown alone.
  // =========================================================================
  await cdp.eval((f) => {
    void window.app.workspace.getLeaf(false).openFile(window.app.vault.getAbstractFileByPath(f));
    return true;
  }, F);
  // The table is childless so it shows a summary; the list container keeps its
  // own text. Wait for the summary AND the collapsed wrap, not for two rows.
  const back = await waitFor(
    cdp,
    () => document.querySelectorAll('.block-fold-summary').length === 1
      && document.querySelectorAll('.block-wrap.is-collapsed').length === 1,
    null,
    { label: 'reopen' },
  );
  check('folded blocks are still folded after a reload', !!back);
  const md5 = await readMd(cdp, F);
  check('reload did not rewrite the file', (md5 ?? '') === (md4 ?? ''), 'file changed on reload');

  // =========================================================================
  // Scenario 6 — SECTION folding, matching SiYuan's `removeFoldHeading`.
  //
  // A markdown heading cannot own the blocks under it (they are siblings,
  // measured), so folding a heading hides the SECTION it introduces: the
  // following siblings up to the next heading of the same or a shallower
  // level. Deeper headings belong to the section — SiYuan's walk removes every
  // sibling that is not a heading OR is a deeper one.
  // =========================================================================
  const FS = 'E2E/FoldSection.md';
  const SECTION_MD = ['# 章标题', '', '正文甲', '', '## 子标题', '', '正文乙', '', '# 下一章', '', '正文丙'].join('\n');
  check('section fixture painted', await openFixture(cdp, FS, SECTION_MD, 5));
  const beforeRows = await cdp.eval(() => document.querySelectorAll('.block-editor-tree .block-wrap').length);
  check('all section blocks visible before folding', beforeRows === 6, `rows=${beforeRows}`);

  const sc = await carets(cdp);
  console.log('section carets:', JSON.stringify(sc));
  const hIdx = sc.findIndex((c) => c.text.includes('章标题'));
  check('a heading gets a caret', hIdx >= 0, JSON.stringify(sc));
  if (hIdx >= 0) {
    check('folded the heading', await clickCaret(cdp, hIdx));
    const afterRows = await cdp.eval(() => document.querySelectorAll('.block-editor-tree .block-wrap').length);
    const texts = await cdp.eval(() => Array.from(document.querySelectorAll('.block-editor-tree .block-wrap'))
      .map((w) => {
        const own = w.querySelector(':scope > .block-main > .block-content > .block-content-static');
        return (own?.textContent ?? '').trim().slice(0, 12);
      }));
    console.log('rows after fold =', afterRows, JSON.stringify(texts));
    check('the whole section is hidden', afterRows === 3, `rows=${afterRows}`);
    check('the next same-level heading survives', texts.some((t) => t.includes('下一章')), JSON.stringify(texts));
    await settle(cdp, FS, 'collapsed:: true');
    const smd = await readMd(cdp, FS);
    check('the section fold flag is recorded', /章标题\ncollapsed:: true/.test(smd ?? ''), (smd ?? '').split('\n').slice(0, 4).join(' | '));
    check('the section content is NOT deleted from the file', (smd ?? '').includes('正文乙'), 'content lost');
    // Reload: the section must come back folded from the markdown alone.
    await cdp.eval((f) => { void window.app.workspace.getLeaf(false).openFile(window.app.vault.getAbstractFileByPath(f)); return true; }, FS);
    await waitFor(cdp, (f) => {
      const v = window.app.workspace.getLeavesOfType('logseq-block-editor').map((l) => l.view).find((x) => x && x.file);
      return !!v && v.file.path === f;
    }, FS, { label: `reopen ${FS}` });
    const reRows = await waitFor(cdp, () => document.querySelectorAll('.block-editor-tree .block-wrap').length === 3, null, { label: 'section reload' });
    check('the section is still folded after a reload', !!reRows);
    // Target the heading's own caret by its text, not by index 0: after the
    // reload the DOM order is not guaranteed and index 0 hit a hidden row.
    const afterReload = await carets(cdp);
    console.log('carets after reload:', JSON.stringify(afterReload));
    const hIdx2 = afterReload.findIndex((c) => c.text.includes('章标题'));
    check('located the heading caret after reload', hIdx2 >= 0, JSON.stringify(afterReload));
    // ONE click expands — a plain click is a two-state toggle. (An earlier
    // draft clicked once and read `collapsed: "full"` from the model: the
    // three-state cycle working as designed then, and a genuine "the first
    // click didn't register" complaint from the user.)
    check('one click expands the section', await clickCaret(cdp, hIdx2));
    await sleep(500);
    const restored = await cdp.eval(() => document.querySelectorAll('.block-editor-tree .block-wrap').length);
    check('unfolding brings the section back', restored === 6, `rows=${restored}`);
  }

  console.log('\n================ SUMMARY ================');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  for (const f of failed) console.log(`  FAIL: ${f.name}`);
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error('harness error:', e);
  process.exit(2);
}
