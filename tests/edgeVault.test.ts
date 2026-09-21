/**
 * Edge-fixture invariants, driven by the generated sample vault
 * (tests/fixtures/edge-vault — run `node tests/fixtures/make-edge-vault.mjs`
 * first; skipped automatically when the vault has not been generated).
 *
 * For EVERY sample file, the parser must:
 *  1. never throw (hostile input degrades, it does not crash),
 *  2. round-trip idempotently: serialize(parse(x)) re-parses to the same tree.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';
import { linkParents } from '../src/core/treeOps';
import type { Block } from '../src/types';

const VAULT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'edge-vault');

const hasVault = existsSync(VAULT);
const d = it.skip ?? it;
const vaultTest = hasVault ? it : d;

function sampleFiles(): string[] {
  return readdirSync(VAULT)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(VAULT, f));
}

/** Structural snapshot of a parsed tree (kind/marker/text/prop-keys/children). */
function shape(b: Block): unknown {
  return {
    k: b.kind,
    m: b.marker,
    t: b.text,
    p: b.props,
    c: b.children.map(shape),
  };
}

describe('edge fixture vault', () => {
  vaultTest('sample vault exists with the expected hostile files', () => {
    const files = sampleFiles().map((f) => f.replace(VAULT + '\\', '').replace(VAULT + '/', ''));
    for (const required of [
      'empty.md',
      'broken-frontmatter.md',
      'org-mode.md',
      'special-chars.md',
      'circular-embed.md',
      'huge.md',
    ]) {
      expect(files).toContain(required);
    }
  });

  for (const file of existsSync(VAULT) ? sampleFiles() : []) {
    const name = file.replace(VAULT + '\\', '').replace(VAULT + '/', '');
    vaultTest(`parses without throwing: ${name}`, () => {
      const md = readFileSync(file, 'utf8');
      expect(() => {
        const doc = parseDocument(md);
        linkParents(doc.blocks);
        serializeDocument(doc);
      }).not.toThrow();
    });

    vaultTest(`round-trip is idempotent: ${name}`, () => {
      const md = readFileSync(file, 'utf8');
      const doc1 = parseDocument(md);
      linkParents(doc1.blocks);
      const once = serializeDocument(doc1);
      const doc2 = parseDocument(once);
      linkParents(doc2.blocks);
      const twice = serializeDocument(doc2);
      expect(twice).toBe(once);
      expect(doc2.blocks.map(shape)).toEqual(doc1.blocks.map(shape));
    });
  }

  vaultTest('huge file parses to a large forest quickly enough', () => {
    const md = readFileSync(join(VAULT, 'huge.md'), 'utf8');
    const t0 = Date.now();
    const doc = parseDocument(md);
    linkParents(doc.blocks);
    serializeDocument(doc);
    expect(doc.blocks.length).toBeGreaterThan(1000);
    // Generous CI-safe ceiling for ~1.7 MB / ~30k blocks.
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  vaultTest('circular embed stays plain text (no runtime recursion risk)', () => {
    const md = readFileSync(join(VAULT, 'circular-embed.md'), 'utf8');
    const doc = parseDocument(md);
    linkParents(doc.blocks);
    const flat: string[] = [];
    const walk = (b: Block) => {
      flat.push(b.text);
      b.children.forEach(walk);
    };
    doc.blocks.forEach(walk);
    expect(flat.some((t) => t.includes('{{embed ((44444444'))).toBe(true);
  });

  vaultTest('empty and whitespace files parse to empty docs', () => {
    expect(parseDocument(readFileSync(join(VAULT, 'empty.md'), 'utf8')).blocks).toHaveLength(0);
    expect(parseDocument(readFileSync(join(VAULT, 'whitespace.md'), 'utf8')).blocks).toHaveLength(0);
  });
});
