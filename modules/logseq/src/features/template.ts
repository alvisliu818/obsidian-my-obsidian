/**
 * <% %> template syntax (a practical subset of Logseq's template commands).
 * Pure logic — unit-testable under plain vitest.
 *
 * Supported:
 *   <% today %>          → 2026-09-09
 *   <% yesterday %>      → 2026-09-08
 *   <% tomorrow %>       → 2026-09-09
 *   <% now %>            → 2026-09-09 14:30
 *   <% time %>           → 14:30
 *   <% current time %>   → 14:30 (Logseq alias)
 *   <% current page %>   → the containing page's title (from TemplateContext)
 *   <% varname %>        → user-defined variable (from TemplateContext.vars)
 *   <% tomorrow | YYYY/MM/DD %> → custom format via formatDate tokens
 */

/** Format a date with the supported tokens: YYYY MM DD HH mm ss. */
export function formatDate(fmt: string, d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return fmt
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()));
}

const DATE_WORDS: Record<string, number> = {
  today: 0,
  yesterday: -1,
  tomorrow: 1,
};

/** Extra data the editor passes in (page title, user-defined variables). */
export interface TemplateContext {
  /** Title of the page containing the block ('' when unknown). */
  currentPage?: string;
  /** User-defined variables from plugin settings (`key = value` per line). */
  vars?: Record<string, string>;
}

/** Parse the "custom template variables" setting: `name = value` per line. */
export function parseVarLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Expand `<% ... %>` expressions in text. Unknown expressions are left
 * untouched so other template systems (Obsidian core templates) can take them.
 */
export function expandTemplates(text: string, now: Date = new Date(), ctx?: TemplateContext): string {
  return text.replace(/<%\s*([^%]*?)\s*%>/g, (whole, expr: string) => {
    const out = expandExpr(expr.trim(), now, ctx);
    return out === null ? whole : out;
  });
}

/** Expand a single expression body; null when unsupported. */
export function expandExpr(expr: string, now: Date, ctx?: TemplateContext): string | null {
  // optional custom format: `today | YYYY/MM/DD`
  const bar = expr.indexOf('|');
  const word = (bar === -1 ? expr : expr.slice(0, bar)).trim().toLowerCase();
  const fmt = bar === -1 ? '' : expr.slice(bar + 1).trim();

  if (word in DATE_WORDS) {
    const d = new Date(now);
    d.setDate(d.getDate() + DATE_WORDS[word]);
    return formatDate(fmt || 'YYYY-MM-DD', d);
  }
  if (word === 'now') return formatDate(fmt || 'YYYY-MM-DD HH:mm', now);
  if (word === 'time' || word === 'current time') return formatDate(fmt || 'HH:mm', now);
  if (word === 'current page') return ctx?.currentPage ?? null;
  // User-defined variables (custom format suffix not applicable).
  if (bar === -1 && ctx?.vars && word in ctx.vars) return ctx.vars[word];
  return null;
}
