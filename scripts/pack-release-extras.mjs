/**
 * 打 BRAT 发布的运行附属 zip(2026-11-20):市场/BRAT 只装三件套,附属经
 * release assets 分发,main.js 首启自动下载解压(src/remoteBootstrap.ts)。
 *
 * 用法:node scripts/pack-release-extras.mjs <完整部署的插件目录> <输出目录>
 *   例:node scripts/pack-release-extras.mjs "E:/HOME/Local/logseq-e2e-vault/.obsidian/plugins/obsidian-my-obsidian-full-backup" "E:/HOME/Code/obsidian/obsidian-my-obsidian/dist-release"
 *
 * 产物:
 *   extras.zip — lazy/ monaco-workers/ monaco.css MyKernel.cjs assets/
 *                syfe-kernel.py community-catalog.json media-kinds.json
 *                tiny-preload.js pty-helper/ traybin/ node_modules/
 *   lsp.zip    — basedpyright/
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';

const [from, outDir] = process.argv.slice(2);
if (!from || !outDir) {
	console.error('用法: node scripts/pack-release-extras.mjs <部署好的插件目录> <输出目录>');
	process.exit(1);
}
mkdirSync(outDir, { recursive: true });

/** zip 一棵目录/单文件树,path→bytes(排除用户数据)。 */
function collect(relList) {
	const tree = {};
	for (const rel of relList) {
		const full = path.join(from, rel);
		try {
			const st = statSync(full);
			if (st.isDirectory()) {
				const walk = (dir, prefix) => {
					for (const e of readdirSync(dir, { withFileTypes: true })) {
						if (e.isFile()) tree[prefix + e.name] = readFileSync(path.join(dir, e.name));
						else if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`);
					}
				};
				walk(full, `${rel}/`);
			} else if (st.isFile()) tree[rel] = readFileSync(full);
		} catch (e) {
			console.warn(`  ! 跳过 ${rel}: ${String(e).slice(0, 80)}`);
		}
	}
	return tree;
}

const extras = collect([
	'lazy',
	'monaco-workers',
	'monaco.css',
	'MyKernel.cjs',
	'assets',
	'syfe-kernel.py',
	'community-catalog.json',
	'media-kinds.json',
	'tiny-preload.js',
	'pty-helper',
	'traybin',
	'node_modules',
]);
const lsp = collect(['basedpyright']);

for (const [name, tree] of [['extras.zip', extras], ['lsp.zip', lsp]]) {
	const count = Object.keys(tree).length;
	if (count === 0) {
		console.warn(`  ! ${name}: 无文件,跳过`);
		continue;
	}
	const zipped = zipSync(tree, { level: 6 });
	writeFileSync(path.join(outDir, name), zipped);
	console.log(`${name}: ${count} 文件, ${(zipped.length / 1048576).toFixed(1)} MB`);
}
console.log('完成 →', outDir);
