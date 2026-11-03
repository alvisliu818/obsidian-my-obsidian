/**
 * Deploy the merged plugin into a vault.
 *
 * What has to travel, and why:
 *
 *  - main.js / manifest.json / styles.css — the plugin itself.
 *  - pty-helper/ — the logseq module's terminal needs a real OS pty, which
 *    means a native module (node-pty). That cannot be bundled into main.js,
 *    so it lives in its own folder that a system node.exe spawns. It is NOT
 *    in git (platform binaries); this script takes it from wherever it
 *    already lives — the old logseq plugin folder, or the obsidian-myterminal
 *    repo next to this one (same helper, .pdb stripped) — and copies it next
 *    to the merged plugin.
 *
 * Without that second step the terminal comes up as an empty box with
 * "PTY helper 启动失败" in it, which is exactly how the bug looked before the
 * view started reporting its real shell instead of a hard-coded "PowerShell".
 *
 * Usage:
 *   node scripts/deploy.mjs --vault "<库路径>" [--from "<旧 logseq 插件目录>"]
 */
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, readFileSync, openSync, writeSync, closeSync, fsyncSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const vaultFlag = args.indexOf("--vault");
const fromFlag = args.indexOf("--from");
const VAULT = (vaultFlag >= 0 ? args[vaultFlag + 1] : process.env.OBSIDIAN_VAULT) ?? "";

if (!VAULT) {
	console.error(
		'需要指定库路径：\n  node scripts/deploy.mjs --vault "E:\\\\你的库"\n或设置环境变量 OBSIDIAN_VAULT。',
	);
	process.exit(1);
}

// --only main.js,styles.css —— 增量部署:只替换列出的单文件,跳过所有
// 目录段(basedpyright/pty-helper/monaco-workers/better-sqlite3)。主库日常
// 更新用:那些大目录早就在位且不随功能改动,网盘上重写它们只有风险没收益。
const onlyFlag = args.indexOf("--only");
const only = onlyFlag >= 0
	? (args[onlyFlag + 1] || "").split(",").map((s) => s.trim()).filter(Boolean)
	: null;
const wanted = (f) => !only || only.includes(f);

const failures = [];

/**
 * 原子写单文件:tmp 落盘 + fsync + rename 替换 + sha256 回读校验。
 *
 * 为什么不用 cpSync:主库在百度网盘同步目录里,minifilter 对**原地直写**
 * 会把 main.js 写成全零块(实测损坏过)。tmp+rename 让同步器只看到一次
 * 原子替换;回读校验兜底,不一致立刻报错,不把哑弹留在库里。
 */
function atomicWriteFile(src, dst) {
	const label = path.basename(dst);
	const data = readFileSync(src);
	const want = createHash("sha256").update(data).digest("hex");
	const tmp = `${dst}.deploy-tmp-${process.pid}`;
	const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	for (let attempt = 1; attempt <= 2; attempt++) {
		let fd = -1;
		try {
			fd = openSync(tmp, "w");
			writeSync(fd, data);
			fsyncSync(fd);
		} finally {
			if (fd >= 0) closeSync(fd);
		}
		try {
			renameSync(tmp, dst);
		} catch (e) {
			try { unlinkSync(tmp); } catch { /* 下次覆盖 */ }
			// 运行中的 Obsidian 可能短暂锁目标文件:退避后重试一次
			if (attempt === 1 && /EBUSY|EPERM|EACCES/i.test(String(e?.code || "") + String(e?.message || ""))) {
				wait(1500);
				continue;
			}
			failures.push(`${label}: ${e?.message || e}`);
			console.error(`  ! ${label} 写入失败: ${e?.message || e}`);
			return false;
		}
		const got = createHash("sha256").update(readFileSync(dst)).digest("hex");
		if (got !== want) {
			failures.push(`${label}: sha256 回读不一致 (want ${want.slice(0, 8)}, got ${got.slice(0, 8)})`);
			console.error(`  ! ${label} sha256 回读不一致 —— 网盘写入不可信,请重试`);
			return false;
		}
		console.log(`  ${label}  (sha256 ${want.slice(0, 8)} ✓)`);
		return true;
	}
	return false;
}

const ROOT = path.resolve(import.meta.dirname, "..");
const TARGET = path.join(VAULT, ".obsidian", "plugins", "obsidian-my-obsidian");

if (!existsSync(TARGET)) mkdirSync(TARGET, { recursive: true });

for (const f of ["main.js", "manifest.json", "styles.css"]) {
	if (!wanted(f)) continue;
	const src = path.join(ROOT, f);
	if (!existsSync(src)) {
		console.error(`缺少 ${f} —— 先 npm run build`);
		process.exit(1);
	}
	atomicWriteFile(src, path.join(TARGET, f));
}

