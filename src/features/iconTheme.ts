/**
 * Reusing Material Icon Theme's icons on rows the theme does not own.
 *
 * The theme decorates Obsidian's file explorer: it marks a row with
 * `data-mfi-applied` and puts a `<span class="mfi-icon"><svg>…</svg></span>` in
 * front of the label (measured — its styles.css styles exactly that, and a live
 * row's innerHTML matches). Our mount rows live in our own panel, and the
 * theme's observer does NOT reach them: measured, a row built with the theme's
 * own class names and a real vault `data-path` was left untouched
 * (`autoDecorated: false`), because its observer only walks the explorer.
 *
 * So we ask the theme for the SVG instead. Its `getFileIconSvg(path)` is private
 * TypeScript but a real function at runtime (measured: returns a 267-char
 * `<svg>`), which makes this a supported-by-measurement call rather than a copy
 * of its 2 MB icon table.
 *
 * Everything degrades quietly: no theme, a renamed method, or an empty result
 * all fall back to the caller's own marker, because an icon is never worth an
 * error.
 */

/** The class the theme's stylesheet expects on the icon holder. */
export const THEME_ICON_CLASS = 'mfi-icon';
/** The extra class the theme puts on folder icons, so its styles apply. */
export const THEME_FOLDER_ICON_CLASS = 'mfi-folder-icon';
/** The attribute it sets on a row it has decorated. */
export const THEME_APPLIED_ATTR = 'data-mfi-applied';

interface IconThemeLike {
  getFileIconSvg?: (path: string) => string | null | undefined;
  /** Resolve a folder's icon key; the theme exposes this alongside getSvg. */
  getFolderIconKey?: (path: string, collapsed: boolean) => string | null | undefined;
  getIconSet?: (key: string) => { dark: string; light: string } | null | undefined;
  getSvg?: (iconSet: { dark: string; light: string }) => string | null | undefined;
  /** Which variant to hand back; the theme picks by the current theme mode. */
  isDark?: boolean;
}

/** The plugin registry, as loosely as possible so obsidian's `App` fits. */
type AppLike = unknown;

interface PluginRegistries {
  plugins?: Record<string, unknown>;
}

/** Pull the `{ [id]: instance }` map out of either registry shape. */
function registryOf(host: unknown): Record<string, unknown> | null {
  if (!host || typeof host !== 'object') return null;
  const inner = (host as PluginRegistries).plugins;
  return inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : null;
}

const THEME_ID = 'material-icon-theme';

/**
 * Find the theme's plugin instance.
 *
 * Both registry names are checked: community plugins live under
 * `app.plugins.plugins`, and older builds expose `app.internalPlugins`. The
 * lookup is defensive because a missing theme is the normal case for users who
 * do not have it.
 */
function themeInstance(app: AppLike): IconThemeLike | null {
  const a = (app ?? {}) as { plugins?: unknown; internalPlugins?: unknown };
  // Both registry names are checked, so the lookup survives either build.
  for (const host of [a.plugins, a.internalPlugins]) {
    const reg = registryOf(host);
    const found = reg?.[THEME_ID] as IconThemeLike | undefined;
    if (found && typeof found === 'object') return found;
  }
  return null;
}

/** Is the icon theme present and does it expose the method we rely on? */
export function hasIconTheme(app: AppLike | null | undefined): boolean {
  const t = themeInstance(app);
  return typeof t?.getFileIconSvg === 'function';
}

/**
 * The SVG markup for a file, or null when the theme cannot help.
 *
 * `vaultPath` should be a path the theme can reason about. It matches on the
 * last two segments first (so `dir/.config/prettierrc` beats a bare name) and
 * then on the extension, so passing a plausible vault-relative path — even for
 * a file that lives outside the vault — gives the same answer the explorer
 * would have given.
 */
export function iconSvgFor(app: AppLike | null | undefined, vaultPath: string): string | null {
  const t = themeInstance(app);
  if (!t || typeof t.getFileIconSvg !== 'function') return null;
  try {
    const svg = t.getFileIconSvg(vaultPath);
    return typeof svg === 'string' && svg.includes('<svg') ? svg : null;
  } catch {
    // A theme that throws on an unusual path must not break the tree.
    return null;
  }
}

