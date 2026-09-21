/**
 * Flashcard review application: write SM-2 scheduling props back into the
 * owning block (files stay 100% standard markdown), then rebuild the index.
 */

import { Notice, TFile, type App } from 'obsidian';
import { parseDocument } from '../core/parser';
import { serializeDocument } from '../core/serializer';
import { findBlockById, linkParents } from '../core/treeOps';
import { ensureId } from '../types';
import type LogseqEditorPlugin from '../main';
import { review, stateFromProps, stateToProps, type Grade } from './srs';
import { BlockEditorView, VIEW_TYPE_BLOCK_EDITOR } from '../view/BlockEditorView';

/**
 * Apply a review grade to a card block: read → parse → mutate props → write.
 * Returns true on success.
 */
export async function applyReview(
  app: App,
  plugin: LogseqEditorPlugin,
  path: string,
  blockId: string | undefined,
  grade: Grade,
): Promise<boolean> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) {
    new Notice(`Card file not found: ${path}`);
    return false;
  }
  let data: string;
  try {
    data = await app.vault.read(f);
  } catch (e) {
    new Notice(`Failed to read card file: ${String(e)}`);
    return false;
  }

  const doc = parseDocument(data);
  linkParents(doc.blocks);

  // Locate the card: prefer the id, else the first #card block in the file.
  let block = blockId ? findBlockById(doc.blocks, blockId) : null;
  if (!block && !blockId) {
    block = findFirstCard(doc.blocks);
  }
  if (!block) {
    new Notice('Card block not found — it may have been edited elsewhere.');
    return false;
  }

  ensureId(block); // cards need stable ids for future reviews
  const next = review(stateFromProps(block.props), grade);
  stateToProps(next, block.props);

  // Guarded write: automatic backup + operation log (v0.2.0 safety layer).
  const ok = await plugin.backups.safeProcess(f, () => serializeDocument(doc), 'srs.review');
  if (!ok) return false;

  // Reload any open editor view of this file so our own write is not treated
  // as a conflicting external change (and stale in-memory state is dropped).
  const out = serializeDocument(doc);
  for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_BLOCK_EDITOR)) {
    const view = leaf.view;
    if (view instanceof BlockEditorView && view.file?.path === path) {
      view.setViewData(out, false);
    }
  }

  // Refresh the index so due lists update immediately.
  void plugin.blockIndex?.buildAll();
  return true;
}

function findFirstCard(roots: import('../types').Block[]): import('../types').Block | null {
  const walk = (b: import('../types').Block): import('../types').Block | null => {
    const bare = b.text.replace(/\[\[[^\]]*\]\]/g, ' ');
    if (/(?:^|\s)#card\b/i.test(bare)) return b;
    for (const c of b.children) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  for (const r of roots) {
    const hit = walk(r);
    if (hit) return hit;
  }
  return null;
}
