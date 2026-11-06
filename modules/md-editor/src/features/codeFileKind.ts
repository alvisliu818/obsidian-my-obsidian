/**
 * Which files the external code editor claims, and what path its header shows.
 *
 * Kept apart from the editor view on purpose: these are pure decisions with no
 * DOM and no CodeMirror, so they are unit-testable under plain Node. The view
 * imports them rather than defining them, so a rule change is testable without
 * loading an editor bundle that pulls in @codemirror/search (which Obsidian
 * provides at runtime and the npm tree does not).
 *
 * Both rules came from screenshots: `.gitignore` opened as a markdown document
 * with headings and bullet lists, and the header showed a long absolute Windows
 * path instead of the name the user recognises.
 */

/**
 * Which editor a mounted file belongs in, and what path its header shows.
 *
 * Kept apart from the editor views on purpose: these are pure decisions with no
 * DOM and no CodeMirror, so they are unit-testable under plain Node. The views
 * import them rather than defining them, so a routing change is testable
 * without loading an editor bundle that pulls in @codemirror/search (which
 * Obsidian provides at runtime and the npm tree does not).
 *
 * The routing rule is by CONTENT, not by an allowlist of code extensions.
 * An allowlist was the wrong shape: every file it forgot went somewhere wrong,
 * which is how a `.gitignore` came to be rendered as a document with headings and
 * bullet lists. Markdown is the one format that is prose; everything else is
 * read line by line.
 */

// 2026-10-27 模块拆分:库外文件的打开路由归 doc-tree 模块,markdown 判定
// 随之搬进 doc-tree/src/features/mountFilter.ts。这里 re-export 维持本模块
// 与宿主的 import 面不断(main.ts 的 file-menu、ExternalCodeView 等)。
export { isMarkdownFile } from '../../../virtual-tree/src/features/mountFilter';

/**
 * Display path for a mounted file: relative to the mount root.
 *
 * An absolute Windows path is noise here — the panel already shows which mount a
 * file came from, and the drive-and-folder prefix pushes the filename out of
 * view. Falls back to the bare name when the file is not inside its mount, which
 * can happen if the mount moved after the tab was opened.
 */
export function relativeDisplayPath(abs: string, mountPath: string, name: string): string {
  const fallback = name || abs.split(/[\\/]/).pop() || abs;
  if (!mountPath) return fallback;
  // Compare on a single separator form: a mount configured as `D:/notes` and a
  // file reported as `D:\notes\a.md` are the same place, and the mount root the
  // user typed can use either.
  const root = mountPath.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const full = abs.replace(/\\/g, '/').toLowerCase();
  if (full === root) return name;
  if (full.startsWith(root + '/')) {
    // Slice on the normalized strings so the length matches.
    return abs.replace(/\\/g, '/').slice(root.length + 1);
  }
  return fallback;
}