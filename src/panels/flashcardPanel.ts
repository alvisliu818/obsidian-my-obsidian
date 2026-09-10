/**
 * Flashcard review panel (right sidebar): due #card blocks with an
 * Anki-style question → reveal answer → Again/Hard/Good/Easy flow.
 */

import { ItemView, MarkdownRenderer, type WorkspaceLeaf } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import type { CardEntry } from '../index/blockIndex';
import { isDue, stateFromProps, type Grade } from '../features/srs';
import { applyReview } from '../features/flashcards';
import { plainText } from '../features/query';

export const VIEW_TYPE_FLASHCARD_PANEL = 'logseq-flashcard-panel';

const GRADES: { g: Grade; label: string; cls: string }[] = [
  { g: 'again', label: 'Again', cls: 'fc-grade-again' },
  { g: 'hard', label: 'Hard', cls: 'fc-grade-hard' },
  { g: 'good', label: 'Good', cls: 'fc-grade-good' },
  { g: 'easy', label: 'Easy', cls: 'fc-grade-easy' },
];

export class FlashcardPanelView extends ItemView {
  plugin: LogseqEditorPlugin;
  private disposer: (() => void) | null = null;
  /** Cards due at the time the current session was loaded. */
  private queue: CardEntry[] = [];
  private queueVersion = -1;
  private done = 0;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_FLASHCARD_PANEL;
  }
  getDisplayText(): string {
    return 'Logseq flashcards';
  }
  getIcon(): string {
    return 'graduation-cap';
  }

  onload(): void {
    this.disposer = this.plugin.blockIndex?.onRebuild(() => this.onIndexRebuild()) ?? null;
  }

  onunload(): void {
    this.disposer?.();
    this.disposer = null;
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('logseq-panel');
    this.contentEl.addClass('logseq-fc-panel');
    this.renderSession();
  }

  async onClose(): Promise<void> {
    this.disposer?.();
    this.disposer = null;
  }

  // ------------------------------------------------------------------

  /** Restart the session when a rebuild happened but we have no pending queue. */
  private onIndexRebuild(): void {
    if (this.queue.length === 0) {
      this.renderSession();
    }
  }

  private dueCards(): CardEntry[] {
    return (this.plugin.blockIndex?.allCards() ?? []).filter((c) =>
      isDue(stateFromProps(c.props)),
    );
  }

  private renderSession(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('div', { cls: 'logseq-panel-header' }).createEl('div', {
      cls: 'logseq-panel-title',
      text: 'Flashcards',
    });

    const idx = this.plugin.blockIndex;
    if (!idx) {
      contentEl.createEl('div', { cls: 'logseq-panel-empty', text: 'Index unavailable.' });
      return;
    }

    // Reload the queue once per index version.
    if (this.queueVersion !== idx.version) {
      this.queue = this.dueCards();
      this.queueVersion = idx.version;
      this.done = 0;
    }

    const total = this.queue.length + this.done;
    if (total === 0) {
      contentEl.createEl('div', { cls: 'logseq-panel-empty', text: 'No cards yet — tag a block with #card to create one.' });
      return;
    }

    const progress = contentEl.createEl('div', { cls: 'fc-progress' });
    progress.setText(`${this.done} / ${total} reviewed`);
    const bar = contentEl.createEl('div', { cls: 'fc-progress-bar' });
    bar.createEl('div', { cls: 'fc-progress-fill' }).style.width = `${total ? (this.done / total) * 100 : 0}%`;

    if (this.queue.length === 0) {
      const done = contentEl.createEl('div', { cls: 'logseq-panel-empty' });
      done.setText('Session complete. 🎉');
      const restart = contentEl.createEl('button', { cls: 'fc-restart', text: 'Load new due cards' });
      restart.addEventListener('click', () => {
        this.queueVersion = -1;
        this.renderSession();
      });
      return;
    }

    const card = this.queue[0];
    contentEl.appendChild(this.cardEl(card));
  }

  private cardEl(card: CardEntry): HTMLElement {
    const el = document.createElement('div');
    el.className = 'fc-card';

    // Question side (always visible).
    const q = el.createEl('div', { cls: 'fc-question' });
    void MarkdownRenderer.render(
      this.app,
      card.question,
      q,
      card.path,
      this,
    );
    el.createEl('div', { cls: 'fc-src', text: card.path });

    // Answer side (revealed on demand).
    const reveal = el.createEl('button', { cls: 'fc-reveal', text: 'Show answer' });
    const a = el.createEl('div', { cls: 'fc-answer' });
    a.style.display = 'none';
    let revealed = false;
    reveal.addEventListener('click', () => {
      if (revealed) return;
      revealed = true;
      reveal.style.display = 'none';
      a.style.display = '';
      if (card.answer) {
        void MarkdownRenderer.render(this.app, card.answer, a, card.path, this);
      } else {
        a.setText(plainText(card.question)); // cloze-style: question is the answer
      }
      grades.style.display = '';
    });

    // Grade buttons.
    const grades = el.createEl('div', { cls: 'fc-grades' });
    grades.style.display = 'none';
    for (const { g, label, cls } of GRADES) {
      const b = grades.createEl('button', { cls: 'fc-grade ' + cls, text: label });
      b.addEventListener('click', () => void this.grade(card, g));
    }

    // Jump to the block.
    const jump = el.createEl('div', { cls: 'fc-jump', text: 'edit card ↗' });
    jump.addEventListener('click', () => {
      if (card.blockId) void this.plugin.openBlockRef(card.blockId);
      else void this.plugin.app.workspace.openLinkText(card.path, '', false);
    });
    return el;
  }

  private async grade(card: CardEntry, g: Grade): Promise<void> {
    await applyReview(this.app, this.plugin, card.path, card.blockId || undefined, g);
    this.queue.shift();
    this.done++;
    // The index rebuild is async; show the next card from the stale queue and
    // let the rebuild listener/version check re-sync when it lands.
    this.renderNext();
  }

  /** Render the next card without resetting the session (queue already shifted). */
  private renderNext(): void {
    if (this.queue.length === 0) {
      this.queueVersion = this.plugin.blockIndex?.version ?? this.queueVersion;
      this.renderSession();
      return;
    }
    // Replace only the card element (keep progress header fresh via full render
    // but preserve queue state — queueVersion already matches the loaded set).
    this.renderSession();
  }
}
