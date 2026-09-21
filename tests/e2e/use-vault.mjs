/**
 * E2E helper: point the %APPDATA%\obsidian\obsidian.json "open" flag at a
 * given vault (registering it first if needed), with backup/restore of the
 * user's original file around it.
 *
 * The Obsidian Windows shell ignores positional vault arguments (they are
 * consumed by its CLI pipe), so deterministic E2E must switch the last-open
 * vault through the vault registry instead.
 *
 * Usage: node tests/e2e/use-vault.mjs <vaultPath> [--restore]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CFG_DIR = join(process.env.APPDATA ?? '', 'obsidian');
const CFG = join(CFG_DIR, 'obsidian.json');
const BACKUP = join(CFG_DIR, 'obsidian.json.e2e-backup');

function vaultIdFor(path) {
  return createHash('md5').update(path.toLowerCase()).digest('hex').slice(0, 16);
}

const cmd = process.argv[2] ?? '';
const vaultPath = process.argv[3] ?? '';

if (cmd === '--restore') {
  if (existsSync(BACKUP)) {
    copyFileSync(BACKUP, CFG);
    unlinkSync(BACKUP);
    console.log('obsidian.json restored from e2e backup');
  } else {
    console.log('no e2e backup present; nothing restored');
  }
  process.exit(0);
}

if (!vaultPath) {
  console.error('usage: node use-vault.mjs <vaultPath> | --restore');
  process.exit(1);
}

if (!existsSync(BACKUP)) copyFileSync(CFG, BACKUP);
const raw = readFileSync(CFG, 'utf8');
const cfg = JSON.parse(raw);
cfg.vaults ??= {};

// Find or create the entry whose path matches the requested vault.
let id = Object.keys(cfg.vaults).find((k) => cfg.vaults[k].path?.toLowerCase() === vaultPath.toLowerCase());
if (!id) {
  id = vaultIdFor(vaultPath);
  cfg.vaults[id] = { path: vaultPath, ts: Date.now() };
}
for (const k of Object.keys(cfg.vaults)) {
  cfg.vaults[k].open = k === id;
}
cfg.vaults[id].ts = Date.now();
writeFileSync(CFG, JSON.stringify(cfg));
console.log(`obsidian.json now opens: ${vaultPath} (id=${id}); original saved to obsidian.json.e2e-backup`);
