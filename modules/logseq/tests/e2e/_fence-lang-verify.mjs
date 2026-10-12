/**
 * VERIFY: a fence with NO language is reachable — the toolbar label opens
 * source mode with the caret after the fence, and a language can be typed.
 *
 * THE BUG (reported, from the test vault's fastapi.md): the fence under
 * `定义数据模型` is a plain ``` with no language and no prefix. The toolbar
 * label was gated on `lang || isMixed` in the reading view and on
 * `info.lang || info.prefix` in the code editor, so this fence rendered a
 * toolbar with no language target — no way into source mode, and therefore
 * no way to set the language.
 *
 * The fixture below reproduces that file's exact shape (tab-indented fence
 * under a list item). Behavioural, not structural: the click is dispatched
 * for real and the typed language is read back off disk.
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
const readMd = (cdp, f) => cdp.eval(async (p) => {
  const file = window.app.vault.getAbstractFileByPath(p);
  return file ? await window.app.vault.read(file) : null;
}, f);
const writeFile = (cdp, f, body) => cdp.eval((a) => {
  const v = window.app.vault;
  const ex = v.getAbstractFileByPath(a.f);
  if (ex) void v.modify(ex, a.b); else void v.create(a.f, a.b);
  return true;
}, { f, b: body });
async function openFixture(cdp, file, body, expected) {
  await writeFile(cdp, file, body);
  await sleep(600);
  await cdp.eval((f) => {
    void window.app.workspace.getLeaf(false).openFile(window.app.vault.getAbstractFileByPath(f));
    return true;
  }, file);
  const ok = await waitFor(cdp, (n) => document.querySelectorAll('.block-content-static').length >= n, expected, { label: `paint ${file}` });
  return !!ok;
}

// The reported shape: a heading-ish list block with a tab-indented, plain
// fence (no language, no prefix) as its child block.
const FASTAPI = [
  '- 定义数据模型',
  '\t- ```',
  '\t  from pydantic import BaseModel',
  '\t  ',
  '\t  class Item(BaseModel):',
  '\t    name: str',
  '\t  ```',
  '- 路由',
  '\t- ```python',
  '\t  from fastapi import APIRouter',
  '\t  ```',
].join('\n');

/** The label of every code toolbar, in document order. */
const labels = (cdp) => cdp.eval(() => {
  const out = [];
  document.querySelectorAll('.lgp-code-toolbar').forEach((bar) => {
    const el = bar.querySelector('.lgp-code-lang');
    out.push({
      text: el ? el.textContent.trim() : null,
      empty: el ? el.classList.contains('lgp-code-lang-empty') : false,
    });
  });
  return out;
});
const settle = () => sleep(2600); // debounced save (~800ms) + async flush

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
  // Scenario 1 — the reported case: a plain fence renders a label.
  // =========================================================================
  const F1 = 'E2E/FenceLang1.md';
  check('fixture painted', await openFixture(cdp, F1, FASTAPI, 4));

  const ls = await labels(cdp);
  console.log('toolbar labels:', JSON.stringify(ls));
  check('both fences render a language label', ls.length === 2, `count=${ls.length}`);
  check('the languageless fence HAS a label (the bug)', ls.some((l) => l.text !== null), JSON.stringify(ls));
  check('its label is the dimmed placeholder', ls.some((l) => l.empty === true), JSON.stringify(ls));
  check('the python fence still shows its language', ls.some((l) => l.text === 'python' && !l.empty), JSON.stringify(ls));

  // =========================================================================
  // Scenario 2 — click the label → source mode with the caret AFTER the
  // fence, then type a language and read it back off disk.
  // =========================================================================
  const clicked = await cdp.eval(() => {
    for (const el of document.querySelectorAll('.lgp-code-lang')) {
      if (el.classList.contains('lgp-code-lang-empty')) {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
    }
    return null;
  });
  check('located the placeholder label', !!clicked, JSON.stringify(clicked));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clicked.x, y: clicked.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(150);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clicked.x, y: clicked.y, button: 'left', buttons: 0, clickCount: 1 });
  // Source mode mounts through the OUTLINE editor (focusBlock +
  // sourceModeBlock), not through `mountCodeEditor` — so there is no
  // `.lgp-code-editing` / `.lgp-code-editor-host` in the DOM at all. Measured
  // with a DOM dump: after the click there is exactly one `.cm-content` whose
  // doc is the fence source, while both code-editor class counts are 0.
  const editing = await waitFor(
    cdp,
    () => {
      const cm = document.querySelector('.block-editor-tree .cm-content');
      if (!cm) return null;
      const doc = cm.textContent;
      // The code body is in the doc, so we are past the paint.
      if (!doc.includes('pydantic')) return null;
      return { doc, hasLabel: !!document.querySelector('.lgp-code-lang') };
    },
    null,
    { tries: 25, gap: 200, label: 'source mode mounted' },
  );
  console.log('after click:', JSON.stringify(editing));
  check('clicking the label opened source mode', !!editing, JSON.stringify(editing));
  check('source mode shows the fence line in the doc', !!editing && editing.doc.startsWith('```'), JSON.stringify(editing?.doc?.slice(0, 20)));
  check('the toolbar label is still present in source mode', !!editing?.hasLabel);

  // Type a language right where the caret sits. Read the doc BEFORE
  // committing: Escape destroys the editor, so the `.lgp-code-editing` host is
  // gone afterwards and any later query returns null. An earlier draft of this
  // file queried after Escape and concluded the typing had failed — it had
  // actually landed (the file on disk read "```pyt").
  await cdp.key('p', { code: 'KeyP' });
  await sleep(150);
  await cdp.key('y', { code: 'KeyY' });
  await sleep(150);
  await cdp.key('t', { code: 'KeyT' });
  await sleep(150);
  await cdp.key('h', { code: 'KeyH' });
  await sleep(150);
  await cdp.key('o', { code: 'KeyO' });
  await sleep(150);
  await cdp.key('n', { code: 'KeyN' });
  await sleep(700);

  const afterTyping = await cdp.eval(() => {
    const cm = document.querySelector('.block-editor-tree .cm-content');
    return cm ? cm.textContent : null;
  });
  console.log('doc after typing:', JSON.stringify(afterTyping?.slice(0, 24)));
  check('the language word was typed into the fence', !!afterTyping && /^```python/.test(afterTyping), JSON.stringify(afterTyping?.slice(0, 24)));
  check('the code body is untouched', !!afterTyping && afterTyping.includes('from pydantic import BaseModel'), JSON.stringify(afterTyping?.slice(0, 60)));

  // Commit with Escape and read the file back.
  await cdp.key('Escape', { code: 'Escape' });
  await settle();
  const md = await readMd(cdp, F1);
  console.log('--- file after commit ---\n' + md);
  check('the language was written to disk', !!md && md.includes('```python'), 'no ```python in file');
  check('the python block was NOT renamed', (md?.match(/```python/g) || []).length === 2, `count=${(md?.match(/```python/g) || []).length}`);

  // =========================================================================
  // Scenario 3 — reopening the SAVED file shows the real language, i.e. the
  // placeholder was replaced rather than committed as the word "text".
  // (Rewriting the fixture with FASTAPI here would legitimately bring the
  // placeholder back — an earlier draft did that and asserted the opposite.)
  // =========================================================================
  await cdp.eval((f) => {
    void window.app.workspace.getLeaf(false).openFile(window.app.vault.getAbstractFileByPath(f));
    return true;
  }, F1);
  const back = await waitFor(cdp, () => document.querySelectorAll('.lgp-code-toolbar').length === 2, null, { label: 'reopen saved' });
  check('saved file reopens', !!back);
  const ls2 = await labels(cdp);
  console.log('labels after reload:', JSON.stringify(ls2));
  check('both fences now report python (placeholder not committed)', ls2.length === 2 && ls2.every((l) => l.text === 'python'), JSON.stringify(ls2));

  console.log('\n================ SUMMARY ================');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  for (const f of failed) console.log(`  FAIL: ${f.name}`);
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error('harness error:', e);
  process.exit(2);
}
