import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    // Unit tests import src modules that `import from 'obsidian'` —
    // resolve it to the compile-time stub (the real API only exists in Obsidian).
    alias: { obsidian: path.resolve(__dirname, 'obsidian-stub.js') },
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
