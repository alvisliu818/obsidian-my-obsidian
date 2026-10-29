/**
 * Ambient types for CodeMirror packages that Obsidian provides at runtime but
 * that are not in this project's npm dependencies.
 *
 * Obsidian bundles these as externals (esbuild is configured to leave
 * `@codemirror/*` alone), so importing them works in the app and only the
 * compiler needs help. `search` is the one used here; the language packages
 * that ARE dependencies resolve normally.
 *
 * Minimal on purpose: only the three entry points the external code editor
 * touches, so nothing here can drift into looking like a real API contract.
 */
declare module '@codemirror/search' {
  import type { Extension } from '@codemirror/state';
  /** Panel + keymap for the search box (Ctrl+F). */
  export function search(config?: {
    top?: boolean;
    caseSensitive?: boolean;
    literal?: boolean;
    regexp?: boolean;
    wholeWord?: boolean;
  }): Extension;
  /** Key bindings for the search panel. */
  export const searchKeymap: readonly unknown[];
  /** Highlight every occurrence of the selection. */
  export function highlightSelectionMatches(config?: {
    caseSensitive?: boolean;
    literal?: boolean;
    regexp?: boolean;
    wholeWord?: boolean;
    minMatches?: number;
    maxMatches?: number;
  }): Extension;
}

/**
 * The `cm-bundle:` copy (the external code editor mounts its OWN CodeMirror —
 * see esbuild.mjs — because the shared instance's StreamLanguage highlighting
 * silently produced no tokens: 报告: 代码文件没有语法高亮) is typed by
 * src/cm-bundle.d.ts at the repo root, which re-exports the real packages.
 */