// ---- Monaco 运行时资源 ----
// logseq 模块现在用 Monaco(开源 VS Code 内核)做代码编辑器。Monaco 的 worker
// 与 CSS 不能打进 main.js:worker 要经 `new Worker(app:// URL)` 起(且 app://
// 跨源,得用 blob 包 importScripts),CSS 则因为 Obsidian 的 CSP 不含 app:// 的
// style-src,`<link rel=stylesheet>` 会被拦(控制台 security error),只能读内容
// 注入内联 <style>。两者都在插件目录里按 manifest.dir 相对路径取。
// 漏了它们 = Monaco 布局 CSS 全不生效、worker 起不来,表现为编辑器堆叠/无高亮。
if (!only) {
	for (const f of ["monaco.css"]) {
		const src = path.join(ROOT, "modules", "logseq", f);
		if (!existsSync(src)) {
			console.error(`缺少 modules/logseq/${f} —— Monaco 样式不会生效`);
			process.exit(1);
		}
		atomicWriteFile(src, path.join(TARGET, f));
	}
	{
		const src = path.join(ROOT, "modules", "logseq", "monaco-workers");
		if (!existsSync(src)) {
			console.error("缺少 modules/logseq/monaco-workers/ —— Monaco worker 起不来");
			process.exit(1);
		}
		cpSync(src, path.join(TARGET, "monaco-workers"), { recursive: true });
		console.log(`  monaco-workers/`);
	}
}

// ---- basedpyright(语言服务；宿主 = modules/code-editor 的 lsp/，2026-10-27 拆分)----
// 块内代码块的语言服务走这个:随插件部署,启动时不依赖 PATH / 网络 / uv。
// 整个 basedpyright 目录都要带 —— dist/pyright-langserver.js 运行时读
// 同目录的 typeshed-fallback(lspHost 的 resolvePyrightLaunch 优先用它)。
// 36MB,和 pty-helper 一样不进 git。
if (!only) {
	// PnP:依赖躺在全局 cache 的 zip 里,必须 unplugged(见 package.json
	// dependenciesMeta)才能整目录复制;没有 PnP 时回落到老 node_modules 布局。
	let basedpyrightDir;
	try {
		const pnpFile = path.join(ROOT, ".pnp.cjs");
		if (existsSync(pnpFile)) {
			createRequire(import.meta.url)(pnpFile).setup();
			createRequire(path.join(ROOT, "package.json")).resolve("basedpyright/package.json");
		}
		basedpyrightDir = path.dirname(
			createRequire(path.join(ROOT, "index.js")).resolve("basedpyright/package.json"),
		);
	} catch {
		basedpyrightDir = path.join(ROOT, "node_modules", "basedpyright");
	}
	if (!existsSync(basedpyrightDir)) {
		console.error(`缺少 basedpyright 依赖目录(${basedpyrightDir})—— 先 yarn install`);
		process.exit(1);
	}
	cpSync(basedpyrightDir, path.join(TARGET, "basedpyright"), { recursive: true, verbatimSymlinks: true });
	console.log(`  basedpyright/`);
}

// ---- syfe-kernel.py(持久 Python 内核本体)----
// notebook 的「运行」完全依赖它:运行时以子进程拉起这个脚本。它既不是源码
// ( esbuild 只在**独立**构建 jupyter 时才复制到模块根目录)、也必须跟插件同
// 目录,所以这里从源 tools/ 取。漏了它 = 点运行弹「内核不可用」,工具栏
// 内核状态 hover 显示「找不到内核脚本」。
if (wanted("syfe-kernel.py")) {
	const src = path.join(ROOT, "modules", "jupyter", "tools", "syfe-kernel.py");
	if (!existsSync(src)) {
		console.error("缺少 modules/jupyter/tools/syfe-kernel.py —— notebook 无法运行单元格");
		process.exit(1);
	}
	atomicWriteFile(src, path.join(TARGET, "syfe-kernel.py"));
}

// ---- pty-helper (the terminal's native helper) ----
// Where to look for it, in order: an explicit --from, then any old logseq
// plugin folder in the same vault (the merge was installed alongside them),
// then the obsidian-myterminal repo sitting next to this one — it carries the
// same helper with the .pdb debug symbols already stripped (3.8M instead of
// 31M; the symbols are build artifacts, never loaded at runtime).
if (!only) {
	const candidates = [];
	if (fromFlag >= 0 && args[fromFlag + 1]) candidates.push(args[fromFlag + 1]);
	for (const dir of ["obsidian-logseq", "obsidian-logseq-public"]) {
		candidates.push(path.join(VAULT, ".obsidian", "plugins", dir));
	}
	candidates.push(path.resolve(ROOT, "..", "obsidian-myterminal"));

	let helper = null;
	for (const c of candidates) {
		if (existsSync(path.join(c, "pty-helper", "pty-helper.js"))) {
			helper = path.join(c, "pty-helper");
			break;
		}
	}

	if (helper) {
		// 找到源就整体替换：cpSync 不删源里没有的文件，不清掉目标里的旧 .pdb
		// 副本会永远比源胖 24MB。
		rmSync(path.join(TARGET, "pty-helper"), { recursive: true, force: true });
		cpSync(helper, path.join(TARGET, "pty-helper"), { recursive: true });
		console.log(`  pty-helper/  ← ${helper}`);
	} else if (existsSync(path.join(TARGET, "pty-helper", "pty-helper.js"))) {
		// 目标已有一份（上次部署带过来的）——够了，别再喊。
		console.log("  pty-helper/ 已在目标目录（未找到源，跳过）");
	} else {
		console.warn(
			"  ! 没找到 pty-helper（终端会打不开）。用 --from 指定旧 logseq 插件目录，\n" +
				"    或手动把 pty-helper/ 拷到插件目录下。",
		);
	}
}

