/**
 * 极简 DOM / Obsidian 运行桩，用真实构建产物 main.js 跑一遍插件生命周期。
 * 只实现插件实际用到的那部分 API，不追求规范完整。
 */
"use strict";

// ---------- 迷你 DOM ----------
class El {
	constructor(tag) {
		this.tagName = String(tag || "div").toUpperCase();
		this.children = [];
		this.parentElement = null;
		this.className = "";
		this.id = "";
		this.title = "";
		this.style = {};
		this.dataset = {};
		this._text = "";
		this._listeners = {};
		this.offsetWidth = 200;
		this.offsetHeight = 100;
		this.scrollTop = 0;
		this.scrollHeight = 0;
		this.clientHeight = 0;
		this._overflowY = "visible";
		this._rect = null; // 可设为对象或函数，用于模拟视口坐标
	}

	get firstChild() {
		return this.children[0] || null;
	}

	set textContent(value) {
		this._text = String(value);
		if (value === "") this.children = [];
	}

	get textContent() {
		if (this.children.length) return this.children.map((c) => c.textContent).join("");
		return this._text;
	}

	get classList() {
		const self = this;
		const set = () => new Set(self.className.split(/\s+/).filter(Boolean));
		return {
			add: (...cls) => {
				const s = set();
				cls.forEach((c) => s.add(c));
				self.className = Array.from(s).join(" ");
			},
			remove: (...cls) => {
				const s = set();
				cls.forEach((c) => s.delete(c));
				self.className = Array.from(s).join(" ");
			},
			contains: (c) => set().has(c),
		};
	}

	appendChild(child) {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}

	insertBefore(child, ref) {
		child.parentElement = this;
		const idx = ref ? this.children.indexOf(ref) : 0;
		this.children.splice(idx < 0 ? 0 : idx, 0, child);
		return child;
	}

	remove() {
		if (!this.parentElement) return;
		const idx = this.parentElement.children.indexOf(this);
		if (idx >= 0) this.parentElement.children.splice(idx, 1);
		this.parentElement = null;
	}

	addEventListener(type, fn) {
		(this._listeners[type] = this._listeners[type] || []).push(fn);
	}

	removeEventListener(type, fn) {
		const list = this._listeners[type] || [];
		const i = list.indexOf(fn);
		if (i >= 0) list.splice(i, 1);
	}

	dispatch(type, props) {
		const evt = Object.assign(
			{
				type,
				target: this,
				stopPropagation() {},
				preventDefault() {},
			},
			props || {}
		);
		(this._listeners[type] || []).slice().forEach((fn) => fn(evt));
		return evt;
	}

	contains(node) {
		if (node === this) return true;
		return this.children.some((c) => c.contains(node));
	}

	matches(sel) {
		return String(sel)
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.some((s) => {
				if (s.startsWith(".")) return this.className.split(/\s+/).includes(s.slice(1));
				if (s.startsWith("#")) return this.id === s.slice(1);
				return this.tagName === s.toUpperCase();
			});
	}

	closest(sel) {
		let cur = this;
		while (cur) {
			if (cur.matches && cur.matches(sel)) return cur;
			cur = cur.parentElement;
		}
		return null;
	}

	querySelectorAll(sel) {
		const out = [];
		this.children.forEach((c) => {
			if (c.matches(sel)) out.push(c);
			out.push(...c.querySelectorAll(sel));
		});
		return out;
	}

	querySelector(sel) {
		return this.querySelectorAll(sel)[0] || null;
	}

	getBoundingClientRect() {
		const r = typeof this._rect === "function" ? this._rect() : this._rect;
		return r || { top: 0, bottom: 10, left: 0, right: 200, width: 200, height: 10 };
	}

	scrollTo(opts) {
		const top = typeof opts === "number" ? opts : opts && opts.top;
		if (typeof top === "number") this.scrollTop = top;
	}
}

function installDom() {
	const document = new El("document");
	document.body = new El("body");
	document.head = new El("head");
	document.createElement = (tag) => new El(tag);
	document.contains = (node) => document.body.contains(node);

	const window = {
		innerWidth: 1200,
		innerHeight: 800,
		addEventListener() {},
		removeEventListener() {},
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (id) => clearTimeout(id),
		requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
		cancelAnimationFrame: (id) => clearTimeout(id),
	};

	global.window = window;
	global.document = document;
	global.getComputedStyle = (el) => ({ overflowY: el._overflowY || "visible" });
	global.HTMLElement = El;
	global.Element = El;
	global.Node = El;
	global.requestAnimationFrame = window.requestAnimationFrame;
	global.cancelAnimationFrame = window.cancelAnimationFrame;
	return { document, window, El };
}

// ---------- Obsidian 运行桩 ----------
function installObsidianStub() {
	const Module = require("module");

	class Plugin {
		constructor(app, manifest) {
			this.app = app;
			this.manifest = manifest;
			this.commands = [];
			this.unloaders = [];
		}
		addCommand(cmd) {
			this.commands.push(cmd);
			return cmd;
		}
		addRibbonIcon(icon, title, cb) {
			this.ribbonCallback = cb;
			return document.createElement("div");
		}
		addSettingTab(tab) {
			this.settingTab = tab;
		}
		registerEvent() {}
		register(cb) {
			this.unloaders.push(cb);
		}
		async loadData() {
			return null;
		}
		async saveData(data) {
			this.savedData = data;
		}
	}

	class MarkdownView {}
	class TFile {
		constructor(path) {
			this.path = path;
			this.basename = String(path).replace(/^.*\//, "").replace(/\.md$/, "");
		}
	}
	class PluginSettingTab {
		constructor(app, plugin) {
			this.app = app;
			this.plugin = plugin;
			this.containerEl = new El("div");
		}
	}
	class Setting {
		constructor(el) {
			this.el = el;
		}
		setName() {
			return this;
		}
		setDesc() {
			return this;
		}
		addToggle() {
			return this;
		}
		addText() {
			return this;
		}
		addDropdown() {
			return this;
		}
	}

	const stub = {
		Plugin,
		MarkdownView,
		TFile,
		PluginSettingTab,
		Setting,
		addIcon() {},
		setIcon(el, id) {
			el.dataset.icon = id;
		},
	};

	// @codemirror/view 桩：EditorView.scrollIntoView 默认不提供 → 插件走手动换算路径；
	// 测试里赋值后，后续跳转会改走 CM 原生路径。
	const cmViewModule = { EditorView: { scrollIntoView: undefined } };

	const originalLoad = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === "obsidian") return stub;
		if (request === "@codemirror/view") return cmViewModule;
		return originalLoad.apply(this, arguments);
	};

	return { stub, cmViewModule };
}

module.exports = { installDom, installObsidianStub, El };
