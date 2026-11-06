/**
 * Inline memo (SiYuan InlineMemo.ts / inlineMemoSelection.ts semantics, batch
 * 27): `((text))` where the payload is NOT a block-ref UUID. SiYuan's toolbar
 * has separate block-ref and memo buttons sharing one syntax pair,
 * disambiguated by payload shape — same here: features/links.ts renders the
 * UUID form as block-ref chips, the free-text form as memo chips.
 *
 * Pure judgement only — the CM dispatch layer lives in textSelectionMenu.ts
 * (memoToggleSelection) and the static-render pass in features/links.ts
 * (enhanceInlineMemos); all three share these predicates.
 */

/** Block-ref UUID form — takes precedence over the memo reading. */
export function isBlockRefForm(payload: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    payload,
  );
}

/** Valid memo payload: non-empty, single line, no parens, not a block ref. */
export function isMemoPayload(s: string): boolean {
  return s.length > 0 && !/\n/.test(s) && !/[()]/.test(s) && !isBlockRefForm(s);
}

/** Minimal sliceable doc — satisfied by CM's Text. */
export interface SliceableDoc {
  sliceString(from: number, to?: number): string;
}

/** True when [from, to) sits exactly inside a `((memo))` pair. */
export function isMemoSpanAt(doc: SliceableDoc, from: number, to: number): boolean {
  if (from < 2) return false;
  return (
    doc.sliceString(from - 2, from) === '((' &&
    doc.sliceString(to, to + 2) === '))' &&
    isMemoPayload(doc.sliceString(from, to))
  );
}
