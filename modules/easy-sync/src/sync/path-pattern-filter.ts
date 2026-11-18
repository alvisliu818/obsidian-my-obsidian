/**
 * User-configurable path filters: blacklist / whitelist patterns with regex
 * support (obsidian-my-obsidian extension, see that repo's
 * modules/easy-sync/NOTICE.md 功能增强节).
 *
 * Entry syntax (both lists accept the same two forms):
 *  - plain text  : a vault-relative folder or file path. Boundary prefix
 *                  match, case-insensitive — the same semantics as the
 *                  upstream excludedFolders setting (`Notes` matches
 *                  `Notes`, `Notes/a.md`, `Notes/sub/b.md`, but not
 *                  `Notes2/x.md`). Backslashes are normalized to slashes;
 *                  leading/trailing slashes are trimmed.
 *  - /regex/flags: a JavaScript regular expression tested against the whole
 *                  normalized vault-relative path (forward slashes, no
 *                  leading/trailing slash). Flags are optional; validation
 *                  accepts only real RegExp flags. A literal path that
 *                  happens to start with `/` but has no closing `/` is
 *                  treated as plain text, never as a broken regex.
 *
 * Semantics (enforced by the scanner's isExcluded / isExcludedDirectory):
 *  1. EasySync internal paths stay hard-excluded (never overridable).
 *  2. The blacklist wins over the whitelist — matching either excludes the
 *     path outright. Safety first: never sync something explicitly banned.
 *  3. The whitelist only narrows vault content: it is evaluated after the
 *     internal includePaths resurrection (bookmarks.json etc.) so plugin
 *     code/config files keep being governed by their own sync-scope
 *     switches, not by the whitelist.
 *
 * Invalid regex entries never block syncing: validation rejects them at
 * save time (the UI surfaces the error), and at match time a pattern that
 * fails to compile simply matches nothing.
 */

/** Normalized vault-relative path for matching: forward slashes, collapsed
 *  duplicates, no leading/trailing slash. Case is preserved; comparisons
 *  lowercase on demand (plain entries are case-insensitive like
 *  excludedFolders, regex entries honor their own flags). */
function normalizeMatchPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/** Normalize a plain-text pattern into its matching form. Returns null for
 *  entries that carry no usable path (empty, ".", ".."). */
function normalizePlainPattern(value: string): string | null {
  const path = normalizeMatchPath(value);
  if (!path || path === ".") return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return path;
}

const VALID_REGEX_FLAGS = "dgimsuvy";

export type ParsedPathPattern =
  | { kind: "plain"; normalized: string }
  | { kind: "regex"; regex: RegExp };

export type ParsedPathPatternResult =
  | { ok: true; pattern: ParsedPathPattern }
  | { ok: false; reason: string };

/** Parse one persisted pattern entry. Pure — never throws. */
export function parsePathPattern(raw: string): ParsedPathPatternResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  // Regex form: /body/flags (a bare "/x" with no closing slash is a plain
  // path — vault-relative paths never start with "/", so this cannot be a
  // regex without a terminator).
  if (trimmed.length > 2 && trimmed.startsWith("/")) {
    const closingSlash = trimmed.lastIndexOf("/");
    if (closingSlash > 0) {
      const body = trimmed.slice(1, closingSlash);
      const flags = trimmed.slice(closingSlash + 1);
      if (body.length > 0) {
        if (!/^[dgimsuvy]*$/u.test(flags)) {
          return { ok: false, reason: `invalid regex flags: /${flags}` };
        }
        try {
          const regex = new RegExp(body, flags);
          return { ok: true, pattern: { kind: "regex", regex } };
        } catch (error) {
          return {
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }
  }

  const normalized = normalizePlainPattern(trimmed);
  if (normalized === null) {
    return { ok: false, reason: "not a usable path" };
  }
  return { ok: true, pattern: { kind: "plain", normalized } };
}

/** Normalize + dedupe a persisted pattern list. Non-string entries and
 *  unusable paths are dropped; dedupe is case-insensitive on the trimmed
 *  value (regex flags keep their spelling — dedupe compares the trimmed
 *  raw text lowercased, so `/A/i` and `/a/i` collapse but `/A/` and `/A/i`
 *  stay distinct). */
export function normalizePathPatterns(
  values: readonly unknown[],
): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!unique.has(key)) unique.set(key, trimmed);
  }
  return [...unique.values()];
}

