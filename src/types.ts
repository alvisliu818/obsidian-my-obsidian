/**
 * Core data types for the Logseq-style block editor.
 * This module must stay dependency-free (no obsidian / CM6 / DOM) — it is
 * unit-tested under plain Node via vitest.
 */

export type Marker = 'TODO' | 'DOING' | 'DONE' | null;

export const MARKERS: Exclude<Marker, null>[] = ['TODO', 'DOING', 'DONE'];

/** Automatic take-over scope for the block editor. */
export type ScopeMode = 'all' | 'folders';

export interface Block {
  /** 'list' = outline bullet block (Logseq style); 'raw' = verbatim top-level content (headings, paragraphs, fences, quotes...) */
  kind: 'list' | 'raw';
  marker: Marker;
  /** Block text without marker/props. May contain '\n' for in-block line breaks (soft wrap). */
  text: string;
  /** Logseq-style properties (`key:: value` child lines). `id` and `collapsed` live here. */
  props: Record<string, string>;
  children: Block[];
  /** Runtime parent pointer (not serialized). */
  parent: Block | null;
  /**
   * Obsidian-format page properties: this props-only first block was created
   * from the file's frontmatter and round-trips as `key: value` lines inside
   * the `---` fences, never as Logseq `key:: value` lines.
   */
  frontmatter?: boolean;
}

export interface ParsedDocument {
  /** Raw frontmatter including the `---` fences ('' if none). */
  frontmatter: string;
  /** Top-of-file page properties (unindented `key:: value` lines, Logseq style). */
  pageProps: string;
  blocks: Block[];
}

export interface BlockEditorSettings {
  /** Folders (paths) where .md files keep opening with the native editor. */
  excludedFolders: string;
  /** Debounce delay (ms) before writing edits to disk. */
  saveDebounceMs: number;
  /** Open .md files in the block editor by default (all-intrusive take-over). */
  takeOverByDefault: boolean;
  /** Take-over scope: 'all' = every .md file (minus exclusions); 'folders' = only inside includedFolders. */
  scopeMode: ScopeMode;
  /** Folders (paths) where the block editor takes over; used when scopeMode = 'folders'. */
  includedFolders: string;
  /** Journal (daily note) folder; '' = vault root or core daily-notes setting. */
  journalFolder: string;
  /** Journal file date format (YYYY-MM-DD style tokens); '' = core daily-notes setting or YYYY-MM-DD. */
  journalFormat: string;
  /** Template text used when creating a new journal file. */
  journalTemplate: string;
  /** User-defined template variables (`name = value` per line). */
  customTemplateVars: string;
  /** Automatic pre-write backups (`.logseq-editor/backups/`). */
  backupsEnabled: boolean;
  /** Operation log trail (`.logseq-editor/log.jsonl`). */
  opLogEnabled: boolean;
  /** Guide-line click: how many child levels get folded (0 = all levels). */
  guideLineCollapseLevels: number;
  /** Guide-line click: how many child levels get unfolded (0 = all levels). */
  guideLineExpandLevels: number;
}

export const DEFAULT_SETTINGS: BlockEditorSettings = {
  excludedFolders: '',
  saveDebounceMs: 800,
  takeOverByDefault: true,
  scopeMode: 'all',
  includedFolders: '',
  journalFolder: '',
  journalFormat: '',
  journalTemplate: '',
  customTemplateVars: '',
  backupsEnabled: true,
  opLogEnabled: true,
  guideLineCollapseLevels: 0,
  guideLineExpandLevels: 0,
};

export function createBlock(text = '', marker: Marker = null): Block {
  return { kind: 'list', marker, text, props: {}, children: [], parent: null };
}

/** Stable block id (Logseq `id::` property). Empty string when unassigned. */
export function blockId(b: Block): string {
  return b.props['id'] ?? '';
}

export function isCollapsed(b: Block): boolean {
  return b.props['collapsed'] === 'true';
}

export function setCollapsed(b: Block, v: boolean): void {
  if (v) b.props['collapsed'] = 'true';
  else delete b.props['collapsed'];
}

/** Plain-text summary of a block (first line, markers stripped) — for breadcrumbs / previews. */
export function blockSummary(b: Block): string {
  const first = b.text.split('\n')[0] ?? '';
  const s = first.trim();
  return s.length > 42 ? s.slice(0, 42) + '…' : s;
}

