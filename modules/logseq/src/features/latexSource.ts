/**
 * `\(…\)` / `\[…\]` on the surfaces that own their markdown.
 *
 * Static blocks, block embeds, native embeds, flashcards, a code block's prefix
 * and the out-of-vault file view all go through `MarkdownRenderer.render` into a
 * plain container. There `getSectionInfo` answers null — it needs the reading
 * view's section map — so the LaTeX module's post processor cannot reach them.
 * What those surfaces DO have is the source, so they convert it before
 * rendering: `\(x\)` becomes `$x$`, `\[x\]` becomes `$$x$$`, and Obsidian's own
 * math renderer takes it from there.
 *
 * The conversion belongs to the `latex-delimiter-renderer` module — it is the
 * real implementation — and reaches us through an API it publishes on `app`.
 * Two reasons for publishing instead of importing:
 *
 *  - the dependency stays one-way (Logseq does not have to know another module
 *    exists in order to compile), and
 *  - when the module is switched off in the host settings, every surface goes
 *    dark together. A static import would leave these six rendering math while
 *    Live Preview and Reading View had stopped — a half-off switch.
 *
 * Render-only, always: the block model and the file on disk keep `\(…\)`.
 */
import type { App } from 'obsidian';

const API_KEY = 'latex-delimiter-renderer';

type LatexApi = { convertForObsidianRender?: (markdown: string) => string };

/**
 * Rewrite LaTeX delimiters for one rendering pass, if the module is running.
 *
 * Cheap early-out first: this runs on every block of every render, and a note
 * with no math must not pay for a lookup.
 */
export function toObsidianMath(text: string, app: App): string {
  if (!text.includes('\\(') && !text.includes('\\[')) return text;
  const api = (app as unknown as Record<string, LatexApi | undefined>)[API_KEY];
  const convert = api?.convertForObsidianRender;
  return typeof convert === 'function' ? convert(text) : text;
}
