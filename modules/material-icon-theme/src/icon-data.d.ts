/**
 * Type surface for the generated `icon-data.ts`.
 *
 * The generated module is gitignored — it is ~2MB of inlined SVG and is rebuilt
 * by `scripts/build-icons.mjs` on every `npm run build`. Without this
 * declaration, any checkout that has not run the build yet (a fresh clone, CI,
 * Obsidian's plugin review bot) fails to resolve the import, and every value
 * flowing out of it degrades to `any` — which surfaces as a wall of
 * `no-unsafe-*` lint errors across main.ts rather than one missing-module error.
 *
 * TypeScript resolves `.ts` before `.d.ts`, so the real generated types win
 * locally; this file only fills in when the generated module is absent.
 *
 * Keep in sync with the emitter at the bottom of `scripts/build-icons.mjs` —
 * that script verifies the two agree and fails the build if they drift.
 */

export interface IconSet {
  dark: string;
  light: string;
}

/** Deduplicated SVG registry — each unique icon is stored exactly once. */
export declare const iconRegistry: Record<string, IconSet>;

/** Maps file extension -> iconRegistry key (keys are lowercase). */
export declare const fileExtensionKeys: Record<string, string>;

/** Maps exact filename -> iconRegistry key (keys are lowercase). */
export declare const fileNameKeys: Record<string, string>;

/** Maps folder name -> iconRegistry key, collapsed state (keys are lowercase). */
export declare const folderNameKeys: Record<string, string>;

/** Maps folder name -> iconRegistry key, expanded state (keys are lowercase). */
export declare const folderNameOpenKeys: Record<string, string>;

export declare const defaultFileIconKey: string;
export declare const folderIconKey: string;
export declare const folderOpenIconKey: string;
