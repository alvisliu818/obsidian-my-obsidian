/**
 * Core data types for the Logseq-style block editor.
 * This module must stay dependency-free (no obsidian / CM6 / DOM) — it is
 * unit-tested under plain Node via vitest.
 */

export type Marker = 'TODO' | 'DOING' | 'DONE' | null;

export const MARKERS: Exclude<Marker, null>[] = ['TODO', 'DOING', 'DONE'];

/** Automatic take-over scope for the block editor. */
export type ScopeMode = 'all' | 'folders';

  /** Per-page default editor, set by the page `editor` property. */
/** Per-page default editor, set by the page `editor` property. */
export type EditorChoice = 'logseq' | 'native';

/** Editor UI for the page-properties first block: Logseq `key:: value` text or Obsidian's native properties editor. */
export type PagePropsEditor = 'logseq' | 'native';

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
  /** The source file used CRLF line endings — serialize back with \r\n. */
  crlf?: boolean;
  /** The source file's indentation unit ('  ' for space-indented Logseq
      exports) — serialize back with it; defaults to tab. */
  indentUnit?: string;
  /** The source file ended with a newline — serialize back with one. */
  trailingNewline?: boolean;
}

/**
 * Which groups of Logseq-specific shortcuts the block editor keeps.
 *
 * Every group is independent: turning one off hands exactly those keys back to
 * CM6 / Obsidian and leaves the others alone. `'all'` / `'none'` are accepted
 * as shorthands by the setting UI; they are expanded into the individual
 * boolean groups before being persisted, so the stored shape is always the
 * explicit one.
 *
 * These only ever apply INSIDE the block editor. The native Obsidian editor is
 * never touched — it always uses Obsidian's own shortcuts.
 */
export interface ShortcutOverrides {
  /** Alt+↑/↓ jump between blocks, Mod+Shift+↑/↓ and Alt+Shift+↑/↓ move them. */
  blockNavigation: boolean;
  /** Mod+Enter / Ctrl+Enter cycle the TODO marker. */
  todoCycle: boolean;
  /** Backspace at block start merges with the previous block; Delete merges forward. */
  blockMerge: boolean;
  /** Tab / Shift+Tab indent and outdent a block. */
  indent: boolean;
  /** Enter creates a new sibling block below. */
  newBlock: boolean;
  /** Typing a wrap character with a selection wraps it (*, _, ~, `, [, {, …). */
  selectionWrap: boolean;
  /**
   * Whole-block selection ops: Ctrl+A / X / C / D.
   * Only active when blocks are multi-selected.
   */
  bulkSelection: boolean;
  /** Undo / redo of block operations (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y). */
  undoRedo: boolean;
}

export const SHORTCUT_GROUP_LABELS: Record<keyof ShortcutOverrides, string> = {
  blockNavigation: 'Block navigation (Alt+↑/↓ jump, Mod+Shift+↑/↓ move)',
  todoCycle: 'TODO cycle (Mod+Enter)',
  blockMerge: 'Block merge (Backspace / Delete)',
  indent: 'Indent (Tab / Shift+Tab)',
  newBlock: 'New block (Enter)',
  selectionWrap: 'Selection wrap (typing * _ ~ ` [ { with a selection)',
  bulkSelection: 'Bulk block ops (Ctrl+A / X / C / D on multi-selected blocks)',
  undoRedo: 'Undo / redo of block operations',
};

/** Every group defaulting to ON = stock Logseq behavior. */
export const DEFAULT_SHORTCUT_OVERRIDES: ShortcutOverrides = {
  blockNavigation: true,
  todoCycle: true,
  blockMerge: true,
  indent: true,
  newBlock: true,
  selectionWrap: true,
  bulkSelection: true,
  undoRedo: true,
};

/** Merge stored (possibly partial/legacy) data over the defaults. */
export function shortcutOverridesFrom(raw: unknown): ShortcutOverrides {
  const o = (raw ?? {}) as Partial<ShortcutOverrides>;
  const out = { ...DEFAULT_SHORTCUT_OVERRIDES };
  for (const k of Object.keys(out) as (keyof ShortcutOverrides)[]) {
    if (typeof o[k] === 'boolean') out[k] = o[k];
  }
  return out;
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
  /** Editor for the page-properties first block: Logseq text editor or Obsidian's native properties editor. */
  pagePropsEditor: PagePropsEditor;
  /**
   * Per-page linked-reference filters, keyed by page path (Logseq's per-page
   * funnel state). Values are normalized page names; include = AND, exclude =
   * NONE — see `src/features/backlinkFilter.ts`.
   */
  refFilters: Record<string, RefFilter>;
  /** Which groups of Logseq-specific shortcuts the block editor keeps. */
  shortcuts: ShortcutOverrides;
  /**
   * Secondary SQLite index over the vault (markdown stays the source of
   * truth — the database is a rebuildable cache of it).
   */
  sqliteIndexEnabled: boolean;
  /** Keep a snapshot of the database on disk so restarts do not re-index. */
  sqlitePersist: boolean;
  /** Re-index files when they change on disk (including edits from outside). */
  sqliteAutoSync: boolean;
  /**
   * Offer the collapse caret on every block whose body spans more than one
   * rendered line — not just list blocks with children. Off = the caret only
   * appears where it always did (list blocks with children).
   */
  foldEnabled: boolean;
  /**
   * Block properties that stay in the markdown but are NOT drawn as a
   * `key:: value` row. Hiding is view-only: the property is still written,
   * still parsed back, still queryable, and still editable from the block
   * properties panel. Comma-separated; defaults to the fold flags so folding
   * a block does not litter the view with bookkeeping.
   */
  hiddenProps: string;
  /**
   * Folders OUTSIDE the vault listed in the mount panel. Each is shown as a
   * virtual tree; any entry can also be linked into the vault as a real path
   * (junction for folders, hard link for files), which makes it open in the
   * native block editor. See `notes/mounts.md`.
   */
  externalMounts: ExternalMount[];
  /**
   * Soft-wrap long lines in the external code editor. On by default: config
   * files and comments read better wrapped, and "点开就是换行" is what people
   * expect from a switch labelled 换行.
   *
   * Turn it off for real horizontal scrolling, which deeply indented code
   * prefers. Named for the MODE, and wired so true = wrapping, deliberately: an
   * earlier version named it `externalCodeWrap: true` but did NOT add
   * lineWrapping, so the switch read backwards and the label had to be
   * re-explained in the description.
   */
  externalCodeWrap: boolean;
  /**
   * Show the banner above an external file's content (the "库外" strip with the
   * path and the Save button). It is honest about where the file lives, but it
   * eats vertical space, so it can be turned off once the behaviour is familiar.
   * When hidden, saving still happens on the usual debounce.
   */
  externalBanner: boolean;
}

