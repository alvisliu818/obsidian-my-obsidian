/**
 * E2E config: Playwright drives a REAL Obsidian instance via Electron.
 *
 * Prerequisites:
 *   npm i -D @playwright/test
 *   Set OBSIDIAN_PATH (path to Obsidian.exe) and OBSIDIAN_VAULT (vault folder),
 *   with the plugin built & installed in that vault's
 *   .obsidian/plugins/obsidian-logseq/ and enabled.
 *   The vault needs a file "E2E/Home.md" with a few list blocks.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: 0,
  workers: 1, // one Obsidian instance at a time
  use: {
    trace: 'off',
  },
});
