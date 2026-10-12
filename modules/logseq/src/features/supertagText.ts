/**
 * Block-text tag helpers for supertags (Tana supertags / Logseq DB new tags).
 *
 * Pure text-in / text-out functions — no DOM, no obsidian — so the "did I strip
 * exactly the right occurrence" rules are unit-testable. `collectBlockTags`
 * mirrors the block index's own scanner so the view and the index always agree
 * on what tags a block carries.
 *
 * The removal rule is the delicate one: `#book` must NOT be touched when asked
 * to remove `#book`, because `#books` / `#book-club` are different tags, and an
 * occurrence inside `[[...]]` is a page link, not a tag. Logseq's own scanner
 * applies the same boundary rule (a tag must start after whitespace or `(`).
 */

/** Tag sigil: `#name` at a word boundary (same shape as the index's TAG_RE). */
const TAG_TOKEN_RE = /#([\p{L}\d][\p{L}\d_/-]*)/gu;

/**
 * Sentinel wrapping a masked `[[link]]` index while scanning. A Private Use
 * Area codepoint: it cannot occur in real note text, so restoring is exact.
 */
const SENTINEL = '\uE000';


/**
 * Normalized tag names in a block's text, lowercased, in first-seen order.
 * Matches `blockIndex`'s `collectTags` (which also ignores `[[...]]` content).
 */
export function collectBlockTags(text: string): string[] {
  // Tags inside [[...]] don't count: that is a page reference, not a tag.
  const bare = text.replace(/\[\[([^\]]+)\]\]/g, ' ');
  return [...new Set([...bare.matchAll(TAG_TOKEN_RE)].map((m) => m[1].toLowerCase()))];
}

/**
 * Remove one tag occurrence from block text, leaving everything else byte-exact.
 *
 * - Only the FIRST occurrence is removed (matches "remove this tag" semantics).
 * - `#book` does not match inside `#books` / `#book-club` (the regex consumes
 *   the whole name, so a longer name never compares equal to a shorter one).
 * - Occurrences inside `[[...]]` are skipped.
 * - The gap the tag left behind is collapsed, so repeated add/remove cycles do
 *   not accumulate whitespace drift.
 *
 * Returns the text unchanged when the tag is not present.
 */
export function removeTagFromText(text: string, tag: string): string {
  const target = tag.replace(/^#+/, '').toLowerCase();
  if (!target) return text;

  // Mask [[...]] spans so a match inside one is never considered, then restore
  // them verbatim.
  const links: string[] = [];
  const masked = text.replace(/\[\[[^\]]*\]\]/g, (m) => {
    links.push(m);
    return `${SENTINEL}${links.length - 1}${SENTINEL}`;
  });

  let removed = false;
  const stripped = masked.replace(TAG_TOKEN_RE, (whole, raw: string) => {
    if (removed) return whole;
    if (raw.toLowerCase() !== target) return whole;
    removed = true;
    return '';
  });
  if (!removed) return text;

  const maskRe = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');
  let result = stripped.replace(maskRe, (_m, i: string) => links[Number(i)] ?? '');
  // Collapse the gap the tag left behind (its leading space and any doubles),
  // then drop a leading space when the tag STARTED the text (nothing precedes
  // it to act as the separator).
  result = result
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/^[ \t]+/, '');
  return result;
}
