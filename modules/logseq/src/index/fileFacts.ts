/**
 * The ONE markdown -> facts extractor.
 *
 * Markdown is the source of truth. This module is the only place that decides
 * what a .md file MEANS: it turns file text into a flat, document-ordered list
 * of block facts plus the page's properties.
 *
 * Both index materializations are derived from it:
 *   - the in-memory `BlockIndex` (fast, per-session, rebuilt on vault events)
 *   - the SQLite secondary index (`sqliteIndex.ts`, rebuildable, persisted)
 *
 * Because they share one extractor they cannot disagree about a file, and
 * either can be dropped and rebuilt from the files on disk at any time —
 * nothing in the database is ever authoritative.
 *
 * Pure logic: no obsidian, no DOM, no wa-sqlite — unit-testable under vitest.
 */

import { parseDocument } from '../core/parser';
import { serializeBlock } from '../core/serializer';
import { docPageProps, type Block } from '../types';
import { normalizeLinkTarget } from '../features/query';

/**
 * Prefix for the synthetic key of a block that has no `id::`. A uuid never
 * starts with `~`, so synthetic keys can never collide with real ids.
 */
export const SYNTHETIC_PREFIX = '~';

const TAG_RE = /(?:^|[\s(])#([\p{L}\d][\p{L}\d_/-]*)/gu;
const LINK_RE = /\[\[([^\]]+)\]\]/g;
/** Block reference scan: ((uuid)) occurrences in block text. */
export const BLOCK_REF_RE = /\(\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)\)\}?/g;

/** Properties the query engine reads — `props` stays narrow on purpose. */
const QUERY_PROPS = ['priority', 'scheduled', 'deadline'] as const;

export interface BlockFact {
  /** Always-unique key: the real uuid, or `~path#ord` when the block has none. */
  bkey: string;
  /** The real `id::` value ('' when the block has none). */
  id: string;
  /** Document order within the file (stable for identical content). */
  ord: number;
  /** Outline depth, 0 at the top level. */
  depth: number;
  /** `bkey` of the parent block ('' at the top level). */
  parentKey: string;
  /** `id` of the parent block ('' when the parent has no id). */
  parentId: string;
  /** First line of the block — what every list/table/query surface shows. */
  text: string;
  marker: string | null;
  /** Normalized page name of the owning file. */
  page: string;
  tags: string[];
  /** Normalized `[[link]]` targets. */
  links: string[];
  /** `((uuid))` targets found in this block's text (self-references excluded). */
  refs: string[];
  /** Query-relevant properties only (priority / scheduled / deadline). */
  props: Record<string, string>;
  /** EVERY block property — supertag collections read their columns here. */
  blockProps: Record<string, string>;
  /** Any block tagged #card is a flashcard; children are the answer side. */
  isCard: boolean;
  /** Serialized children (the answer side); '' for non-cards. */
  answer: string;
}

export interface FileFacts {
  path: string;
  /** Normalized page name (basename, lowercase, no .md). */
  page: string;
  /** Logseq-format page properties (`key:: value` at the top of the file). */
  pageProps: Record<string, string>;
  blocks: BlockFact[];
  /** Every tag appearing in the file, sorted. */
  tags: string[];
}

export function bkeyOf(path: string, ord: number, id: string): string {
  return id || `${SYNTHETIC_PREFIX}${path}#${ord}`;
}

function collectTags(text: string): string[] {
  const bare = text.replace(LINK_RE, ' '); // tags inside [[...]] don't count
  return [...new Set([...bare.matchAll(TAG_RE)].map((m) => m[1].toLowerCase()))];
}

function collectLinks(text: string): string[] {
  return [...new Set([...text.matchAll(LINK_RE)].map((m) => normalizeLinkTarget(m[1])))].filter(Boolean);
}

function collectRefs(text: string, selfId: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(BLOCK_REF_RE)) {
    const id = m[1];
    if (id === selfId) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Prefix every line with `n` tabs. `serializeBlock(b, n)` == indent(serializeBlock(b, 0), n). */
export function indentLines(text: string, n: number): string {
  if (n <= 0 || !text) return text;
  const pad = '\t'.repeat(n);
  return text.split('\n').map((l) => pad + l).join('\n');
}

export function extractFile(path: string, content: string): FileFacts {
  const doc = parseDocument(content);
  const pageProps = docPageProps(doc);
  const page = normalizeLinkTarget(path);
  const blocks: BlockFact[] = [];
  const tagSet = new Set<string>();
  let ord = 0;

  const walk = (b: Block, depth: number, parentKey: string, parentId: string): void => {
    const id = b.props['id'] ?? '';
    const bkey = bkeyOf(path, ord, id);
    const text = b.text.split('\n')[0] ?? '';
    const tags = collectTags(b.text);
    const props: Record<string, string> = {};
    for (const k of QUERY_PROPS) {
      if (b.props[k] !== undefined) props[k] = b.props[k];
    }
    const isCard = tags.includes('card');
    blocks.push({
      bkey,
      id,
      ord,
      depth,
      parentKey,
      parentId,
      text,
      marker: b.marker,
      page,
      tags,
      links: collectLinks(b.text),
      refs: collectRefs(b.text, id),
      props,
      blockProps: { ...b.props },
      isCard,
      answer: isCard ? b.children.map((c) => indentLines(serializeBlock(c, 0), 1)).join('\n') : '',
    });
    ord++;
    for (const t of tags) tagSet.add(t);
    b.children.forEach((c) => walk(c, depth + 1, bkey, id));
  };
  doc.blocks.forEach((b) => walk(b, 0, '', ''));

  return { path, page, pageProps, blocks, tags: [...tagSet].sort() };
}
