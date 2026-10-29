/**
 * Edge-case sample vault generator.
 *
 * Creates test/fixtures/edge-vault with a minimal .obsidian config and one
 * file per hostile input class: empty file, broken frontmatter, org-mode
 * properties, huge file (generated), special characters, circular block
 * embed, deep nesting, CRLF, mixed indentation, unterminated code fence,
 * duplicate block ids.
 *
 * Run:  node tests/fixtures/make-edge-vault.mjs
 * (huge.md is only written when missing or smaller than the target, so the
 *  repo checkout stays light until tests need it.)
 */

import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vault = join(here, 'edge-vault');

mkdirSync(join(vault, '.obsidian', 'plugins', 'obsidian-logseq'), { recursive: true });
mkdirSync(join(vault, 'journals'), { recursive: true });

// --- minimal .obsidian config (vault opens without onboarding dialogs) ---
writeFileSync(
  join(vault, '.obsidian', 'app.json'),
  JSON.stringify({ promptDelete: false, alwaysUpdateLinks: true }, null, 2),
);
writeFileSync(
  join(vault, '.obsidian', 'core-plugins.json'),
  JSON.stringify(['file-explorer', 'global-search', 'switcher', 'command-palette', 'editor-status', 'outgoing-link', 'page-preview', 'note-composer']),
);
writeFileSync(
  join(vault, '.obsidian', 'community-plugins.json'),
  JSON.stringify(['obsidian-logseq']),
);
writeFileSync(
  join(vault, '.obsidian', 'appearance.json'),
  JSON.stringify({ accentColor: '', theme: 'obsidian' }),
);

// --- edge-case files ---

// 1. Empty file (0 bytes)
writeFileSync(join(vault, 'empty.md'), '');

// 2. Whitespace-only file
writeFileSync(join(vault, 'whitespace.md'), '\n\n   \n\t\n\n');

// 3. Broken frontmatter: fence never closed
writeFileSync(
  join(vault, 'broken-frontmatter.md'),
  ['---', 'title: unclosed', 'tags: [a, b', '', '- still inside?', '- TODO never closed the yaml'].join('\n'),
);

// 4. Broken YAML values (tabs, bare nulls, duplicate keys)
writeFileSync(
  join(vault, 'broken-yaml.md'),
  ['---', '\ttitle: tabbed', 'date: null', 'date: 2020-01-01', 'rating: *anchor', '---', '', '- TODO after broken yaml', '  id:: 11111111-1111-4111-8111-111111111111'].join('\n'),
);

// 5. Org-mode properties (Logseq's other native format)
writeFileSync(
  join(vault, 'org-mode.md'),
  [
    '#+TITLE: Org mode sample',
    '#+AUTHOR: tester',
    '',
    '- org block with drawer',
    '  :PROPERTIES:',
    '  :id: 22222222-2222-4222-8222-222222222222',
    '  :END:',
    '- TODO next org item',
  ].join('\n'),
);

// 6. Special characters: emoji, ZWJ, RTL, CJK, zero-width, quotes
writeFileSync(
  join(vault, 'special-chars.md'),
  [
    '- 👨‍👩‍👧‍👦 family emoji ZWJ 🇯🇵 flag',
    '- العربية من اليمين إلى اليسار RTL',
    '- 中文测试、日本語テスト、한국어 테스트',
    '- zero-width: a​b‍c‌d',
    '- quotes "double" \'single\' `backtick` |pipe| <angle> &ampersand;',
    '- math: x² ≤ ∑ f(x) ∞ ≠ ±',
    '  id:: 33333333-3333-4333-8333-333333333333',
    '- ctrl char →\u0000← null byte',
  ].join('\n'),
);

// 7. Circular / self block embed: block embeds its own id (must terminate)
const SELF_ID = '44444444-4444-4444-8444-444444444444';
writeFileSync(
  join(vault, 'circular-embed.md'),
  [
    '- self-embedding block',
    `  id:: ${SELF_ID}`,
    `  self:: {{embed ((${SELF_ID}))}}`,
    `- watches: {{embed ((${SELF_ID}))}}`,
  ].join('\n'),
);

// 8. Deep nesting: 200 levels
const deep = [];
for (let i = 0; i < 200; i++) deep.push('\t'.repeat(i) + `- level ${i}`);
writeFileSync(join(vault, 'deep-nesting.md'), deep.join('\n'));

// 9. CRLF line endings
writeFileSync(
  join(vault, 'crlf.md'),
  ['- windows line endings', '  id:: 55555555-5555-4555-8555-555555555555', '- TODO second block'].join('\r\n'),
);

// 10. Mixed indentation (2 spaces / 4 spaces / tabs)
writeFileSync(
  join(vault, 'mixed-indent.md'),
  ['- top', '  child-two-space', '    grandchild-four-space', '\t\ttab-nested', '- TODO sibling'].join('\n'),
);

// 11. Unterminated code fence
writeFileSync(
  join(vault, 'unterminated-fence.md'),
  ['- normal block', '- ```js', "  console.log('never closed');", '- TODO block after the fence'].join('\n'),
);

// 12. Duplicate block ids
const DUP = '66666666-6666-4666-8666-666666666666';
writeFileSync(
  join(vault, 'dup-block-ids.md'),
  ['- first block with id', `  id:: ${DUP}`, '- second block, SAME id', `  id:: ${DUP}`].join('\n'),
);

// 13. Huge file: ~2 MB / ~30k blocks (generated lazily)
const hugePath = join(vault, 'huge.md');
const targetBytes = 2 * 1024 * 1024;
let needsGen = !existsSync(hugePath) || statSync(hugePath).size < targetBytes;
if (existsSync(hugePath)) {
  const head = readFileSync(hugePath, 'utf8').slice(0, 20);
  if (!head.startsWith('- huge seed block 0')) needsGen = true;
}
if (needsGen) {
  const parts = ['# Huge stress test', '', 'page-status:: generated'];
  let i = 0;
  let size = 100;
  while (size < targetBytes) {
    const line = `- huge seed block ${i} — lorem ipsum dolor sit amet 块引用 ${(i % 7 === 0) ? 'TODO' : ''} padding padding padding`;
    parts.push(line);
    if (i % 10 === 0) parts.push(`  id:: 7777${String(i).padStart(8, '0')}-7777-4777-8777-${String(i).padStart(12, '0')}`);
    if (i % 25 === 0) parts.push(`\tchild of ${i} with some longer text to vary line length across the file`);
    size += line.length + 40;
    i++;
  }
  writeFileSync(hugePath, parts.join('\n') + '\n');
}

console.log(`edge vault ready at ${vault}`);
