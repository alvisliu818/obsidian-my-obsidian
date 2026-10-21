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
import { existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

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

const ROOT = path.resolve(import.meta.dirname, "..");
const TARGET = path.join(VAULT, ".obsidian", "plugins", "obsidian-my-obsidian");

if (!existsSync(TARGET)) mkdirSync(TARGET, { recursive: true });

for (const f of ["main.js", "manifest.json", "styles.css"]) {
	const src = path.join(ROOT, f);
	if (!existsSync(src)) {
		console.error(`缺少 ${f} —— 先 npm run build`);
		process.exit(1);
	}
	cpSync(src, path.join(TARGET, f));
	console.log(`  ${f}`);
}

// ---- Monaco 运行时资源 ----
// logseq 模块现在用 Monaco(开源 VS Code 内核)做代码编辑器。Monaco 的 worker
// 与 CSS 不能打进 main.js:worker 要经 `new Worker(app:// URL)` 起(且 app://
// 跨源,得用 blob 包 importScripts),CSS 则因为 Obsidian 的 CSP 不含 app:// 的
// style-src,`<link rel=stylesheet>` 会被拦(控制台 security error),只能读内容
// 注入内联 <style>。两者都在插件目录里按 manifest.dir 相对路径取。
// 漏了它们 = Monaco 布局 CSS 全不生效、worker 起不来,表现为编辑器堆叠/无高亮。
for (const f of ["monaco.css"]) {
	const src = path.join(ROOT, "modules", "logseq", f);
	if (!existsSync(src)) {
		console.error(`缺少 modules/logseq/${f} —— Monaco 样式不会生效`);
		process.exit(1);
	}
	cpSync(src, path.join(TARGET, f));
	console.log(`  ${f}`);
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

// ---- basedpyright(语言服务)----
// 块内代码块的语言服务走这个:随插件部署,启动时不依赖 PATH / 网络 / uv。
// 整个 basedpyright 目录都要带 —— dist/pyright-langserver.js 运行时读
// 同目录的 typeshed-fallback(lspHost 的 resolvePyrightLaunch 优先用它)。
// 36MB,和 pty-helper 一样不进 git。
{
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

// ---- pty-helper (the terminal's native helper) ----
// Where to look for it, in order: an explicit --from, then any old logseq
// plugin folder in the same vault (the merge was installed alongside them),
// then the obsidian-myterminal repo sitting next to this one — it carries the
// same helper with the .pdb debug symbols already stripped (3.8M instead of
// 31M; the symbols are build artifacts, never loaded at runtime).
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

console.log(`\n已部署到 ${TARGET}`);
console.log("如果改动了注册的视图/扩展名，重启 Obsidian 生效。");
