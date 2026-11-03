/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Vendored entry: gets bundled to a standalone IIFE whose SOURCE TEXT is then
 * inlined into main.js (see esbuild.mjs) and injected into the page.
 *
 * Why source text and not an import: the clipper must run against the live DOM
 * of the webview guest. An `import` would evaluate in the plugin's realm where
 * `document` is Obsidian's.
 */
import { Readability, isProbablyReaderable } from "@mozilla/readability";

(window as any).Readability = Readability;
(window as any).isProbablyReaderable = isProbablyReaderable;