/**
 * One mount: an absolute path to a folder outside the vault.
 *
 * Nothing is copied into the vault — a mounted file is read from and written
 * back to where it actually lives. `include` / `exclude` are regular
 * expressions matched against the path relative to `path`.
 */
export interface ExternalMount {
  /** Stable id; also used as the link folder name, so it must be path-safe. */
  id: string;
  /** Absolute Windows path, e.g. `D:\\notes`. */
  path: string;
  /** Label shown in the panel; '' = use the folder's own name. */
  label: string;
  /** Only entries matching this survive. '' = keep everything. */
  include: string;
  /** Entries matching this are dropped even when they match `include`. '' = none. */
  exclude: string;
  /** Re-scan this mount every N seconds. 0 = manual only. */
  refreshSeconds: number;
  /** Hide the mount without deleting it. */
  enabled: boolean;
}

/** Drop anything malformed — `data.json` is user-editable. */
export function mountFrom(raw: unknown): ExternalMount | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<ExternalMount>;
  if (typeof m.id !== 'string' || !m.id.trim()) return null;
  if (typeof m.path !== 'string' || !m.path.trim()) return null;
  const secs = Number(m.refreshSeconds);
  return {
    id: m.id.trim(),
    path: m.path.trim(),
    label: typeof m.label === 'string' ? m.label : '',
    include: typeof m.include === 'string' ? m.include : '',
    exclude: typeof m.exclude === 'string' ? m.exclude : '',
    refreshSeconds: Number.isFinite(secs) && secs >= 0 ? Math.min(secs, 3600) : 0,
    // absent = enabled, so a config written before this field existed still works
    enabled: m.enabled !== false,
  };
}

/** Sanitize the stored mount list (see `mountFrom` for the per-entry rules). */
export function mountsFrom(raw: unknown): ExternalMount[] {
  if (!Array.isArray(raw)) return [];
  const out: ExternalMount[] = [];
  for (const item of raw) {
    const m = mountFrom(item);
    if (m) out.push(m);
  }
  return out;
}

/** Display name for a mount: its label, else the folder's own name. */
export function mountDisplayName(m: ExternalMount): string {
  if (m.label.trim()) return m.label.trim();
  const parts = m.path.replace(/[\\/]+$/, '').split(/[\\/]+/);
  return parts[parts.length - 1] || m.path;
}

/** A page's linked-reference filter: values to require / to hide. */
export interface RefFilter {
  includes: string[];
  excludes: string[];
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
  pagePropsEditor: 'logseq',
  refFilters: {},
  shortcuts: { ...DEFAULT_SHORTCUT_OVERRIDES },
  sqliteIndexEnabled: true,
  sqlitePersist: true,
  sqliteAutoSync: true,
  foldEnabled: true,
  hiddenProps: 'collapsed',
  externalMounts: [],
  externalCodeWrap: true,
  externalBanner: true,
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

/**
 * The per-page default-editor property: `editor:: logseq|native` (Logseq
 * page properties) or `editor: logseq|native` (frontmatter). Key and value
 * match case-insensitively; any other value (or a missing property) means
 * "no override". Non-string values (Obsidian parses frontmatter numbers /
 * booleans natively) are stringified first.
 */
export function editorChoiceFromProps(props: Record<string, unknown> | undefined | null): EditorChoice | null {
  if (!props) return null;
  let raw: unknown;
  for (const [k, v] of Object.entries(props)) {
    if (k.toLowerCase() === 'editor') {
      raw = v;
      break;
    }
  }
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'logseq') return 'logseq';
  if (v === 'native') return 'native';
  return null;
}

/**
 * Take-over decision with the per-page `editor` property applied. The
 * property is the most specific signal and overrides the settings in both
 * directions (logseq forces the block editor even with take-over off;
 * native keeps the native editor even inside included folders); without it
 * the settings decide exactly as before.
 */
export function takeOverForFile(
  choice: EditorChoice | null,
  takeOverByDefault: boolean,
  scopeMode: ScopeMode,
  includedFolders: string,
  excludedFolders: string,
  file: string,
): boolean {
  if (choice === 'logseq') return true;
  if (choice === 'native') return false;
  return shouldTakeOver(takeOverByDefault, scopeMode, includedFolders, excludedFolders, file);
}

/** True when `b` is the props-only page-properties first block (Logseq model). */
export function isPagePropsBlock(b: Block | undefined | null): boolean {
  return !!b && b.kind === 'list' && b.text === '' && !b.frontmatter;
}

/** The Logseq-format page-props record of a parsed document ({} when none). */
export function docPageProps(doc: ParsedDocument): Record<string, string> {
  return isPagePropsBlock(doc.blocks[0]) ? doc.blocks[0].props : {};
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
