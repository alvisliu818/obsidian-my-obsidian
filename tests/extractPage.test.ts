/**
 * Extract-to-page: naming, reference syntax, and the in-place replacement.
 *
 * The naming rules get the most attention because they are the part that can
 * silently produce a broken path: a title containing `/`, `:`, `?` or a very
 * long sentence must still yield a legal, unique, reasonably short file name.
 */

import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';
import { createBlock, type Block } from '../src/types';
import { linkParents, registerRoots, unregisterRoots } from '../src/core/treeOps';
import {
  MAX_NAME_LEN,
  extractedPageMarkdown,
  extractNotice,
  pageEmbedSyntax,
  pageNameFor,
  replaceWithPageEmbed,
  uniquePageName,
} from '../src/features/extractPage';

describe('pageNameFor', () => {
  it('uses the block text as the page title', () => {
    expect(pageNameFor('Project plan')).toBe('Project plan');
    expect(pageNameFor('First line\nsecond line')).toBe('First line');
  });

  it('strips list and heading markers so one idea yields one page', () => {
    expect(pageNameFor('- Project plan')).toBe('Project plan');
    expect(pageNameFor('## Meeting notes')).toBe('Meeting notes');
    expect(pageNameFor('> quoted idea')).toBe('quoted idea');
  });

  it('strips inline markup', () => {
    expect(pageNameFor('**Bold** idea')).toBe('Bold idea');
    expect(pageNameFor('`code` and _em_')).toBe('code and em');
  });

  it('replaces characters a file name cannot contain', () => {
    // `/` would create a directory, `:` and `?` are illegal on Windows,
    // `#` and `^` and `[]` confuse Obsidian's own link syntax.
    expect(pageNameFor('Q1/Q2 plan')).toBe('Q1 Q2 plan');
    expect(pageNameFor('why? because: yes')).toBe('why because yes');
    expect(pageNameFor('a|b #c ^d [e]')).toBe('a b c d e');
    expect(pageNameFor('back\\slash')).toBe('back slash');
  });

  it('never returns a path with a separator in it', () => {
    for (const t of ['a/b', 'a\\b', '../../etc/passwd', 'a:b', 'x?y']) {
      expect(pageNameFor(t)).not.toMatch(/[\\/:*?"<>|#^[\]]/);
    }
  });

  it('caps the length and trims the cut', () => {
    const long = 'word '.repeat(60);
    const name = pageNameFor(long);
    expect(name.length).toBeLessThanOrEqual(MAX_NAME_LEN);
    expect(name.endsWith(' ')).toBe(false);
  });

  it('returns empty when there is no usable text', () => {
    expect(pageNameFor('')).toBe('');
    expect(pageNameFor('   ')).toBe('');
    expect(pageNameFor('\n\n')).toBe('');
    // Markup only — nothing left to name a page after.
    expect(pageNameFor('***')).toBe('');
    expect(pageNameFor('---')).toBe('');
  });

  it('collapses runs of whitespace', () => {
    expect(pageNameFor('a    b\t\tc')).toBe('a b c');
  });
});

describe('uniquePageName', () => {
  it('keeps the name when it is free', () => {
    expect(uniquePageName('Report', ['Notes', 'Other'])).toBe('Report');
  });

  it('suffixes on collision', () => {
    expect(uniquePageName('Report', ['Report'])).toBe('Report 1');
    expect(uniquePageName('Report', ['Report', 'Report 1'])).toBe('Report 2');
    expect(uniquePageName('Report', ['Report', 'Report 1', 'Report 2'])).toBe('Report 3');
  });

  it('compares case-insensitively, like macOS and Windows do', () => {
    expect(uniquePageName('Report', ['report'])).toBe('Report 1');
  });

  it('probes past a gap instead of stopping at the first free slot', () => {
    expect(uniquePageName('Report', ['Report', 'Report 2'])).toBe('Report 1');
  });

  it('falls back to Untitled for an unusable name', () => {
    expect(uniquePageName('   ', [])).toBe('Untitled');
    expect(uniquePageName('///', [])).toBe('Untitled');
  });

  it('cleans illegal characters out of the base too', () => {
    expect(uniquePageName('a/b:c', [])).toBe('a b c');
  });
});

describe('pageEmbedSyntax', () => {
  it('is the ordinary page-embed form the renderer already understands', () => {
    expect(pageEmbedSyntax('Report')).toBe('![[Report]]');
  });
});

describe('extractedPageMarkdown', () => {
  it('writes the subtree as ordinary top-level blocks', () => {
    const doc = parseDocument('- parent\n\t- child a\n\t- child b\n- next');
    const md = extractedPageMarkdown([doc.blocks[0]]);
    expect(md).toBe('- parent\n\t- child a\n\t- child b');
    // …and it re-parses as the same tree, so the new page is a real outline.
    const re = parseDocument(md);
    expect(re.blocks).toHaveLength(1);
    expect(re.blocks[0].children.map((c) => c.text)).toEqual(['child a', 'child b']);
  });

  it('serializes several blocks in order', () => {
    const doc = parseDocument('- one\n- two');
    expect(extractedPageMarkdown(doc.blocks)).toBe('- one\n- two');
  });

  it('carries the subtree even when a nested block is collapsed', () => {
    const doc = parseDocument('- parent\n\tcollapsed:: true\n\t- hidden');
    const md = extractedPageMarkdown([doc.blocks[0]]);
    expect(md).toContain('hidden');
    expect(md).toContain('collapsed:: true');
  });
});

describe('replaceWithPageEmbed', () => {
  const setup = (md: string) => {
    const doc = parseDocument(md);
    linkParents(doc.blocks);
    registerRoots(doc.blocks);
    return doc;
  };

  it('puts the embed exactly where the block was', () => {
    const doc = setup('- one\n- two\n- three');
    const embed = replaceWithPageEmbed(doc.blocks, doc.blocks[1], 'Two');
    expect(embed).not.toBeNull();
    expect(doc.blocks.map((b) => b.text)).toEqual(['one', '![[Two]]', 'three']);
    expect(embed?.parent).toBeNull();
    unregisterRoots(doc.blocks);
  });

  it('keeps a nested block in its parent, at the same index', () => {
    const doc = setup('- parent\n\t- a\n\t- b\n\t- c\n- other');
    const parent = doc.blocks[0];
    const b = parent.children[1];
    const embed = replaceWithPageEmbed(doc.blocks, b, 'B page');
    expect(parent.children.map((c) => c.text)).toEqual(['a', '![[B page]]', 'c']);
    expect(embed?.parent).toBe(parent);
    unregisterRoots(doc.blocks);
  });

  it('detaches the moved subtree from the original position', () => {
    const doc = setup('- parent\n\t- a\n\t- b');
    const parent = doc.blocks[0];
    const before = parent.children.length;
    replaceWithPageEmbed(doc.blocks, parent, 'P');
    // The block itself is gone from the outline…
    expect(doc.blocks).toHaveLength(1);
    // …and it no longer claims the children that moved to the new page.
    expect(parent.children).toHaveLength(0);
    expect(before).toBe(2);
    unregisterRoots(doc.blocks);
  });

  it('returns null when the block is not in the given tree', () => {
    const doc = setup('- one');
    const stray = createBlock('stray');
    expect(replaceWithPageEmbed(doc.blocks, stray, 'X')).toBe(null);
    unregisterRoots(doc.blocks);
  });

  it('the file still round-trips: a reference plus a real page', () => {
    const doc = setup('- parent\n\t- detail\n- other');
    const parent = doc.blocks[0];
    const body = extractedPageMarkdown([parent]);
    replaceWithPageEmbed(doc.blocks, parent, 'Parent');
    const text = serializeDocument(doc);
    // Original note: the embed, and NOT the inlined detail any more.
    expect(text).toContain('![[Parent]]');
    expect(text).not.toContain('detail');
    // New page: the detail, as a normal outline.
    expect(body).toContain('detail');
    const re = parseDocument(text);
    expect(re.blocks.map((b) => b.text)).toEqual(['![[Parent]]', 'other']);
  });
});

describe('extractNotice', () => {
  it('counts blocks only when there is more than one', () => {
    expect(extractNotice(1, 'Report')).toBe('Extracted to Report');
    expect(extractNotice(3, 'Report')).toBe('Extracted 3 blocks to Report');
  });
});

describe('sanity: a block with no text cannot name a page', () => {
  it('is reported as unusable so the caller asks', () => {
    const empty: Block = createBlock('');
    expect(pageNameFor(empty.text)).toBe('');
  });
});