// ---- index-daemon(索引守护进程) + better-sqlite3 边车 ----
// 守护进程是独立 node 进程,无 PnP——better-sqlite3(原生模块,FTS5 预编译)
// 以传统 node_modules 布局放插件目录,从 unplugged 取(构建产物不进 git)。
if (wanted("index-daemon.cjs")) {
	const daemonJs = path.join(ROOT, "index-daemon.cjs");
	if (existsSync(daemonJs)) {
		atomicWriteFile(daemonJs, path.join(TARGET, "index-daemon.cjs"));
	} else {
		console.warn("  ! 缺少 index-daemon.cjs(先 yarn node esbuild.mjs production)");
	}
}

if (!only) {
	const unplugged = path.join(ROOT, ".yarn", "unplugged");
	const bs3Dir = existsSync(unplugged)
		? readdirSync(unplugged).find((d) => d.startsWith("better-sqlite3-npm-"))
		: null;
	if (bs3Dir) {
	const src = path.join(unplugged, bs3Dir, "node_modules", "better-sqlite3");
	const dst = path.join(TARGET, "node_modules", "better-sqlite3");
	rmSync(dst, { recursive: true, force: true });
	cpSync(src, dst, {
		recursive: true,
		// 只带运行时需要的:lib/index/package.json + 编译产物。prebuild-install
		// 是装包期工具,deps/** 是 sqlite 源码(几 MB),都不要。
		filter: (f) => {
			const rel = path.relative(src, f).split(path.sep).join("/");
			return (
				rel === "" ||
				rel === "package.json" ||
				rel === "index.js" ||
				rel === "LICENSE" ||
				rel === "lib" ||
				rel === "build" ||
				rel.startsWith("lib/") ||
				rel.startsWith("build/") ||
				rel.startsWith("deps/license")
			);
		},
	});
	// better-sqlite3 的运行时依赖 bindings(定位 .node)——纯 JS,住在全局
	// cache zip 里(不 unplugged),解包到边车 node_modules。
	const cacheDir = path.join(ROOT, "..", "..", ".yarn-global", "cache");
	const bindingsZip = existsSync(cacheDir)
		? readdirSync(cacheDir).find((d) => d.startsWith("bindings-npm-") && d.endsWith(".zip"))
		: null;
	if (bindingsZip) {
		const bDst = path.join(TARGET, "node_modules", "bindings");
		const tmp = path.join(TARGET, "node_modules", ".bindings-tmp");
		rmSync(bDst, { recursive: true, force: true });
		rmSync(tmp, { recursive: true, force: true });
		// yarn cache zip 内部是 node_modules/<pkg>/ 布局
		execSync(
			`powershell -NoProfile -Command "Expand-Archive -Force -Path '${path.join(cacheDir, bindingsZip)}' -DestinationPath '${tmp}'"`,
			{ stdio: "ignore" },
		);
		cpSync(path.join(tmp, "node_modules", "bindings"), bDst, { recursive: true });
		rmSync(tmp, { recursive: true, force: true });
		// bindings 的运行时依赖 file-uri-to-path(纯 JS,同住 cache zip)
		const f2pZip = readdirSync(cacheDir).find(
			(d) => d.startsWith("file-uri-to-path-npm-") && d.endsWith(".zip"),
		);
		if (f2pZip) {
			const fDst = path.join(TARGET, "node_modules", "file-uri-to-path");
			const fTmp = path.join(TARGET, "node_modules", ".f2p-tmp");
			rmSync(fDst, { recursive: true, force: true });
			rmSync(fTmp, { recursive: true, force: true });
			execSync(
				`powershell -NoProfile -Command "Expand-Archive -Force -Path '${path.join(cacheDir, f2pZip)}' -DestinationPath '${fTmp}'"`,
				{ stdio: "ignore" },
			);
			cpSync(path.join(fTmp, "node_modules", "file-uri-to-path"), fDst, { recursive: true });
			rmSync(fTmp, { recursive: true, force: true });
		}
		console.log("  node_modules/better-sqlite3 + bindings  (FTS5)");
	} else {
		console.warn("  ! bindings 未找到(better-sqlite3 运行时定位 .node 需要)");
	}
	} else {
		console.warn("  ! better-sqlite3 未 unplugged(守护进程将回落 node:sqlite,无 FTS5)");
	}
}

console.log(`\n已部署到 ${TARGET}`);
if (failures.length > 0) {
	console.error(`\n${failures.length} 个文件写入失败:`);
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}
console.log("如果改动了注册的视图/扩展名，重启 Obsidian 生效。");
