/**
 * Bring the four old plugins' settings into the merged one.
 *
 * Each module used to own its own data.json. Merged, they live under
 *   { "modules": { "<id>": { "enabled": true, "data": <the old data.json> } } }
 * and the host hands each module back exactly its own blob — so a module reads
 * its settings unchanged and never notices it was merged.
 *
 * Default is a DRY RUN: it prints what would be written and changes nothing.
 * Pass --apply to actually write. Old data.json files are copied to
 * *.bak-pre-merge first, and the old plugins are NOT deleted (switch them off
 * in Settings → Community plugins yourself, once you are happy).
 *
 * Usage:
 *   node scripts/migrate-settings.mjs                       # preview
 *   node scripts/migrate-settings.mjs --apply               # write
 *   node scripts/migrate-settings.mjs --vault <path> --apply
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const vaultFlag = args.indexOf("--vault");
const VAULT = vaultFlag >= 0 ? args[vaultFlag + 1] : "E:\\HOME\\BaiduSyncdisk";

/** Plugin folder -> module id in the merged plugin. */
const SOURCES = [
	{ dir: "obsidian-logseq", id: "logseq" },
	{ dir: "obsidian-browser", id: "browser" },
	{ dir: "obsidian-jupyter-notebook", id: "jupyter" },
	// note: the folder is obsidian-breadcrumb-nav but its manifest id is breadcrumb-nav
	{ dir: "obsidian-breadcrumb-nav", id: "breadcrumb" },
];
const TARGET = "obsidian-my-obsidian";

const pluginsDir = path.join(VAULT, ".obsidian", "plugins");
const targetDir = path.join(pluginsDir, TARGET);

if (!existsSync(pluginsDir)) {
	console.error(`找不到插件目录：${pluginsDir}`);
	process.exit(1);
}

const modules = {};
const report = [];

for (const src of SOURCES) {
	const dir = path.join(pluginsDir, src.dir);
	const dataPath = path.join(dir, "data.json");
	if (!existsSync(dataPath)) {
		report.push(`  ${src.id.padEnd(11)} ← ${src.dir}：没有 data.json（按默认设置启动）`);
		modules[src.id] = { enabled: true, data: {} };
		continue;
	}
	const raw = readFileSync(dataPath, "utf8");
	let data = {};
	try {
		data = JSON.parse(raw);
	} catch {
		report.push(`  ${src.id.padEnd(11)} ← ${src.dir}：data.json 不是合法 JSON，跳过`);
		modules[src.id] = { enabled: true, data: {} };
		continue;
	}
	const keys = Object.keys(data).length;
	report.push(
		`  ${src.id.padEnd(11)} ← ${src.dir}/data.json（${raw.length} 字节，${keys} 个设置键）`,
	);
	modules[src.id] = { enabled: true, data };
}

const out = { modules };
const json = JSON.stringify(out, null, 2);

console.log(`\n库：${VAULT}`);
console.log(`目标：${TARGET}/data.json\n`);
console.log("将写入：");
console.log(report.join("\n"));
console.log(`\n合计 ${json.length} 字节\n`);

if (!apply) {
	console.log("（dry run —— 什么都没写。加 --apply 才会落盘）");
	process.exit(0);
}

mkdirSync(targetDir, { recursive: true });
const targetData = path.join(targetDir, "data.json");
if (existsSync(targetData)) {
	copyFileSync(targetData, targetData + ".bak-" + Date.now());
	console.log("已备份已有的合并插件 data.json");
}
writeFileSync(targetData, json, "utf8");
console.log(`已写入 ${targetData}`);

// Keep a copy of each old file right next to itself, so nothing is lost even
// if a later step goes wrong.
for (const src of SOURCES) {
	const dataPath = path.join(pluginsDir, src.dir, "data.json");
	if (!existsSync(dataPath)) continue;
	const bak = dataPath + ".bak-pre-merge";
	if (!existsSync(bak)) {
		copyFileSync(dataPath, bak);
		console.log(`  备份 ${src.dir}/data.json → data.json.bak-pre-merge`);
	}
}

console.log(
	"\n完成。接下来在 Obsidian 里：设置 → 第三方插件 → 关掉旧的四个，打开 My Obsidian，然后重启 Obsidian。",
);
console.log("确认没问题之前，旧插件目录先别删。");
