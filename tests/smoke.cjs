/**
 * 冒烟测试：用真实构建产物 main.js + 迷你 DOM/Obsidian 桩跑一遍核心链路。
 * 运行：node tests/smoke.cjs
 */
"use strict";

const assert = require("assert");
const { installDom, installObsidianStub } = require("./dom-stub.cjs");

const { document } = installDom();
const { cmViewModule } = installObsidianStub();

const mod = require("../dist/main.js");
const BreadcrumbNavPlugin = mod.default || mod;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 测试数据 ----------
const HEADINGS = [
	{ heading: "第一章", level: 1, position: { start: { line: 0, offset: 0 } } },
	{ heading: "第一节", level: 2, position: { start: { line: 3, offset: 20 } } },
	{ heading: "小节", level: 3, position: { start: { line: 5, offset: 40 } } },
	{ heading: "细节A", level: 4, position: { start: { line: 7, offset: 60 } } },
	{ heading: "细节B", level: 4, position: { start: { line: 9, offset: 80 } } },
	{ heading: "第二节", level: 2, position: { start: { line: 11, offset: 100 } } },
	{ heading: "尾章", level: 1, position: { start: { line: 13, offset: 120 } } },
];

function makeFile(path) {
	const { TFile } = require("obsidian");
	return new TFile(path);
}

function makeView(file) {
	const calls = [];
	const contentEl = document.createElement("div");
	contentEl.className = "view-content";
	const sourceView = document.createElement("div");
	sourceView.className = "markdown-source-view";
	contentEl.appendChild(sourceView);
	document.body.appendChild(contentEl); // 真实环境里 view.contentEl 挂在 document 下

	// 模拟 CodeMirror 的滚动容器（.cm-scroller）视口顶端在 100px，可视高 400
	const scrollDOM = document.createElement("div");
	scrollDOM.className = "cm-scroller";
	scrollDOM._overflowY = "auto";
	scrollDOM.scrollHeight = 2000;
	scrollDOM.clientHeight = 400;
	scrollDOM._rect = { top: 100, bottom: 500, left: 0, height: 400 };
	contentEl.appendChild(scrollDOM);

	// cm 内容层：其视口坐标随 scrollDOM.scrollTop 移动，保证「滚动 → 坐标变化」的物理一致
	const contentDOM = document.createElement("div");
	contentDOM.className = "cm-content";
	scrollDOM.appendChild(contentDOM);
	// 目标行元素（用于跳转后高亮）
	const lineEl = document.createElement("div");
	lineEl.className = "cm-line";
	contentDOM.appendChild(lineEl);

	// lineOffset = 目标行距内容层顶端的固定偏移；contentOrigin 默认 0
	const cmState = { contentOrigin: 0, lineOffset: 200, coords: true, dispatchCalls: [] };
	contentDOM._rect = () => ({ top: 100 + cmState.contentOrigin - scrollDOM.scrollTop });

	const cm = {
		scrollDOM,
		contentDOM,
		coordsAtPos: () =>
			cmState.coords
				? { top: contentDOM.getBoundingClientRect().top + cmState.lineOffset }
				: null,
		domAtPos: () => ({ node: lineEl }),
		lineBlockAt: () => ({ top: cmState.lineOffset }),
		dispatch: (spec) => cmState.dispatchCalls.push(spec),
	};

	const editor = {
		cursor: { line: 0, ch: 0 },
		getCursor() {
			return this.cursor;
		},
		setCursor(pos) {
			this.cursor = pos;
			calls.push(["setCursor", pos.line]);
		},
		scrollIntoView(range, center) {
			calls.push(["scrollIntoView", center]);
		},
		posToOffset: (pos) => pos.line * 10,
		focus() {},
		cm,
	};

	return {
		file,
		contentEl,
		scrollDOM,
		contentDOM,
		lineEl,
		cmState,
		editor,
		calls,
		getMode: () => "source",
		previewMode: { getScroll: () => contentEl.scrollTop },
	};
}

