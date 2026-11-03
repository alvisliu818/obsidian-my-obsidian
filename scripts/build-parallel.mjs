/**
 * 并行构建编排（2026-11-04 用户需求：提升打包/编译速度）。
 *
 * 旧 `yarn build` 全串行：icons(3s) → tsc(16.5s) → esbuild(9.5s) ≈ 30s。
 * 两条互不依赖的流水线拆开跑：
 *   - 类型道：tsc -noEmit（增量缓存 .cache/tsc-noemit.tsbuildinfo，热跑大幅提速）
 *   - 产物道：build:icons → esbuild production（icons 产出的 svg 注册表要进 bundle，
 *     所以这两步保持先后）
 * 墙钟 ≈ max(类型道, 产物道)。任一道失败整体失败（退出码非 0），输出按行加
 * [tsc]/[esb] 前缀交错可读。
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(`${ROOT}/.cache`, { recursive: true });

/** 跑一条命令，逐行加前缀转发到主进程 stdout，返回退出码。 */
function run(label, command) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const child = spawn(command, { shell: true, cwd: ROOT, env: process.env });
		let failed = false;
		const pipe = (src, dst) => {
			let buf = '';
			src.setEncoding('utf8');
			src.on('data', (chunk) => {
				buf += chunk;
				const lines = buf.split(/\r?\n/);
				buf = lines.pop() ?? '';
				for (const line of lines) dst(`[${label}] ${line}`);
			});
			src.on('end', () => {
				if (buf) dst(`[${label}] ${buf}`);
			});
		};
		pipe(child.stdout, (l) => process.stdout.write(l + '\n'));
		pipe(child.stderr, (l) => {
			if (l.trim()) process.stderr.write(l + '\n');
		});
		child.on('close', (code) => {
			if (code !== 0) failed = true;
			process.stdout.write(`[${label}] exit=${code} ${(Date.now() - t0) / 1000}s\n`);
			resolve(code);
		});
	});
}

console.log('[build] 类型道(tsc 增量) ∥ 产物道(icons→esbuild) 并行开始');
const t0 = Date.now();
const [tscCode, esbCode] = await Promise.all([
	run('tsc', 'yarn tsc -noEmit -skipLibCheck -incremental -tsBuildInfoFile .cache/tsc-noemit.tsbuildinfo'),
	run('esb', 'yarn build:icons && yarn node esbuild.mjs production'),
]);
const total = ((Date.now() - t0) / 1000).toFixed(1);
if (tscCode !== 0 || esbCode !== 0) {
	console.error(`[build] 失败（tsc=${tscCode} esb=${esbCode}），总耗时 ${total}s`);
	process.exit(1);
}
console.log(`[build] 完成 ${total}s`);
