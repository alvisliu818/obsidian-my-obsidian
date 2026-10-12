/**
 * Deploy the merged plugin into a vault.
 *
 * What has to travel, and why:
 *
 *  - main.js / manifest.json / styles.css — the plugin itself.
 *  - pty-helper/ — the logseq module's terminal needs a real OS pty, which
 *    means a native module (node-pty). That cannot be bundled into main.js,
 *    so it lives in its own folder that a system node.exe spawns. It is NOT
 *    in git (31MB of platform binaries); this script takes it from wherever
 *    it already lives — the old logseq plugin folder — and copies it next to
 *    the merged plugin.
 *
 * Without that second step the terminal comes up as an empty box with
 * "PTY helper 启动失败" in it, which is exactly how the bug looked before the
 * view started reporting its real shell instead of a hard-coded "PowerShell".
 *
 * Usage:
 *   node scripts/deploy.mjs --vault "<库路径>" [--from "<旧 logseq 插件目录>"]
 */
import { existsSync, mkdirSync, cpSync } from "node:fs";
import path from "node:path";

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

// ---- pty-helper (the terminal's native helper) ----
// Where to look for it, in order: an explicit --from, then any old logseq
// plugin folder in the same vault (the merge was installed alongside them).
const candidates = [];
if (fromFlag >= 0 && args[fromFlag + 1]) candidates.push(args[fromFlag + 1]);
for (const dir of ["obsidian-logseq", "obsidian-logseq-public"]) {
	candidates.push(path.join(VAULT, ".obsidian", "plugins", dir));
}

let helper = null;
for (const c of candidates) {
	if (existsSync(path.join(c, "pty-helper", "pty-helper.js"))) {
		helper = path.join(c, "pty-helper");
		break;
	}
}

if (helper) {
	cpSync(helper, path.join(TARGET, "pty-helper"), { recursive: true });
	console.log(`  pty-helper/  ← ${helper}`);
} else {
	console.warn(
		"  ! 没找到 pty-helper（终端会打不开）。用 --from 指定旧 logseq 插件目录，\n" +
			"    或手动把 pty-helper/ 拷到插件目录下。",
	);
}

console.log(`\n已部署到 ${TARGET}`);
console.log("如果改动了注册的视图/扩展名，重启 Obsidian 生效。");
