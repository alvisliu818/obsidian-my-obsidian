/**
 * Move blocks (a single subtree or the current multi-selection) to another
 * page. Source removal goes through the normal mutation pipeline (undoable,
 * zoom-aware); the destination file gets the serialized markdown appended via
 * vault.process — files stay 100% standard markdown.
 */

import { FuzzySuggestModal, Notice, TFile } from 'obsidian';
import type { BlockEditorView } from '../view/BlockEditorView';
import { serializeBlock } from '../core/serializer';
import { isDescendant, removeBlock } from '../core/treeOps';
import type { Block } from '../types';

/** Fuzzy-pick a destination markdown file, then move the blocks there. */
export function openMoveToFileModal(host: BlockEditorView, blocks: Block[]): void {
  if (blocks.length === 0) return;
  new MoveToFileModal(host, blocks).open();
}

class MoveToFileModal extends FuzzySuggestModal<TFile> {
  constructor(private host: BlockEditorView, private blocks: Block[]) {
    super(host.app);
    this.setPlaceholder(`Move ${blocks.length} block(s) to…`);
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => f.path !== this.host.file?.path);
  }

  getItemText(file: TFile): string {
    return file.basename;
  }

  onChooseItem(file: TFile): void {
    void moveBlocksToFile(this.host, this.blocks, file);
  }
}

export async function moveBlocksToFile(host: BlockEditorView, blocks: Block[], target: TFile): Promise<void> {
  if (blocks.length === 0 || host.file?.path === target.path) return;

  // Serialize before removal (removal detaches the subtrees).
  const md = blocks.map((b) => serializeBlock(b, 0)).join('\n');

  // If the focused editor lives inside a moved subtree, commit & unfocus first.
  const f = host.focusedBlock;
  if (f && blocks.some((b) => b === f || isDescendant(b, f))) host.commitFocusedText();

  host.mutate(
    () => {
      for (const b of blocks) {
        const z = host.zoomedBlock;
        if (z && (z === b || isDescendant(b, z))) host.zoomedBlock = null;
        removeBlock(b);
      }
    },
    () => ({ full: true }),
  );
  host.selectedBlocks.clear();
  host.syncSelectionClasses();

  await host.app.vault.process(target, (data) => {
    const base = data.trimEnd();
    return (base ? base + '\n' : '') + md + '\n';
  });
  new Notice(`Moved ${blocks.length} block(s) to ${target.basename}`);
}