/** 阅读模式视图：两个标题的内容坐标固定为 400 / 900，容器视口顶端在 100 */
function makePreviewView(file) {
	const contentEl = document.createElement("div");
	contentEl.className = "view-content";
	contentEl._overflowY = "auto";
	contentEl.scrollHeight = 3000;
	contentEl.clientHeight = 500;
	contentEl._rect = { top: 100, bottom: 600, left: 0, height: 500 };
	document.body.appendChild(contentEl);

	const previewEl = document.createElement("div");
	previewEl.className = "markdown-preview-view";
	contentEl.appendChild(previewEl);

	const at = (contentTop) => () => ({ top: 100 + (contentTop - contentEl.scrollTop), bottom: 0 });
	const h1 = document.createElement("h1");
	h1.textContent = "甲";
	h1._rect = at(400);
	const h2 = document.createElement("h2");
	h2.textContent = "乙";
	h2._rect = at(900);
	previewEl.appendChild(h1);
	previewEl.appendChild(h2);

	return {
		file,
		contentEl,
		getMode: () => "preview",
		previewMode: { getScroll: () => contentEl.scrollTop },
	};
}

function makeApp(view, files, caches, opened) {
	return {
		vault: {
			getMarkdownFiles: () => files,
			getAbstractFileByPath: (p) => files.find((f) => f.path === p) || null,
		},
		metadataCache: {
			getFileCache: (f) => caches.get(f.path) || null,
			on: () => ({}),
		},
		workspace: {
			getActiveViewOfType: () => view,
			getLeavesOfType: () => [{ view }],
			getLeaf: () => ({
				openFile: async (f) => {
					opened.push(f.path);
				},
			}),
			on: () => ({}),
		},
	};
}

// 面包屑按 class 找：非活动视图那一条没有 id（避免多栏重复 id）
const barOf = (view) => view.contentEl.children.find((c) => c.className.includes("bcn-bar")) || null;
const itemsOf = (bar) => bar.children.filter((c) => c.className.includes("bcn-item"));
const nextIconOf = (bar) => bar.children.find((c) => c.className.includes("bcn-next")) || null;
const popup = () => document.body.children.find((c) => c.className === "bcn-popup") || null;
/** 级联子菜单，按展开顺序即层级顺序（level 1、2、3 …） */
const subPopups = () =>
	document.body.children.filter((c) => c.className === "bcn-popup bcn-popup-sub");
const popupTexts = (p) => p.children.map((c) => c.children[0].textContent);
const nextBtnOf = (item) => item.children.find((c) => c.className === "bcn-popup-next");

