/**
 * Code editor for a file OUTSIDE the vault.
 *
 * Why this exists rather than deferring to Code Files: that plugin's view is a
 * TextFileView, and measured, `setViewState` on `code-editor` with no TFile
 * mounts the "empty" placeholder — so there is no way to hand it a file the
 * vault has never indexed. It also exposes no plugin API (its only entry point
 * is a static method on the view class). Owning the view is the way to actually
 * open a code file.
 *
 * CodeMirror 6 is already a dependency of this plugin, so this is the same
 * editing substrate used in the block editor — real cursor handling, selection,
 * undo, and the language modes below — with saving redirected to Node fs.
 *
 * Markdown deliberately does NOT come here: it opens in the mount's block view,
 * which is what the user asked for.
 */

import { ItemView, Notice, WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, type KeyBinding, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars, dropCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { readExternalText, writeExternalText } from '../features/extFs';
import { logOp } from '../features/logger';
import type LogseqEditorPlugin from '../main';

export const VIEW_TYPE_EXTERNAL_CODE = 'logseq-external-code';

/** Languages we highlight. Anything else still opens, just unhighlighted. */
function languageFor(ext: string): Extension[] {
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
    case 'json':
      return [javascript()];
    case 'md':
    case 'markdown':
      return [markdown()];
    default:
      return [];
  }
}

/**
 * File types this view is for. Mirrors the set Code Files claims, since that is
 * what a user with it installed would expect to open here.
 */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'json', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'html', 'htm',
  'css', 'scss', 'less', 'vue', 'svelte', 'sql', 'graphql', 'php', 'lua', 'pl', 'r',
]);

/** True when a filename should open in the code editor rather than as markdown. */
export function isCodeFile(name: string): boolean {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  if (!m) return false;
  return CODE_EXTENSIONS.has(m[1].toLowerCase());
}

const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--code-accent, #c792ea)' },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: 'var(--text-normal)' },
  { tag: [t.function(t.variableName), t.labelName], color: 'var(--color-blue, #82aaff)' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: 'var(--color-orange, #ffcb6b)' },
  { tag: [t.definition(t.name), t.separator], color: 'var(--text-normal)' },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.self, t.namespace], color: 'var(--color-cyan, #f78c6c)' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: 'var(--text-muted)' },
  { tag: [t.string, t.inserted], color: 'var(--color-green, #c3e88d)' },
  { tag: t.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: [t.bool, t.null], color: 'var(--color-orange, #ffcb6b)' },
  { tag: t.variableName, color: 'var(--text-normal)' },
  { tag: t.invalid, color: 'var(--text-error)' },
]);

export class ExternalCodeView extends ItemView {
  plugin: LogseqEditorPlugin;
  abs = '';
  fileName = '';
  /** Public so the e2e probe can read the buffer without reaching into privates. */
  editor: EditorView | null = null;
  private lastDiskData = '';
  private saveTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_EXTERNAL_CODE;
  }

  getDisplayText(): string {
    return this.fileName || '代码文件';
  }

  getIcon(): string {
    return 'file-code';
  }

  getState(): Record<string, unknown> {
    return { abs: this.abs, name: this.fileName };
  }

  async onOpen(): Promise<void> {
    // Mounting waits for setState: Obsidian calls onOpen BEFORE setState, so
    // mounting here would build an empty editor for a file whose path and
    // content have not arrived yet — and the state that carries them is the
    // only place they exist.
    if (this.abs) this.mount();
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as { abs?: string; name?: string; content?: string };
    if (typeof s.abs === 'string') this.abs = s.abs;
    if (typeof s.name === 'string') this.fileName = s.name;
    if (typeof s.content === 'string') this.lastDiskData = s.content;
    await super.setState(state, result);
    // Now the path is known; build the editor if onOpen ran before us.
    if (!this.editor && this.abs) this.mount();
  }

  async onClose(): Promise<void> {
    await this.flush();
    this.editor?.destroy();
    this.editor = null;
  }

  // ------------------------------------------------------------------

  private mount(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('logseq-external-code-view');

    const banner = contentEl.createDiv({ cls: 'logseq-external-banner' });
    const name = banner.createSpan({ cls: 'logseq-external-banner-text', text: this.fileName });
    banner.createSpan({ cls: 'logseq-external-banner-path', text: this.abs });
    banner.createSpan({ cls: 'logseq-external-badge', text: '库外' });
    const status = banner.createSpan({ cls: 'logseq-external-hint', text: '与原文件实时同步' });
    const saveBtn = banner.createEl('button', { cls: 'logseq-external-save', text: '保存' });
    saveBtn.addEventListener('click', () => void this.flush(true));

    const host = contentEl.createDiv({ cls: 'logseq-external-code-host' });

    let content = this.lastDiskData;
    if (!content && this.abs) {
      try {
        content = readExternalText(this.abs);
      } catch (e) {
        new Notice(`无法读取 ${this.fileName}：${String(e).slice(0, 100)}`);
        content = '';
      }
    }
    this.lastDiskData = content;

    const ext = (this.fileName.split('.').pop() ?? '').toLowerCase();
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of('  '),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search(),
      syntaxHighlighting(highlightStyle, { fallback: true }),
      EditorView.lineWrapping,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        // The ambient declaration types this as unknown[]; the runtime value is
        // a KeyBinding[], so narrow it here rather than widening the .d.ts to
        // something it cannot actually promise.
        ...(searchKeymap as readonly KeyBinding[]),
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        // Debounced like the vault editor, so typing is not a write per keystroke.
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => void this.flush(), 900);
      }),
      ...languageFor(ext),
    ];

    this.editor = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: host,
    });
    this.editor.focus();
    void name;
    void status;
  }

  /**
   * Write the buffer back to the ORIGINAL file.
   *
   * The file on disk is the note — there is no vault copy and no second source
   * of truth — so saving means writing where the file already lives.
   */
  async flush(notify = false): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.editor || !this.abs) return;
    const data = this.editor.state.doc.toString();
    if (data === this.lastDiskData) return;
    try {
      writeExternalText(this.abs, data);
      this.lastDiskData = data;
      if (notify) new Notice(`已保存 ${this.fileName}`);
      logOp(this.plugin, 'external.code.save', this.abs, 'ok');
    } catch (e) {
      new Notice(`保存失败：${String(e).slice(0, 120)}`);
      logOp(this.plugin, 'external.code.save', this.abs, 'error', String(e).slice(0, 200));
    }
  }

  /** Re-read from disk (the file changed elsewhere). */
  reload(): void {
    try {
      const data = readExternalText(this.abs);
      this.lastDiskData = data;
      this.editor?.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: data } });
    } catch (e) {
      new Notice(`重新读取失败：${String(e).slice(0, 100)}`);
    }
  }
}