/** Validate a persisted pattern list. Returns the normalized list plus the
 *  raw entries that failed to parse (the UI shows these; the settings
 *  pipeline refuses to save while this is non-empty). */
export function validatePathPatterns(
  values: readonly unknown[],
): { normalized: string[]; invalid: { raw: string; reason: string }[] } {
  const normalized = normalizePathPatterns(values);
  const invalid: { raw: string; reason: string }[] = [];
  for (const raw of normalized) {
    const parsed = parsePathPattern(raw);
    if (!parsed.ok) invalid.push({ raw, reason: parsed.reason });
  }
  return { normalized, invalid };
}

/** Does one pattern match the (already normalized) path? A pattern that
 *  fails to parse matches nothing — bad entries can never brick a sync. */
function patternMatchesPath(
  pattern: ParsedPathPattern,
  normalizedPath: string,
): boolean {
  if (pattern.kind === "regex") {
    try {
      return pattern.regex.test(normalizedPath);
    } catch {
      return false;
    }
  }
  const lowerPath = normalizedPath.toLowerCase();
  const lowerPrefix = pattern.normalized.toLowerCase();
  return lowerPath === lowerPrefix
    || lowerPath.startsWith(`${lowerPrefix}/`);
}

/** Could a folder still contain paths matched by this pattern? Used by the
 *  directory-level filter to decide whether recursion into the folder can
 *  ever pay off. Conservative: an unanswerable question ("could a regex
 *  match something deeper?") always answers yes. */
function patternMayMatchInside(
  pattern: ParsedPathPattern,
  normalizedFolder: string,
): boolean {
  if (pattern.kind === "regex") return true;
  const lowerFolder = normalizedFolder.toLowerCase();
  const lowerPrefix = pattern.normalized.toLowerCase();
  // Folder inside the pattern area, or the folder is an ancestor of the
  // pattern area — either way a descendant may match.
  return lowerFolder === lowerPrefix
    || lowerFolder.startsWith(`${lowerPrefix}/`)
    || lowerPrefix.startsWith(`${lowerFolder}/`);
}

/** File-level blacklist: any match excludes the path outright. Empty list
 *  (or every entry unusable) excludes nothing. */
export function isPathExcludedByPatterns(
  path: string,
  blacklist: readonly string[] | undefined,
): boolean {
  if (!blacklist?.length) return false;
  const normalizedPath = normalizeMatchPath(path);
  if (!normalizedPath) return false;
  for (const raw of blacklist) {
    const parsed = parsePathPattern(raw);
    if (parsed.ok && patternMatchesPath(parsed.pattern, normalizedPath)) {
      return true;
    }
  }
  return false;
}

/** File-level whitelist: an empty list imposes no restriction; otherwise
 *  the path must match at least one entry to stay in scope. */
export function isPathIncludedByWhitelist(
  path: string,
  whitelist: readonly string[] | undefined,
): boolean {
  if (!whitelist?.length) return true;
  const normalizedPath = normalizeMatchPath(path);
  if (!normalizedPath) return false;
  for (const raw of whitelist) {
    const parsed = parsePathPattern(raw);
    if (parsed.ok && patternMatchesPath(parsed.pattern, normalizedPath)) {
      return true;
    }
  }
  return false;
}

/** Folder-level whitelist, conservative: an empty list keeps the folder;
 *  otherwise the folder survives only while some entry could still match
 *  the folder itself or one of its descendants (regex entries always
 *  answer "maybe", letting the per-file filter decide). */
export function isFolderPathKeptByWhitelist(
  folderPath: string,
  whitelist: readonly string[] | undefined,
): boolean {
  if (!whitelist?.length) return true;
  const normalizedFolder = normalizeMatchPath(folderPath);
  if (!normalizedFolder) return false;
  for (const raw of whitelist) {
    const parsed = parsePathPattern(raw);
    if (parsed.ok && patternMayMatchInside(parsed.pattern, normalizedFolder)) {
      return true;
    }
  }
  return false;
}

/** Folder-level blacklist: any match prunes the whole subtree. */
export function isFolderExcludedByPatterns(
  folderPath: string,
  blacklist: readonly string[] | undefined,
): boolean {
  return isPathExcludedByPatterns(folderPath, blacklist);
}