(async () => {
	let passed = 0;
	const check = (name, fn) => {
		fn();
		passed++;
		console.log("  ✓ " + name);
	};

	// ---------- 场景 1：基础渲染 ----------
	const file = makeFile("工作/项目笔记.md");
	const view = makeView(file);
	const caches = new Map([[file.path, { headings: HEADINGS, tags: [], frontmatter: null }]]);
	const opened = [];
	const app = makeApp(view, [file], caches, opened);

	const plugin = new BreadcrumbNavPlugin(app, { id: "breadcrumb-nav" });
	await plugin.onload();
	clearTimeout(plugin.refreshTimer); // 停掉启动时的延迟刷新，避免干扰断言

	view.editor.cursor = { line: 5, ch: 0 };
	await plugin.refresh();

	let bar = barOf(view);
	check("面包屑栏插入到笔记内容最前面（文件路径下方）", () => {
		assert.ok(bar, "未找到面包屑栏");
		assert.strictEqual(view.contentEl.children[0], bar);
		assert.ok(bar.className.includes("bcn-sticky"), "默认应吸顶");
	});

	check("首项是文件名，其后是标题层级链", () => {
		assert.strictEqual(bar.textContent, "项目笔记›第一章›第一节›小节›▸");
		assert.strictEqual(itemsOf(bar)[0].className, "bcn-item bcn-page");
		assert.ok(itemsOf(bar)[3].className.includes("bcn-active"), "当前标题应高亮");
	});

	// ---------- 场景 2：悬浮查看同级 ----------
	const firstChapter = itemsOf(bar).find((i) => i.textContent === "第一章");
	firstChapter.dispatch("mouseenter");
	await sleep(260);
	check("悬浮某一级弹出同级标题（含当前项高亮）", () => {
		const p = popup();
		assert.ok(p, "未弹出菜单");
		assert.deepStrictEqual(popupTexts(p), ["第一章", "尾章"]);
		assert.ok(p.children[0].className.includes("is-active"));
	});

	// ---------- 场景 3：连续下钻（点列表项右侧的 ▸） ----------
	const drillBtn = popup().children[0].children.find((c) => c.className === "bcn-popup-next");
	check("有子标题的列表项才显示 ▸", () => assert.ok(drillBtn));
	drillBtn.dispatch("click");
	await sleep(60);

	check("点 ▸ 后该项成为面包屑末尾，并立即展开它的下一级", () => {
		bar = barOf(view);
		assert.strictEqual(bar.textContent, "项目笔记›第一章›▸");
		const p = popup();
		assert.ok(p, "下钻后应自动展开下一级菜单");
		assert.deepStrictEqual(popupTexts(p), ["第一节", "第二节"]);
	});

	// 再往下钻一层
	popup().children[0].children.find((c) => c.className === "bcn-popup-next").dispatch("click");
	await sleep(60);
	check("可继续向下钻取", () => {
		bar = barOf(view);
		assert.strictEqual(bar.textContent, "项目笔记›第一章›第一节›▸");
		assert.deepStrictEqual(popupTexts(popup()), ["小节"]);
	});

	// ---------- 场景 4：点菜单文本 = 跳转并回到跟随模式 ----------
	popup().children[0].children[0].dispatch("click");
	await sleep(60);
	check("点击菜单项文本跳转到该标题", () => {
		assert.deepStrictEqual(view.calls.filter((c) => c[0] === "setCursor").pop(), ["setCursor", 5]);
	});
	view.editor.cursor = { line: 7, ch: 0 }; // 模拟光标停在「细节A」
	await plugin.refresh();
	check("跳转后回到跟随模式，面包屑跟随光标", () => {
		bar = barOf(view);
		// 细节A 是最深一层，没有下级 → 末尾不显示 ▸
		assert.strictEqual(bar.textContent, "项目笔记›第一章›第一节›小节›细节A");
	});

	// ---------- 场景 5：末尾 ▸ = 下一级 ----------
	check("最深一层没有下级时不显示末尾 ▸", () => {
		assert.strictEqual(nextIconOf(bar), null);
	});

	view.editor.cursor = { line: 5, ch: 0 };
	await plugin.refresh();
	bar = barOf(view);
	nextIconOf(bar).dispatch("mouseenter");
	await sleep(260);
	check("回到「小节」后末尾 ▸ 列出其下级", () => {
		assert.deepStrictEqual(popupTexts(popup()), ["细节A", "细节B"]);
	});

	// ---------- 场景 6：点击面包屑某一级 = 跳转并截短路径 ----------
	itemsOf(bar)
		.find((i) => i.textContent === "第一节")
		.dispatch("click");
	await sleep(60);
	check("点击面包屑某一级：跳转并把路径截短到该级", () => {
		bar = barOf(view);
		assert.strictEqual(bar.textContent, "项目笔记›第一章›第一节›▸");
		assert.deepStrictEqual(view.calls.filter((c) => c[0] === "setCursor").pop(), ["setCursor", 3]);
	});

	// ---------- 场景 7：悬浮自动展开下一级（级联子菜单） ----------
	// 接续场景 6：面包屑停在 项目笔记›第一章›第一节›▸，光标在 line 3
	itemsOf(bar)
		.find((i) => i.textContent === "第一节")
		.dispatch("mouseenter");
	await sleep(260);
	check("悬浮面包屑某一级弹出同级菜单", () => {
		assert.deepStrictEqual(popupTexts(popup()), ["第一节", "第二节"]);
		assert.strictEqual(subPopups().length, 0, "此刻还没有子菜单");
	});

	// 默认（hoverExpandOnItem = true）：停在条目本体上就展开，不必瞄准 ▸
	popup().children[0].dispatch("mouseenter");
	await sleep(260);
	check("默认悬浮条目本体即展开下一级，不必停在 ▸ 上", () => {
		const subs = subPopups();
		assert.strictEqual(subs.length, 1, "应多出一层子菜单");
		assert.deepStrictEqual(popupTexts(subs[0]), ["小节"]);
		assert.ok(popup(), "根菜单不应被关闭");
		assert.ok(popup().children[0].className.includes("is-open"), "来源条目应标记为展开态");
	});

	// 子菜单里同样是停条目本体即可继续深入
	subPopups()[0].children[0].dispatch("mouseenter");
	await sleep(260);
	check("子菜单中可以继续向下悬浮展开", () => {
		const subs = subPopups();
		assert.strictEqual(subs.length, 2);
		assert.deepStrictEqual(popupTexts(subs[1]), ["细节A", "细节B"]);
	});

	// hover 到同层的另一个条目 → 收起已展开的子菜单
	popup().children[1].dispatch("mouseenter");
	await sleep(30);
	check("悬浮到别的条目时收起子菜单，根菜单保留", () => {
		assert.strictEqual(subPopups().length, 0);
		assert.ok(popup(), "根菜单仍在");
	});

	// 开关：关掉「悬浮条目本体即展开」后，只有精确停在 ▸ 上才展开
	plugin.settings.hoverExpandOnItem = false;
	popup().children[0].dispatch("mouseenter");
	await sleep(260);
	check("关闭开关后，悬浮条目本体不再展开下一级", () => {
		assert.strictEqual(subPopups().length, 0, "不应展开");
		assert.ok(popup(), "根菜单仍在");
	});

	nextBtnOf(popup().children[0]).dispatch("mouseenter");
	await sleep(260);
	check("关闭开关后，仍可悬浮 ▸ 展开下一级", () => {
		const subs = subPopups();
		assert.strictEqual(subs.length, 1);
		assert.deepStrictEqual(popupTexts(subs[0]), ["小节"]);
	});
	// 只悬浮 ▸ 的老路径也要能跳转，顺带把开关还原
	plugin.settings.hoverExpandOnItem = true;

	// 子菜单里点文本 = 跳转，并收起整条菜单链
	subPopups()[0].children[0].children[0].dispatch("click");
	await sleep(60);
	check("点击子菜单项：跳转到该标题并收起所有菜单", () => {
		assert.deepStrictEqual(view.calls.filter((c) => c[0] === "setCursor").pop(), ["setCursor", 5]);
		assert.strictEqual(popup(), null);
		assert.strictEqual(subPopups().length, 0);
	});

	// ---------- 场景 8：同标签页面 ----------
	const other = makeFile("工作/会议记录.md");
	const third = makeFile("工作/随笔.md");
	caches.set(other.path, { headings: [], tags: [], frontmatter: { tags: ["项目"] } });
	caches.set(third.path, { headings: [], tags: [], frontmatter: { tags: ["无关"] } });
	caches.set(file.path, { headings: HEADINGS, tags: [], frontmatter: { tags: ["项目"] } });
	const app2 = makeApp(view, [file, other, third], caches, opened);
	plugin.app = app2;
	await plugin.refresh();
	bar = barOf(view);
	itemsOf(bar)[0].dispatch("mouseenter");
	await sleep(260);
	check("悬浮文件名列出同标签的其他笔记（带命中标签）", () => {
		const p = popup();
		assert.ok(p, "未弹出同标签页面菜单");
		assert.deepStrictEqual(popupTexts(p), ["会议记录"]);
		assert.strictEqual(p.children[0].children[1].textContent, " #项目");
	});
	popup().children[0].children[0].dispatch("click");
	await sleep(30);
	check("点击同标签页面可打开该笔记", () => assert.deepStrictEqual(opened, ["工作/会议记录.md"]));

	// ---------- 场景 9：跳转后目标标题落在视口顶部（实时预览 / 源码模式） ----------
	plugin.app = app;
	view.editor.cursor = { line: 5, ch: 0 };
	await plugin.refresh();
	bar = barOf(view);
	const jumpTo = async (label) => {
		plugin.focalKey = null; // 清掉下钻状态，保证面包屑是完整的跟随链
		await plugin.refresh();
		const b = barOf(view);
		b.offsetHeight = 24; // 面包屑栏实际高度
		const item = itemsOf(b).find((i) => i.textContent === label);
		assert.ok(item, "面包屑里找不到该项：" + label);
		item.dispatch("click");
		await sleep(60);
	};

	// (a) 手动换算路径：coordsAtPos 可用
	view.scrollDOM.scrollTop = 0;
	view.cmState.coords = true;
	await jumpTo("第一节");
	check("跳转时目标行对齐视口顶部，且避开吸顶面包屑", () => {
		// 目标行最终视口 top = 容器(100) + 面包屑(24) + 间距(8) = 132 → scrollTop = 200 - 32 = 168
		assert.strictEqual(view.scrollDOM.scrollTop, 168);
		assert.deepStrictEqual(view.calls.filter((c) => c[0] === "scrollIntoView").pop(), [
			"scrollIntoView",
			false,
		]);
	});

	// (b) coordsAtPos 不可用时，退化到 lineBlockAt 换算，结果一致
	view.scrollDOM.scrollTop = 0;
	view.cmState.coords = false;
	await jumpTo("第一节");
	check("coordsAtPos 不可用时退化到 lineBlockAt，结果一致", () => {
		assert.strictEqual(view.scrollDOM.scrollTop, 168);
	});
	view.cmState.coords = true;

	// (c) 宿主提供 @codemirror/view 时，改走 CM 原生 y:"start"
	cmViewModule.EditorView.scrollIntoView = (pos, options) => ({
		__effect: "scrollIntoView",
		pos,
		options,
	});
	view.scrollDOM.scrollTop = 500; // 制造一个偏移，确认原生路径不再自己改 scrollTop
	await jumpTo("第一节");
	check("宿主提供 @codemirror/view 时走 CM 原生顶部对齐", () => {
		assert.strictEqual(view.cmState.dispatchCalls.length, 1);
		const effect = view.cmState.dispatchCalls[0].effects;
		assert.strictEqual(effect.__effect, "scrollIntoView");
		assert.strictEqual(effect.options.y, "start");
		assert.strictEqual(effect.options.yMargin, 32); // 面包屑 24 + 间距 8
		assert.strictEqual(view.scrollDOM.scrollTop, 500);
	});
	cmViewModule.EditorView.scrollIntoView = undefined;

	// ---------- 场景 10：阅读模式下同样对齐顶部 ----------
	const pFile = makeFile("工作/阅读模式.md");
	const pView = makePreviewView(pFile);
	const pCache = new Map([
		[
			pFile.path,
			{
				headings: [
					{ heading: "甲", level: 1, position: { start: { line: 0, offset: 0 } } },
					{ heading: "乙", level: 2, position: { start: { line: 4, offset: 30 } } },
				],
				tags: [],
				frontmatter: null,
			},
		],
	]);
	plugin.app = makeApp(pView, [pFile], pCache, opened);
	pView.contentEl.scrollTop = 950; // 已滚过「乙」
	await plugin.refresh();
	bar = barOf(pView);
	bar.offsetHeight = 24;
	check("阅读模式下按滚动位置定位当前标题", () => {
		// 「乙」是最后一个标题，没有下级 → 末尾不显示 ▸
		assert.strictEqual(bar.textContent, "阅读模式›甲›乙");
	});
	itemsOf(bar)
		.find((i) => i.textContent === "乙")
		.dispatch("click");
	await sleep(60);
	check("阅读模式跳转也把标题对齐到视口顶部", () => {
		// 「乙」内容坐标 900，减去面包屑 24 + 间距 8 → scrollTop = 868
		assert.strictEqual(pView.contentEl.scrollTop, 868);
	});

	// ---------- 场景 11：开关 ----------
	plugin.app = app;
	await plugin.toggleEnabled();
	check("关闭后移除面包屑栏，内容区恢复原状", () => {
		assert.strictEqual(barOf(view), null);
		assert.strictEqual(view.contentEl.children.length, 2); // 只剩 sourceView + cm-scroller
		assert.strictEqual(plugin.settings.enabled, false);
	});
	await plugin.toggleEnabled();
	await plugin.refresh();
	check("重新启用后恢复显示", () => {
		assert.ok(barOf(view));
		assert.strictEqual(plugin.settings.enabled, true);
	});

	// ---------- 场景 12：无标题笔记 ----------
	caches.set(file.path, { headings: undefined, tags: [], frontmatter: null });
	await plugin.refresh();
	check("无标题时只显示文件名，且不显示末尾 ▸", () => {
		bar = barOf(view);
		assert.strictEqual(bar.textContent, "项目笔记");
		assert.strictEqual(nextIconOf(bar), null);
	});

	// ---------- 场景 13：切到非笔记视图时保留占位，不来回消失 ----------
	check("切走之前面包屑在位", () => {
		assert.strictEqual(barOf(view), view.contentEl.children[0]);
	});
	const beforeSwitch = barOf(view).textContent;
	const offApp = {
		vault: app.vault,
		metadataCache: app.metadataCache,
		workspace: {
			getActiveViewOfType: () => null, // 新建标签页 / 看板这类视图
			getLeavesOfType: () => [],
			getLeaf: () => ({ openFile: async () => {} }),
			on: () => ({}),
		},
	};
	plugin.app = offApp;
	await plugin.refresh();
	check("没有活动笔记视图时面包屑仍然占位，不消失", () => {
		const b = barOf(view);
		assert.ok(b, "面包屑不应被移除");
		assert.strictEqual(b, view.contentEl.children[0], "应保持在最前面占位");
		assert.strictEqual(b.textContent, beforeSwitch, "内容保持切换前的样子");
	});

	// ---------- 场景 14：多个笔记视图各自一条 ----------
	const fileB = makeFile("工作/第二篇.md");
	const viewB = makeView(fileB);
	caches.set(fileB.path, { headings: [], tags: [], frontmatter: null });
	const twoApp = {
		vault: app.vault,
		metadataCache: app.metadataCache,
		workspace: {
			getActiveViewOfType: () => view,
			getLeavesOfType: () => [{ view }, { view: viewB }],
			getLeaf: () => ({ openFile: async () => {} }),
			on: () => ({}),
		},
	};
	plugin.app = twoApp;
	await plugin.refresh();
	check("每个笔记视图各自渲染一条面包屑", () => {
		assert.ok(barOf(view), "活动视图应有面包屑");
		assert.ok(barOf(viewB), "后台视图也应有面包屑");
		assert.strictEqual(barOf(viewB).textContent, "第二篇");
		assert.strictEqual(viewB.contentEl.children[0], barOf(viewB));
	});

	// ---------- 场景 15：视图关掉后回收它的面包屑 ----------
	plugin.app = {
		vault: app.vault,
		metadataCache: app.metadataCache,
		workspace: {
			getActiveViewOfType: () => view,
			getLeavesOfType: () => [{ view }],
			getLeaf: () => ({ openFile: async () => {} }),
			on: () => ({}),
		},
	};
	await plugin.refresh();
	check("视图关闭后它的面包屑被回收，活动视图的不受影响", () => {
		assert.strictEqual(barOf(viewB), null);
		assert.ok(barOf(view), "活动视图的面包屑仍在");
	});

	plugin.onunload();
	assert.strictEqual(barOf(view), null);

	console.log("\n全部 " + passed + " 项冒烟测试通过 ✅");
	process.exit(0);
})().catch((e) => {
	console.error("\n冒烟测试失败 ❌\n", e);
	process.exit(1);
});
