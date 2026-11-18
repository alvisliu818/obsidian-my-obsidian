import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
	resolve: {
		// 单测 import 'obsidian' → 编译期 stub（真 API 只在 Obsidian 里）
		alias: [{ find: /^obsidian$/, replacement: path.resolve(__dirname, 'obsidian-stub.js') }],
	},
	test: {
		exclude: ['**/node_modules/**', '**/dist/**', '**/.{idea,git,cache,output,temp}/**'],
	},
});
