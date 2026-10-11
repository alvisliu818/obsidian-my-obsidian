/**
 * Block type menu (SiYuan parity): every block has a type, and the type can be
 * changed from the gutter badge, the right-click menu or the command palette.
 *
 * Conversion rewrites the block's markdown — nothing else — so the file stays
 * plain markdown and the type is re-derived from it on the next read.
 */

import { FuzzySuggestModal, Menu, Modal, Notice, Setting, setIcon, type IconName } from 'obsidian';
import type { BlockRenderHost } from '../blocks/renderHost';
import { blockId, type Block } from '../types';
import {
  blockTypeMeta,
  detectBlockType,
  headingLevel,
  isVerbatimType,
  type BlockType,
} from './blockTypes';
import {
  CALLOUT_KINDS,
  CONVERT_TARGETS,
  convertBlock,
  conversionLosesIdentity,
  setCalloutKind,
  setCodeLang,
  setHeadingLevel,
  type BlockShape,
  type ConvertOptions,
} from './blockTypeConvert';

/** Common fence languages offered before the free-text prompt. */
const COMMON_LANGS: readonly string[] = [
  'text',
  'js',
  'ts',
  'python',
  'bash',
  'json',
  'yaml',
  'sql',
  'html',
  'css',
  'markdown',
  'prolog',
];

/** Rewrite one block's markdown to match `to`. */
export function applyBlockType(
  host: BlockRenderHost,
  b: Block,
  to: BlockType,
  opts: ConvertOptions = {},
): boolean {
  const shape: BlockShape = { kind: b.kind, text: b.text, marker: b.marker };
  const next = convertBlock(shape, to, opts);
  const kindChanged = next.kind !== b.kind;

  // A verbatim block (table / divider / list / footnote) serializes as-is:
  // children would vanish on the next save and inbound ((id)) links break.
  if (conversionLosesIdentity(shape, to) && b.children.length > 0) {
    new Notice(
      'Move the child blocks out first — this block type cannot contain them.',
    );
    return false;
  }
  if (conversionLosesIdentity(shape, to) && blockId(b)) {
    new Notice(`Becoming a ${blockTypeMeta(to).label} drops this block's id — ((ref)) links to it will break.`);
  }

  host.mutate(
    () => {
      b.kind = next.kind;
      b.text = next.text;
      b.marker = next.marker ?? null;
    },
    // A kind change swaps the block's whole DOM shape; rebuild everything.
    () => (kindChanged ? { full: true } : { subtree: b }),
  );
  return true;
}

/** Apply a parameter-only rewrite (heading level, callout kind, fence lang). */
function applyRewrite(host: BlockRenderHost, b: Block, next: BlockShape | null): void {
  if (!next) return;
  host.mutate(
    () => {
      b.kind = next.kind;
      b.text = next.text;
      if (next.marker !== undefined) b.marker = next.marker;
    },
    () => ({ subtree: b }),
  );
}

/**
 * The type menu. `at` pins it to a position (gutter badge click); without it
 * the menu follows the mouse (right-click).
 */
