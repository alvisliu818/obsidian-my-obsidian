/**
 * 生成 modules/md-editor/src/features/emojiShortcodesData.ts
 *
 * 数据源:emojibase-data v18 的 en/shortcodes/github.json(GitHub/gemoji
 * shortcode 全集,MIT)。key 是 Unicode hexcode(可含 ZWJ/FE0F 段),
 * value 是主 shortcode;本脚本反转成 shortcode → 字符的映射并按名字排序。
 *
 * 用法:
 *   node scripts/gen-emoji-shortcodes.mjs <emojibase-data 解包目录>
 *   (目录下应有 en/shortcodes/github.json;默认取 tmp/emojibase-dl/package)
 *   下载解包:curl -o tmp/emojibase-dl/emojibase-data.tgz \
 *     https://registry.npmjs.org/emojibase-data/-/emojibase-data-18.0.0.tgz
 *     tar -xzf ... 沙箱无外网时手动执行
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = process.argv[2]
	? resolve(process.argv[2])
	: resolve(here, '../tmp/emojibase-dl/package');
const src = resolve(srcDir, 'en/shortcodes/github.json');
const out = resolve(here, '../modules/md-editor/src/features/emojiShortcodesData.ts');

const raw = JSON.parse(readFileSync(src, 'utf8'));
// hexcode → shortcode。同 hexcode 多名时取 JSON 里的第一个(主名)。
const byName = new Map();
for (const [hex, names] of Object.entries(raw)) {
	for (const name of Array.isArray(names) ? names : [names]) {
		if (!byName.has(name)) {
			const char = String.fromCodePoint(...hex.split('-').map((h) => parseInt(h, 16)));
			byName.set(name, char);
		}
	}
}

const lines = [...byName.entries()]
	.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	.map(([name, char]) => `\t${JSON.stringify(name)}: ${JSON.stringify(char)},`);

const body = `/**
 * GitHub 风格 emoji shortcode → 字符映射(${byName.size} 条,gemoji 全集)。
 *
 * **生成文件** — 由 scripts/gen-emoji-shortcodes.mjs 产出,勿手改。
 * 数据源:emojibase-data v18.0.0 en/shortcodes/github.json(MIT,即
 * GitHub gemoji 命名),反转 hexcode→name 并按名字排序。再生成:
 *   node scripts/gen-emoji-shortcodes.mjs <emojibase-data 解包目录>
 * 运行时由 features/emojiShortcodes.ts 消费(渲染态后处理器 + 编辑态
 * live-preview 装饰)。
 */
export const EMOJI_SHORTCODES: Readonly<Record<string, string>> = {
${lines.join('\n')}
};
`;

writeFileSync(out, body, 'utf8');
console.log(`wrote ${out} (${byName.size} shortcodes, ${(body.length / 1024).toFixed(0)} KB)`);
