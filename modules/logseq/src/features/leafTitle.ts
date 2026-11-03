/**
 * Write a leaf's in-view title.
 *
 * Obsidian caches a view's title in two places and only refreshes one of them.
 * `leaf.updateHeader()` fixes the TAB (measured), but the leaf's own
 * `.view-header` keeps whatever the view was mounted with — so a mounted file
 * sat under a heading naming the borrowed note (reported with a screenshot:
 * the tab read AGENTS.md while the title above the breadcrumb still read the
 * seed note's name).
 *
 * Tried and measured as NOT fixing it: leaf.updateHeader(),
 * workspace.updateOptions(), a resize trigger, and re-calling setViewState
 * (which destroys the view). Writing the element does work, and the write is
 * stable — the node survives a re-render and a tab switch with the text intact
 * — so it is applied on every mount rather than once.
 *
 * The caller passes the text it wants shown; it decides whether that is a bare
 * name or a mount-relative path.
 */

/** The title element inside a leaf's own view header, if it has one. */
function leafTitleEl(leaf: unknown): HTMLElement | null {
  const viewEl = (leaf as { view?: { containerEl?: HTMLElement } })?.view?.containerEl;
  const root = viewEl?.closest?.('.workspace-leaf') as HTMLElement | null;
  return (root?.querySelector?.('.view-header-title') as HTMLElement | null) ?? null;
}

/**
 * Set the in-view header text when it differs.
 *
 * Returns whether a write happened, so a caller can log or test it without
 * reading the DOM back.
 */
export function setLeafTitle(leaf: unknown, label: string): boolean {
  const el = leafTitleEl(leaf);
  if (!el) return false;
  if (el.textContent === label) return false;
  el.textContent = label;
  return true;
}