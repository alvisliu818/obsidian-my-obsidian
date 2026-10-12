/**
 * Mount filters and virtual-tree shaping — pure, no obsidian / no DOM / no fs.
 *
 * A "mount" points at a path OUTSIDE the vault (an absolute Windows path).
 * This module owns everything decidable without touching the disk:
 *
 *  - compiling the two user regexes (include / exclude) once, tolerating
 *    invalid patterns instead of throwing at render time,
 *  - the matching order (exclude wins over include; an empty include means
 *    "everything"),
 *  - turning a flat scan result into the nested tree the fake rows render.
 *
 * Kept obsidian-free on purpose: this is the part most worth unit-testing, and
 * the project's rule is that anything under test must not import `obsidian`.
 */

/** A file/dir entry as reported by the scanner, before filtering. */
export interface ScanEntry {
  /** Path relative to the mount root, always with `/` separators. */
  rel: string;
  /** Display name (basename). */
  name: string;
  isDir: boolean;
  /** Absolute path, needed to open the entry later. */
  abs: string;
  size?: number;
  mtime?: number;
}

export interface MountFilter {
  /** Only entries matching this (relative path) survive. '' = keep everything. */
  include: string;
  /** Entries matching this are dropped even when they match include. '' = drop none. */
  exclude: string;
}

export interface CompiledFilter {
  include: RegExp | null;
  exclude: RegExp | null;
  /** Patterns that failed to compile — surfaced in the UI, never fatal. */
  errors: { include?: string; exclude?: string };
}

export const EMPTY_FILTER: MountFilter = { include: '', exclude: '' };

/**
 * Compile one pattern. Returns null for an empty pattern and null on an invalid
 * one (with the error recorded) — a bad regex must never break the tree.
 */
function compile(pattern: string, flag: 'include' | 'exclude', errors: CompiledFilter['errors']): RegExp | null {
  const raw = pattern.trim();
  if (!raw) return null;
  try {
    // Case-insensitive: users filtering `\.md$` should not have to think about
    // Windows' habit of uppercase extensions.
    return new RegExp(raw, 'i');
  } catch {
    errors[flag] = raw;
    return null;
  }
}

export function compileFilter(filter: MountFilter): CompiledFilter {
  const errors: CompiledFilter['errors'] = {};
  return {
    include: compile(filter.include, 'include', errors),
    exclude: compile(filter.exclude, 'exclude', errors),
    errors,
  };
}

/**
 * Does one entry survive? Exclude is checked first and always wins, so
 * `include: '.*' , exclude: 'draft'` behaves as "everything except draft".
 *
 * The exclude test looks at the relative path AND the bare name. Path-only
 * matching is not enough: a pattern like `[\\/]archive[\\/]` (a folder filter
 * that requires a separator) would never match `archive/note.md`, where the
 * folder is the FIRST segment and has nothing in front of it. Matching each
 * path segment boundary is what makes `archive` behave as the user expects.
 */
export function entryMatches(rel: string, f: CompiledFilter): boolean {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  if (f.exclude && matchesExcluded(rel, name, f.exclude)) return false;
  if (!f.include) return true;
  return f.include.test(rel) || f.include.test(name);
}

/**
 * Exclude hit on the full path, the bare name, or any single path SEGMENT.
 *
 * The segment pass fixes a real trap: a pattern like `[\\/]archive[\\/]` is the
 * natural way to write "the archive folder", but it cannot match `archive/n.md`
 * because the folder is the first segment and has no separator in front of it.
 * Testing each segment against the same pattern with a synthetic `/` on both
 * sides makes leading and trailing positions behave like the middle ones —
 * without that, the very first folder in a mount escapes its own filter.
 */
function matchesExcluded(rel: string, name: string, exclude: RegExp): boolean {
  if (exclude.test(rel) || exclude.test(name)) return true;
  const segments = rel.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (exclude.test(segments[i])) return true;
    if (exclude.test(`/${segments[i]}/`)) return true;
  }
  return false;
}

/**
 * Directories whose ENTIRE subtree is excluded get pruned whole.
 *
 * Why this matters: scanning a code tree eagerly would walk `node_modules` even
 * when the exclude pattern will throw every entry away. Pruning on the way down
 * keeps the walk proportional to what is actually shown.
 */
export function dirPruned(rel: string, f: CompiledFilter): boolean {
  if (!f.exclude) return false;
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  // Only prune on a whole-segment match, so excluding `\.tmp$` hides those
  // files but still descends into a folder merely NAMED `drafts`.
  return f.exclude.test(name) || f.exclude.test(rel);
}

/** One node of the rendered virtual tree. */
export interface MountNode {
  name: string;
  /** Path relative to the mount root (`/`-separated). The node's identity. */
  rel: string;
  abs: string;
  isDir: boolean;
  size?: number;
  mtime?: number;
  children: MountNode[];
  /** A directory that exists but whose children were all filtered away. */
  empty?: boolean;
}

