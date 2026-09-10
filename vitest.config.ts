import { defineConfig } from 'vitest/config';

export default defineConfig({
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
