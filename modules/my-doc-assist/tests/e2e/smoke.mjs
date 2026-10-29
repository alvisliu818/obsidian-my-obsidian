/**
 * obsidian-doc-assist E2E 冒烟探针（CDP 9259）。
 * 验证：插件启用 → 12 命令注册 → 文本命令端到端 → 删区间命令 + ConfirmModal。
 */
import { chromium } from '@playwright/test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.connectOverCDP('http://127.0.0.1:9259');
let page = null;
for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith('app://obsidian.md')) page = p;
if (!page) { console.log('FAIL: no obsidian page'); process.exit(1); }

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

// 0. 启用插件
await page.evaluate(async () => {
	const app = window.app;
	await app.plugins.loadManifests();
	// 强制重载：disable -> enable 确保读取磁盘上最新的 main.js
	if (app.plugins.enabledPlugins.has('obsidian-doc-assist')) {
		await app.plugins.disablePluginAndSave('obsidian-doc-assist');
	}
	await app.plugins.enablePluginAndSave('obsidian-doc-assist');
});
await sleep(1000);

// 0.5 测试库的 obsidian-logseq 插件会把 markdown 接管为块编辑器视图，临时禁用
const logseqWasEnabled = await page.evaluate(async () => {
	if (window.app.plugins.enabledPlugins.has('obsidian-logseq')) {
		await window.app.plugins.disablePluginAndSave('obsidian-logseq');
		return true;
	}
	return false;
});

// 1. 命令注册
const cmdIds = await page.evaluate(() =>
	Object.keys(window.app.commands.commands).filter((id) => id.startsWith('obsidian-doc-assist:')),
);
check('命令已注册(>=12)', cmdIds.length >= 12, `found ${cmdIds.length}`);

// 测试文件工具
async function resetFile(content) {
	await page.evaluate(async (c) => {
		const app = window.app;
		const path = '_docassist-smoke-test.md';
		const existing = app.vault.getAbstractFileByPath(path);
		if (existing) await app.vault.delete(existing, true);
		const file = await app.vault.create(path, c);
		await app.workspace.getLeaf('tab').openFile(file);
	}, content);
	await sleep(500);
	// 等待原生 markdown 视图与编辑器就绪
	for (let i = 0; i < 10; i++) {
		const ready = await page.evaluate(() => {
			const view = window.app.workspace.getMostRecentLeaf()?.view;
			return view?.getViewType?.() === 'markdown' && !!view.editor;
		});
		if (ready) return;
		await sleep(300);
	}
}
async function getEditorRef() {
	return page.evaluate(() => {
		const view = window.app.workspace.getMostRecentLeaf()?.view;
		return view?.getViewType?.() === 'markdown' && view.editor ? true : false;
	});
}
async function runCmd(id) {
	return page.evaluate((cid) => {
		const view = window.app.workspace.getMostRecentLeaf()?.view;
		const editor = view?.getViewType?.() === 'markdown' ? view.editor : window.app.workspace.activeEditor?.editor;
		if (!editor) return { error: 'no editor' };
		const before = editor.getValue();
		window.app.commands.executeCommandById(cid);
		return { before, after: editor.getValue() };
	}, id);
}
async function cleanupFile() {
	await page.evaluate(async () => {
		const f = window.app.vault.getAbstractFileByPath('_docassist-smoke-test.md');
		if (f) await window.app.vault.delete(f, true);
	});
}

// 2. cleanup-blank-lines（无选区 → 全文档）
await resetFile('a\n\n\n\nb');
let r = await runCmd('obsidian-doc-assist:cleanup-blank-lines');
check('去多余空行', r.after === 'a\n\nb', JSON.stringify(r.after));

// 3. toggle-punctuation（全文档判向 zh-to-en）
await resetFile('你好，世界。');
r = await runCmd('obsidian-doc-assist:toggle-punctuation');
check('标点互转', r.after === '你好,世界.', JSON.stringify(r.after));