export function openBlockTypeMenu(
  host: BlockRenderHost,
  b: Block,
  at: { x: number; y: number },
): Menu {
  const menu = new Menu();
  const current = detectBlockType(b);
  let hasParams = false;

  // --- parameters of the current type ---
  if (current === 'heading') {
    hasParams = true;
    const level = headingLevel(b.text);
    addSubmenu(menu, 'Heading level', 'heading', at, (sub) => {
      for (let lv = 1; lv <= 6; lv++) {
        sub.addItem((item) =>
          item
            .setTitle(`Level ${lv}`)
            .setChecked(lv === level)
            .onClick(() => applyRewrite(host, b, setHeadingLevel(b, lv))),
        );
      }
    });
  }
  if (current === 'callout') {
    hasParams = true;
    const kind = (b.text.match(/\[!([a-zA-Z][\w-]*)\]/)?.[1] ?? 'note').toLowerCase();
    addSubmenu(menu, 'Callout kind', 'palette', at, (sub) => {
      for (const k of CALLOUT_KINDS) {
        sub.addItem((item) =>
          item
            .setTitle(k)
            .setChecked(k === kind)
            .onClick(() => applyRewrite(host, b, setCalloutKind(b, k))),
        );
      }
    });
  }
  if (current === 'code') {
    hasParams = true;
    const lang = (b.text.match(/^(`{3,}|~{3,})(\S*)/)?.[2] ?? '').toLowerCase();
    addSubmenu(menu, 'Code language', 'code', at, (sub) => {
      for (const l of COMMON_LANGS) {
        sub.addItem((item) =>
          item
            .setTitle(l)
            .setChecked(l === lang)
            .onClick(() => applyRewrite(host, b, setCodeLang(b, l))),
        );
      }
      sub.addItem((item) =>
        item
          .setTitle('Other…')
          .setIcon('pencil')
          .onClick(() => new LangPromptModal(host, b, lang).open()),
      );
    });
  }
  if (hasParams) menu.addSeparator();

  // --- conversion targets ---
  for (const t of CONVERT_TARGETS) {
    const meta = blockTypeMeta(t);
    menu.addItem((item) => {
      item.setTitle(meta.label).setIcon(meta.icon as IconName);
      if (t === current) item.setChecked(true);
      // A verbatim type cannot hold children — flag it before the click loses them.
      if (isVerbatimType(t) && b.children.length > 0) item.setWarning(true);
      item.onClick(() => applyBlockType(host, b, t));
    });
  }

  menu.showAtPosition(at);
  return menu;
}

/**
 * Obsidian's `MenuItem` has no `setSubmenu` in this API version, so a submenu
 * is a second `Menu` opened on click — at the pointer, or at the parent menu's
 * anchor when the item was activated from the keyboard.
 */
function addSubmenu(
  parent: Menu,
  title: string,
  icon: string,
  anchor: { x: number; y: number },
  build: (sub: Menu) => void,
): void {
  parent.addItem((item) =>
    item.setTitle(title).setIcon(icon as IconName).onClick((evt) => {
      const sub = new Menu();
      build(sub);
      const e = evt as MouseEvent;
      if (typeof e.clientX === 'number' && e.clientX > 0) sub.showAtMouseEvent(e);
      else sub.showAtPosition({ x: anchor.x + 14, y: anchor.y + 14 });
    }),
  );
}

/** Free-text fence language. */
class LangPromptModal extends Modal {
  constructor(
    private host: BlockRenderHost,
    private block: Block,
    private current: string,
  ) {
    super(host.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    let value = this.current;
    new Setting(contentEl).setName('Code language').addText((t) =>
      t
        .setPlaceholder('ts, python, …')
        .setValue(this.current)
        .onChange((v) => {
          value = v.trim();
        }),
    );
    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Apply')
        .setCta()
        .onClick(() => {
          this.close();
          applyRewrite(this.host, this.block, setCodeLang(this.block, value));
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Command palette: pick a type for the focused block
// ---------------------------------------------------------------------------

interface TypeChoice {
  id: BlockType;
  label: string;
  hint: string;
}

class BlockTypeSuggestModal extends FuzzySuggestModal<TypeChoice> {
  constructor(
    private host: BlockRenderHost,
    private block: Block,
    private choices: TypeChoice[],
  ) {
    super(host.app);
    this.setPlaceholder('Convert block to…');
  }

  getItems(): TypeChoice[] {
    return this.choices;
  }

  getItemText(c: TypeChoice): string {
    return `${c.label} — ${c.hint}`;
  }

  onChooseItem(c: TypeChoice): void {
    applyBlockType(this.host, this.block, c.id);
  }
}

/** Command entry: convert the focused (or selected) block to another type. */
export function openBlockTypePicker(host: BlockRenderHost): void {
  const targets = host.selectedBlocks.size > 0 ? host.topSelectedBlocks() : [];
  const b = targets[0] ?? host.focusedBlock ?? host.lastEditedBlock;
  if (!b) {
    new Notice('Focus a block first.');
    return;
  }
  const choices: TypeChoice[] = CONVERT_TARGETS.map((t) => ({
    id: t,
    label: blockTypeMeta(t).label,
    hint: blockTypeMeta(t).hint,
  }));
  new BlockTypeSuggestModal(host, b, choices).open();
}

/** The gutter badge: an icon that names the block's type and opens the menu. */
export function renderBlockTypeBadge(
  parent: HTMLElement,
  host: BlockRenderHost,
  b: Block,
  type: BlockType,
): HTMLElement {
  const badge = parent.createEl('div', { cls: 'block-type-badge' });
  badge.setAttribute('aria-label', `Block type: ${blockTypeMeta(type).label}`);
  badge.setAttribute('title', `${blockTypeMeta(type).label} — click to change`);
  setIcon(badge, blockTypeMeta(type).icon as IconName);
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = badge.getBoundingClientRect();
    openBlockTypeMenu(host, b, { x: r.left, y: r.bottom });
  });
  return badge;
}
