import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';

/**
 * Mirrors the checks Obsidian's plugin review bot runs — the type-aware
 * typescript-eslint rules plus the official obsidianmd guidelines — over the
 * same surface it inspects: the plugin's own source.
 *
 * Build scripts and generated data are excluded on purpose. They run in Node
 * rather than inside Obsidian, and `src/icon-data.ts` is a 2MB emitted file.
 */
export default tseslint.config(
  {
    ignores: [
      'main.js',
      // The plugin folder doubles as a test vault, so other plugins' bundles
      // live under .obsidian/ — they are not ours to lint.
      '.obsidian/**',
      '.claudian/**',
      'dist/**',
      'node_modules/**',
      'src/icon-data.ts',
      'src/**/*.d.ts',
      '*.mjs',
      'scripts/**',
      'tests/**',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  }
);
