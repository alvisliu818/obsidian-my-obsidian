import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    // Unit tests import src modules that `import from 'obsidian'` —
    // resolve it to the compile-time stub (the real API only exists in Obsidian).
    alias: [
      { find: /^obsidian$/, replacement: path.resolve(__dirname, 'obsidian-stub.js') },
      // `cm-bundle:<pkg>` — strip the prefix; node_modules resolution takes over
      // (the bundling split only matters inside Obsidian, not under vitest).
      { find: /^cm-bundle:/, replacement: '' },
    ],
  },
  test: {
    // Unit tests live next to the code they test; tests/e2e is driven by
    // Playwright against a real Obsidian instance (npm run e2e).
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      'tests/e2e/**',
    ],
  },
});