/**
 * The SVG for a FOLDER, or null when the theme cannot help.
 *
 * Folders need a three-step call rather than the one-shot file lookup:
 * `getFolderIconKey(path, collapsed)` → `getIconSet(key)` → `getSvg(set)`.
 * All three are private TypeScript but real functions at runtime (verified in
 * the theme's source and by calling them), and folders are worth the extra
 * steps: a source folder, a `node_modules` folder and a plain one each get their
 * own icon, which is exactly what makes an explorer readable.
 */
export function folderIconSvgFor(
  app: AppLike,
  opts: { path: string; collapsed: boolean },
): string | null {
  const t = themeInstance(app);
  if (!t || typeof t.getFolderIconKey !== 'function' || typeof t.getSvg !== 'function') return null;
  try {
    const key = t.getFolderIconKey(opts.path, opts.collapsed);
    if (typeof key !== 'string' || !key) return null;
    // getIconSet is optional in some builds; without it we cannot resolve the
    // key, and returning null keeps the caller's marker.
    if (typeof t.getIconSet !== 'function') return null;
    const set = t.getIconSet(key);
    if (!set) return null;
    const svg = t.getSvg(set);
    return typeof svg === 'string' && svg.includes('<svg') ? svg : null;
  } catch {
    return null;
  }
}

/**
 * Decide what a row's icon slot should contain, without touching the DOM.
 *
 * Split from the rendering so the decision is testable under plain Node (the
 * project's rule: anything under test must not need a browser), and so the
 * fallback rules are stated in one place.
 *
 * - a folder asks the theme through the three-step folder lookup (see
 *   `folderIconSvgFor`), keyed on the folder NAME, which is what the theme
 *   matches on;
 * - a file asks with the mount-relative path first (that is what lets the
 *   theme apply its directory-scoped filename rules), then the bare name;
 * - anything unusable falls back to the marker.
 */
export interface IconDecision {
  /** SVG markup, or null when the marker should be used. */
  svg: string | null;
  /** Text to show when there is no SVG. */
  fallback: string;
  /** True when the SVG came from the icon theme (as opposed to nothing). */
  themed: boolean;
}

export function decideIcon(
  app: AppLike,
  o: { name: string; isDir: boolean; rel: string; fallback: string; collapsed?: boolean },
): IconDecision {
  if (o.isDir) {
    // The theme matches folder icons on the NAME, not on a path, so the name is
    // the right thing to ask with — and a wrong folder icon is worse than an
    // honest generic one, hence the fallback.
    const svg = folderIconSvgFor(app, { path: o.name, collapsed: o.collapsed ?? true });
    return svg
      ? { svg, fallback: o.fallback, themed: true }
      : { svg: null, fallback: o.fallback, themed: false };
  }
  const rel = (o.rel || o.name).replace(/\\/g, '/');
  const themed = iconSvgFor(app, rel) ?? iconSvgFor(app, o.name);
  return themed
    ? { svg: themed, fallback: o.fallback, themed: true }
    : { svg: null, fallback: o.fallback, themed: false };
}

/**
 * Render the theme's icon into a holder element, styled the way its stylesheet
 * expects (it sizes `.mfi-icon` and its inner `svg` itself).
 *
 * Returns true when an icon was placed, so the caller can keep its own marker
 * for the cases the theme does not cover.
 */
export function applyThemeIcon(holder: HTMLElement, app: AppLike, vaultPath: string): boolean {
  const svg = iconSvgFor(app, vaultPath);
  if (!svg) return false;
  holder.innerHTML = svg;
  holder.classList.add(THEME_ICON_CLASS);
  return true;
}

/**
 * Icon for a mounted entry, as a standalone element ready to drop into a row.
 *
 * `fallback` is the caller's own marker text (an emoji, say) so the row still
 * reads as a file or a folder when no icon theme is installed.
 */
export function iconForEntry(
  app: AppLike,
  opts: { name: string; isDir: boolean; mountPath: string; rel: string; collapsed?: boolean; fallback: string },
): HTMLElement {
  const el = document.createElement('span');
  el.className = 'logseq-mount-icon';
  const decision = decideIcon(app, opts);
  if (decision.svg) {
    el.innerHTML = decision.svg;
    // classList rather than Obsidian's addClass helper: this element is created
    // with the plain DOM API, so the Obsidian extension may not be on it.
    el.classList.add(THEME_ICON_CLASS);
    // The theme tags its folder icons with an extra class and has rules for it,
    // so a folder needs both or it renders with the wrong treatment.
    if (opts.isDir) el.classList.add(THEME_FOLDER_ICON_CLASS);
  } else {
    el.textContent = decision.fallback;
  }
  return el;
}
