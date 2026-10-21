/**
 * Type surface for `cm-bundle:` imports (see cmBundlePlugin in esbuild.mjs).
 *
 * `cm-bundle:` is a build-time namespace: esbuild resolves the specifier with
 * nodeRequire and inlines a PRIVATE CodeMirror copy for the code file view,
 * jupyter notebook view and the logseq CM LSP bridge (isolated from
 * Obsidian's own CM instance — StateEffects/facets are not interchangeable).
 *
 * TypeScript can't resolve the prefix, so each whole-package specifier is
 * re-exported from the real package, which resolves normally through PnP.
 * The legacy-modes subpaths (`mode/clike`, …) are NOT covered here — they
 * map to the unplugged copy via tsconfig paths, because ambient declarations
 * can't express per-file named exports.
 *
 * Keep this list in sync with the unplugged entries in package.json:
 * esbuild reads the package SOURCE from disk (unplug keeps it on real files).
 */
declare module "cm-bundle:@codemirror/state" {
  export * from "@codemirror/state";
}
declare module "cm-bundle:@codemirror/view" {
  export * from "@codemirror/view";
}
declare module "cm-bundle:@codemirror/commands" {
  export * from "@codemirror/commands";
}
declare module "cm-bundle:@codemirror/search" {
  export * from "@codemirror/search";
}
declare module "cm-bundle:@codemirror/autocomplete" {
  export * from "@codemirror/autocomplete";
}
declare module "cm-bundle:@codemirror/language" {
  export * from "@codemirror/language";
}
declare module "cm-bundle:@codemirror/lang-javascript" {
  export * from "@codemirror/lang-javascript";
}
declare module "cm-bundle:@codemirror/lang-html" {
  export * from "@codemirror/lang-html";
}
declare module "cm-bundle:@codemirror/lang-css" {
  export * from "@codemirror/lang-css";
}
declare module "cm-bundle:@codemirror/lang-markdown" {
  export * from "@codemirror/lang-markdown";
}
declare module "cm-bundle:@lezer/highlight" {
  export * from "@lezer/highlight";
}