/** Generate a random id (uuid v4 via WebCrypto, available in Obsidian & Node >= 19). */
export function genId(): string {
  return globalThis.crypto.randomUUID();
}

/** Parse a comma-separated folder list into normalized vault-relative paths. */
export function parseFolderList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
}

/** True when `file` is the folder itself or lies somewhere under it. */
export function pathInFolders(file: string, folders: string[]): boolean {
  return folders.some((f) => file === f || file.startsWith(f + '/'));
}

/**
 * Decide whether a markdown file should automatically open in the block editor.
 * - take-over off: never.
 * - scope 'all': everywhere except excludedFolders.
 * - scope 'folders': only inside includedFolders (exclusions are not consulted).
 */
export function shouldTakeOver(
  takeOverByDefault: boolean,
  scopeMode: ScopeMode,
  includedFolders: string,
  excludedFolders: string,
  file: string,
): boolean {
  if (!takeOverByDefault) return false;
  if (scopeMode === 'folders') {
    return pathInFolders(file, parseFolderList(includedFolders));
  }
  return !pathInFolders(file, parseFolderList(excludedFolders));
}

/** Assign an id to a block if it does not have one. Returns the id. */
export function ensureId(b: Block): string {
  if (!blockId(b)) b.props['id'] = genId();
  return blockId(b);
}

// ---------------------------------------------------------------------------
// Block properties as text (Logseq md parity)
// ---------------------------------------------------------------------------

/** One `key:: value` line — the block-property syntax (matches the parser). */
export const BLOCK_PROP_LINE_RE = /^([A-Za-z][A-Za-z0-9_-]*)::[ \t]*(.*)$/;

/** Props managed by their own UI; never shown or edited as `key:: value`. */
export const STRUCTURAL_PROPS = new Set(['id', 'collapsed', 'style']);

/**
 * Split the TRAILING run of `key:: value` lines off a block body. Only the
 * last consecutive run counts (properties come after content in Logseq); a
 * prop-shaped line in the middle of the text stays text.
 */
export function splitPropLines(text: string): { text: string; props: Record<string, string> } {
  const lines = text.split('\n');
  const props: Record<string, string> = {};
  let end = lines.length;
  while (end > 0) {
    const m = BLOCK_PROP_LINE_RE.exec(lines[end - 1]);
    if (!m) break;
    props[m[1]] = m[2];
    end--;
  }
  if (end === lines.length) return { text, props: {} };
  return { text: lines.slice(0, end).join('\n'), props };
}

/**
 * Sync a frontmatter-sourced props block's props map from its body lines
 * (simple top-level `key: value` entries; YAML lists/comments stay verbatim
 * in the text and are not represented in the map).
 */
export function syncFrontmatterProps(b: Block): void {
  const props: Record<string, string> = {};
  for (const line of b.text.split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (m) props[m[1]] = m[2].replace(/^ /, '');
  }
  b.props = props;
}

/** Replace a block's text-editable props, keeping the structural ones. */
export function applyBlockProps(b: Block, props: Record<string, string>): void {
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.props)) {
    if (STRUCTURAL_PROPS.has(k)) kept[k] = v;
  }
  b.props = { ...kept, ...props };
}

/** The text-editable props of a block (structural ones excluded). */
export function editableProps(b: Block): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.props)) {
    if (!STRUCTURAL_PROPS.has(k)) out[k] = v;
  }
  return out;
}

export function propsShallowEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/**
 * Editor document for a block: its text, then one `key:: value` line per
 * editable prop — properties are edited as text, Logseq-style.
 */
export function blockEditorDoc(b: Block): string {
  // Obsidian-format page properties: the editor shows the frontmatter body
  // verbatim (`key: value` lines), never converted to Logseq `key:: value`.
  if (b.frontmatter) return b.text;
  const entries = Object.entries(b.props).filter(([k]) => !STRUCTURAL_PROPS.has(k));
  if (entries.length === 0) return b.text;
  const propLines = entries.map(([k, v]) => `${k}:: ${v}`.trimEnd());
  return b.text ? `${b.text}\n${propLines.join('\n')}` : propLines.join('\n');
}