/**
 * Build the nested tree from a flat scan.
 *
 * `sort` puts folders first then files, both alphabetically — the order a file
 * tree is expected to have.
 */
export function buildTree(entries: ScanEntry[], f: CompiledFilter): MountNode[] {
  const roots: MountNode[] = [];
  // rel -> node, so children can find their parent without re-searching.
  const byRel = new Map<string, MountNode>();

  for (const e of entries) {
    if (!e.isDir && !entryMatches(e.rel, f)) continue;

    const parts = e.rel.split('/').filter(Boolean);
    // Walk/create every ancestor segment. Parents were NOT filtered by
    // entryMatches — a file can pass the filter while its folder name does not.
    let parentChildren = roots;
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      const isLeaf = i === parts.length - 1;
      let node = byRel.get(acc);
      if (!node) {
        const isDir = !isLeaf || e.isDir;
        node = {
          name: parts[i],
          rel: acc,
          abs: isLeaf ? e.abs : acc,
          isDir,
          size: isLeaf ? e.size : undefined,
          mtime: isLeaf ? e.mtime : undefined,
          children: [],
        };
        byRel.set(acc, node);
        parentChildren.push(node);
      }
      parentChildren = node.children;
    }
  }

  // A directory with no surviving descendant reads as empty rather than
  // silently vanishing, so the user can tell "filtered" from "missing".
  for (const node of byRel.values()) {
    if (node.isDir && node.children.length === 0) node.empty = true;
  }

  const sortRec = (list: MountNode[]): void => {
    list.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/** Total files + directories in a tree (for the "N files" summary). */
export function countTree(nodes: MountNode[]): { files: number; folders: number } {
  let files = 0;
  let folders = 0;
  const walk = (list: MountNode[]): void => {
    for (const n of list) {
      if (n.isDir) {
        folders++;
        walk(n.children);
      } else files++;
    }
  };
  walk(nodes);
  return { files, folders };
}

/**
 * Extensions we can render and save as text; everything else goes to the
 * system. Deliberately conservative — a wrong guess here means corrupting a
 * binary file, so unknown extensions always fall through to `shell.openPath`.
 */
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'text', 'org', 'rst', 'adoc', 'asciidoc',
  'canvas', 'json', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'csv', 'tsv', 'log', 'env', 'gitignore', 'editorconfig',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'vue', 'svelte',
  'sql', 'graphql', 'proto', 'lua', 'r', 'jl', 'pl', 'php', 'ex', 'exs', 'erl', 'hs',
  'diff', 'patch', 'lock', 'gitignore', 'npmrc', 'nvmrc', 'editorconfig',
]);

/**
 * Files with no extension that are still plain text, and must therefore not be
 * handed to the system app as a binary.
 *
 * `Dockerfile` is the one that bites: it has no extension, so an extension-keyed
 * lookup finds nothing and the file gets `isTextMount('') === false` — i.e. a
 * binary — which meant clicking it silently opened some unrelated program. Same
 * class of problem as `.gitignore`, one level up.
 */
const TEXT_FILENAMES = new Set([
  'dockerfile', 'makefile', 'rakefile', 'gemfile', 'brewfile', 'procfile',
  'vagrantfile', 'jenkinsfile', 'cmakelists.txt', 'license', 'notice', 'authors',
  'readme', 'changelog', 'contributing', 'codeowners', 'keep',
]);

/** True when the extension is one we can safely open as editable text. */
export function isTextMount(ext: string): boolean {
  return TEXT_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * True when a filename is text, judged by BOTH extension and whole name.
 *
 * `ext` alone is not enough: extension-less source files exist and are common
 * (Dockerfile, Makefile, LICENSE), and treating them as binaries means clicking
 * one launches an unrelated program instead of opening it.
 */
export function isTextFileName(name: string): boolean {
  const base = (name.split(/[\\/]/).pop() ?? name).toLowerCase();
  if (TEXT_FILENAMES.has(base)) return true;
  // A dotfile such as `.gitignore` has no extension either; treat any name that
  // starts with a dot and carries no other dot as text.
  if (base.startsWith('.') && !base.slice(1).includes('.')) return true;
  return isTextMount(extOfName(base));
}

/** Extension of a bare filename, lowercase, '' when there is none. */
export function extOfName(base: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(base);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Validate a user-entered mount path. Returns an error string, or null when the
 * path is acceptable.
 */
export function validateMountPath(p: string): string | null {
  const t = p.trim();
  if (!t) return 'Path is empty.';
  if (!/^[A-Za-z]:[\\/]/.test(t) && !t.startsWith('\\\\')) {
    return 'Use an absolute Windows path, e.g. D:\\notes';
  }
  if (/[<>"|?*]/.test(t)) return 'Path contains characters Windows does not allow.';
  return null;
}