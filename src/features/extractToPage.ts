/**
 * Extract blocks to their own page, leaving a page embed behind.
 *
 * The destination is a brand-new note whose name is derived from the extracted
 * block's own text, so "move this detail out" is one action rather than
 * create-page-then-paste-then-delete. Both files end up as ordinary markdown:
 * the new page is a normal outline, and the original keeps an `![[Page]]`
 * embed at exactly the position the block occupied.
 *
 * Ordering matters: the new page is created FIRST, so a failure there leaves
 * the source untouched. Only after the write succeeds is the source mutated.
 */

import { Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import type { BlockEditorView } from '../view/BlockEditorView';
import { containsBlock, isDescendant } from '../core/treeOps';
import type { Block } from '../types';
import {
  extractNotice,
  extractedPageMarkdown,
  pageNameFor,
  replaceWithPageEmbed,
  uniquePageName,
} from './extractPage';

/** The blocks an extract acts on: the multi-selection, else the focused one. */
export function extractCandidates(host: BlockEditorView): Block[] {
  const sel = host.topSelectedBlocks();
  if (sel.length > 0) return sel;
  const b = host.focusedBlock ?? host.lastEditedBlock;
  return b ? [b] : [];
}

/**
 * Prompt for the destination page name, then perform the extract.
 *
 * The suggested name comes from the block text; an empty suggestion (an empty
 * block) means the user must type one — we never invent a page name.
 */
export function openExtractToPageModal(host: BlockEditorView, blocks: Block[]): void {
  if (blocks.length === 0) {
    new Notice('Focus a block first.');
    return;
  }
  new ExtractToPageModal(host, blocks).open();
}

class ExtractToPageModal extends Modal {
  private name: string;

  constructor(
    private host: BlockEditorView,
    private blocks: Block[],
  ) {
    super(host.app);
    // One name for the whole selection: naming each block separately would
    // produce N pages from one gesture, which is not what "extract" means.
    const suggested = blocks.length === 1 ? pageNameFor(blocks[0].text) : '';
    this.name = suggested;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Extract to a new page' });
    contentEl.createEl('p', {
      cls: 'logseq-modal-hint',
      text:
        this.blocks.length > 1
          ? `${this.blocks.length} blocks will move to the new page, and an embed of it stays behind here.`
          : 'This block and its children move to the new page, and an embed of it stays behind here.',
    });
    new Setting(contentEl).setName('Page name').addText((t) =>
      t
        .setPlaceholder(this.blocks[0] ? pageNameFor(this.blocks[0].text) : 'Untitled')
        .setValue(this.name)
        .onChange((v) => {
          this.name = v;
        }),
    );
    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('Cancel')
          .onClick(() => this.close()),
      )
      .addButton((btn) =>
        btn
          .setButtonText('Extract')
          .setCta()
          .onClick(() => {
            const name = this.name.trim();
            this.close();
            if (!name) {
              new Notice('A page name is required.');
              return;
            }
            void extractBlocksToPage(this.host, this.blocks, name);
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Move `blocks` (and their sub-trees) into a new page, leaving an embed behind.
 *
 * Steps, in order:
 *  1. serialize the sub-trees (removal detaches them, so read them first);
 *  2. commit + unfocus if the live editor is inside a moved sub-tree — the
 *     focused block object is about to leave the document;
 *  3. create the destination page, creating any missing folder;
 *  4. only then mutate the source, replacing each block with the embed.
 *
 * A failure at step 3 aborts with the source untouched.
 */
export async function extractBlocksToPage(
  host: BlockEditorView,
  blocks: Block[],
  rawName: string,
): Promise<boolean> {
  // Only blocks that are really in this document — at ANY depth. Membership
  // was tested with `doc.blocks.includes(b)`, which is true for root blocks
  // only, so extracting a nested block found nothing to move and returned
  // false in silence. And only the outermost of a nested group: a member
  // carried by another member is already part of that member's serialized
  // sub-tree, so exporting it again would duplicate it.
  const present = blocks.filter((b) => b && containsBlock(host.doc.blocks, b));
  const moving = present.filter((b) => !present.some((o) => o !== b && isDescendant(o, b)));
  if (moving.length === 0) return false;

  const body = extractedPageMarkdown(moving);
  const folder = host.file?.parent?.path ?? '/';
  const name = uniquePageName(
    rawName,
    host.app.vault.getMarkdownFiles().map((f) => f.basename),
  );
  const path = normalizePath(folder === '/' ? `${name}.md` : `${folder}/${name}.md`);

  // An existing file at the path would be silently appended to, mixing two
  // pages. `uniquePageName` only guards the basename within the vault.
  if (host.app.vault.getAbstractFileByPath(path)) {
    new Notice(`${path} already exists`);
    return false;
  }

  // 2. The focused editor may live inside a block that is about to move.
  const f = host.focusedBlock;
  if (f && moving.some((b) => b === f || isDescendant(b, f))) host.commitFocusedText();

  let created: TFile;
  try {
    if (folder !== '/' && !host.app.vault.getAbstractFileByPath(folder)) {
      await host.app.vault.createFolder(folder);
    }
    created = await host.app.vault.create(path, body);
  } catch (e) {
    new Notice(`Could not create ${name}: ${String(e)}`, 6000);
    return false;
  }

  // 4. Replace each moved block with an embed, in place.
  let embeds: Block[] = [];
  host.mutate(
    () => {
      embeds = [];
      for (const b of moving) {
        const z = host.zoomedBlock;
        if (z && (z === b || isDescendant(b, z))) host.zoomedBlock = null;
        const embed = replaceWithPageEmbed(host.doc.blocks, b, created.basename);
        if (embed) embeds.push(embed);
      }
    },
    () => ({ full: true }),
  );
  host.selectedBlocks.clear();
  host.syncSelectionClasses();

  new Notice(extractNotice(moving.length, created.basename));
  return true;
}