// 4. merge-selection-into-list（选中前两行）
await resetFile('甲\n乙\n丙');
await page.evaluate(() => {
	const view = window.app.workspace.getMostRecentLeaf()?.view; const editor = view.editor;
	editor.setSelection({ line: 0, ch: 0 }, { line: 1, ch: 1 });
});
r = await runCmd('obsidian-doc-assist:merge-selection-into-list');
check('合并选区为列表(段落组)', r.after === '- 甲\n  乙\n丙', JSON.stringify(r.after));

// 5. AI 报告清理
await resetFile('结论<sup>[1]</sup>如下[1](https://example.com/a)\n---\n');
r = await runCmd('obsidian-doc-assist:cleanup-ai-output');
check('AI 报告清理(分隔线删行)', r.after === '结论如下\n', JSON.stringify(r.after));

// 6. 断尾求真 + ConfirmModal 确认
await resetFile('保留段\n\n尾部垃圾1\n尾部垃圾2');
await page.evaluate(() => {
	const view = window.app.workspace.getMostRecentLeaf()?.view; const editor = view.editor;
	const cur = editor.getValue().split('\n').indexOf('尾部垃圾1');
	editor.setCursor({ line: cur, ch: 0 });
	window.app.commands.executeCommandById('obsidian-doc-assist:delete-from-current-to-end');
});
await sleep(600);
const modalBtn = await page.evaluate(() => {
	const btns = Array.from(document.querySelectorAll('.modal-container button'));
	const target = btns.find((b) => b.textContent.includes('确定删除'));
	if (!target) return { found: false, texts: btns.map((b) => b.textContent) };
	target.click();
	return { found: true };
});
await sleep(400);
let afterModal = await page.evaluate(() => window.app.workspace.getMostRecentLeaf()?.view?.editor?.getValue() ?? '(no editor)');
check('断尾求真(弹窗确认)', modalBtn.found && afterModal === '保留段\n', `after=${JSON.stringify(afterModal)}`);

// 7. 删前段：frontmatter 保护 + 分隔线保护
await resetFile('---\ntitle: x\n---\n\n垃圾1\n垃圾2\n---\n\n正文一\n正文二\n尾部');
await page.evaluate(() => {
	const view = window.app.workspace.getMostRecentLeaf()?.view; const editor = view.editor;
	const lines = editor.getValue().split('\n');
	const cur = lines.indexOf('垃圾2');
	editor.setCursor({ line: cur, ch: 0 });
	window.app.commands.executeCommandById('obsidian-doc-assist:delete-from-start-to-current');
});
await sleep(600);
const btn2 = await page.evaluate(() => {
	const btns = Array.from(document.querySelectorAll('.modal-container button'));
	const target = btns.find((b) => b.textContent.includes('确定删除'));
	if (!target) return { found: false };
	target.click();
	return { found: true };
});
await sleep(400);
afterModal = await page.evaluate(() => window.app.workspace.getMostRecentLeaf()?.view?.editor?.getValue() ?? '(no editor)');
check(
	'删前段(弹窗确认+保护)',
	btn2.found && afterModal === '---\ntitle: x\n---\n---\n\n正文一\n正文二\n尾部',
	`after=${JSON.stringify(afterModal)}`,
);

// 8. 撤销回退验证（删区间单撤销步）
await page.evaluate(() => {
	const view = window.app.workspace.getMostRecentLeaf()?.view; const editor = view.editor;
	editor.undo();
});
await sleep(300);
const afterUndo = await page.evaluate(() => window.app.workspace.getMostRecentLeaf()?.view?.editor?.getValue() ?? '');
check('删区间可整体撤销', afterUndo.includes('垃圾1'), `len=${afterUndo.length}`);

await cleanupFile();

// 恢复 obsidian-logseq 插件
if (logseqWasEnabled) {
	await page.evaluate(async () => {
		await window.app.plugins.enablePluginAndSave('obsidian-logseq');
	});
}
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
