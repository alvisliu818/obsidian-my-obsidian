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
import { EditorState, type Extension } from 'cm-bundle:@codemirror/state';
import { EditorView, keymap, lineNumbers, type KeyBinding, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars, dropCursor } from 'cm-bundle:@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from 'cm-bundle:@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, search } from 'cm-bundle:@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from 'cm-bundle:@codemirror/autocomplete';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting, HighlightStyle, StreamLanguage } from 'cm-bundle:@codemirror/language';
import { tags as t } from 'cm-bundle:@lezer/highlight';
import { javascript } from 'cm-bundle:@codemirror/lang-javascript';
import { markdown } from 'cm-bundle:@codemirror/lang-markdown';
// legacy-modes 是直接依赖（package.json ^6.5.4）——每个语言家族一个
// StreamParser，覆盖 TEXT_EXTENSIONS 能打开的绝大多数扩展名，代码文件
// 不再打开成一片灰（用户报告：代码文件没有语法高亮）。
// lang-html / lang-css 是完整 lezer 解析器，已在依赖树里，此处显式声明。
import { html } from 'cm-bundle:@codemirror/lang-html';
import { css as cssParser } from 'cm-bundle:@codemirror/lang-css';
import { cpp, java, csharp, kotlin, objectiveC, scala, dart } from 'cm-bundle:@codemirror/legacy-modes/mode/clike';
import { go } from 'cm-bundle:@codemirror/legacy-modes/mode/go';
import { python } from 'cm-bundle:@codemirror/legacy-modes/mode/python';
import { ruby } from 'cm-bundle:@codemirror/legacy-modes/mode/ruby';
import { lua } from 'cm-bundle:@codemirror/legacy-modes/mode/lua';
import { perl } from 'cm-bundle:@codemirror/legacy-modes/mode/perl';
import { r } from 'cm-bundle:@codemirror/legacy-modes/mode/r';
import { julia } from 'cm-bundle:@codemirror/legacy-modes/mode/julia';
import { erlang } from 'cm-bundle:@codemirror/legacy-modes/mode/erlang';
import { haskell } from 'cm-bundle:@codemirror/legacy-modes/mode/haskell';
import { shell } from 'cm-bundle:@codemirror/legacy-modes/mode/shell';
import { powerShell } from 'cm-bundle:@codemirror/legacy-modes/mode/powershell';
import { diff } from 'cm-bundle:@codemirror/legacy-modes/mode/diff';
import { standardSQL } from 'cm-bundle:@codemirror/legacy-modes/mode/sql';
import { rust } from 'cm-bundle:@codemirror/legacy-modes/mode/rust';
import { xml } from 'cm-bundle:@codemirror/legacy-modes/mode/xml';
import { yaml } from 'cm-bundle:@codemirror/legacy-modes/mode/yaml';
import { swift } from 'cm-bundle:@codemirror/legacy-modes/mode/swift';
import { readExternalText, writeExternalText } from '../features/extFs';
import { logOp } from '../features/logger';
import type LogseqEditorPlugin from '../main';
import { relativeDisplayPath } from '../features/codeFileKind';
import { setLeafTitle } from '../features/leafTitle';
import { applyHeaderPath, headerPathSegments } from './headerPath';

export { relativeDisplayPath };

export const VIEW_TYPE_EXTERNAL_CODE = 'logseq-external-code';

/**
 * Languages we highlight.
 *
 * The code editor now receives every non-markdown file, so this covers config
 * formats and shell too — a YAML file that opens but renders as flat grey text
 * reads as broken, even though it is perfectly editable. Anything not listed
 * still opens fine, just without colouring.
 */
function languageFor(ext: string): Extension[] {
  switch (ext) {
    // javascript() 覆盖整个 ECMAScript 家族加 JSON。
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'mjs': case 'cjs':
    case 'mts': case 'cts': case 'json': case 'json5':
      return [javascript()];
    // Markdown 正常走块编辑器，只读打开的 .md 也会落到这里，顺手高亮。
    case 'md': case 'markdown':
      return [markdown()];
    // HTML：完整 lezer 解析器（标签/属性/内联脚本样式都着色）。vue/svelte 模板同理。
    case 'html': case 'htm': case 'vue': case 'svelte':
      return [html()];
    case 'css': case 'scss': case 'less':
      return [cssParser()];
    case 'py':
      return [StreamLanguage.define(python)];
    case 'rb':
      return [StreamLanguage.define(ruby)];
    case 'go':
      return [StreamLanguage.define(go)];
    case 'rs':
      return [StreamLanguage.define(rust)];
    case 'java':
      return [StreamLanguage.define(java)];
    case 'kt': case 'kts':
      return [StreamLanguage.define(kotlin)];
    case 'c': case 'h': case 'cc': case 'cpp': case 'hpp':
      return [StreamLanguage.define(cpp)];
    case 'cs':
      return [StreamLanguage.define(csharp)];
    case 'm': case 'mm':
      return [StreamLanguage.define(objectiveC)];
    case 'scala':
      return [StreamLanguage.define(scala)];
    case 'dart':
      return [StreamLanguage.define(dart)];
    case 'lua':
      return [StreamLanguage.define(lua)];
    case 'pl':
      return [StreamLanguage.define(perl)];
    case 'r':
      return [StreamLanguage.define(r)];
    case 'jl':
      return [StreamLanguage.define(julia)];
    case 'erl':
      return [StreamLanguage.define(erlang)];
    case 'hs':
      return [StreamLanguage.define(haskell)];
    case 'swift':
      return [StreamLanguage.define(swift)];
    case 'sh': case 'bash': case 'zsh': case 'fish':
      return [StreamLanguage.define(shell)];
    case 'ps1':
      return [StreamLanguage.define(powerShell)];
    case 'diff': case 'patch':
      return [StreamLanguage.define(diff)];
    case 'sql':
      return [StreamLanguage.define(standardSQL)];
    case 'xml': case 'svg':
      return [StreamLanguage.define(xml)];
    case 'yaml': case 'yml':
      return [StreamLanguage.define(yaml)];
    default:
      // 没有现成模式的配置格式（toml/ini/cfg/conf/env/properties/log/
      // gitignore）至少给注释/字符串/数字着色；都不在表里的仍可编辑，
      // 只是无色（如 .bat/.cmd——legacy-modes 没有 DOS batch 模式）。
      return streamLanguageFor(ext);
  }
}

/** Minimal StreamLanguage definitions for formats with no bundled mode. */
function streamLanguageFor(ext: string): Extension[] {
  const map: Record<string, { comment: string | RegExp; string: RegExp; number: RegExp }> = {
    toml: { comment: /#.*$/, string: /"[^"]*"|'[^']*'/, number: /\d+(\.\d+)?/ },
    ini: { comment: /[;#].*$/, string: /"[^"]*"|'[^']*'/, number: /\d+(\.\d+)?/ },
    conf: { comment: /[;#].*$/, string: /"[^"]*"|'[^']*'/, number: /\d+(\.\d+)?/ },
    cfg: { comment: /#.*$/, string: /"[^"]*"|'[^']*'/, number: /\d+(\.\d+)?/ },
    env: { comment: /#.*$/, string: /"[^"]*"|'[^']*'/, number: /\d+(\.\d+)?/ },
    gitignore: { comment: /#.*$/, string: /"[^"]*"|'[^']*'/, number: /\d+(\.\d+)?/ },
    properties: { comment: /[#!].*$/, string: /"[^"]*"|'[^']*'/, number: /\d+(\.\d+)?/ },
    log: { comment: /$/, string: /"[^"]*"/, number: /\d+/ },
  };
  const spec = map[ext.toLowerCase()];
  if (!spec) return [];
  return [
    StreamLanguage.define({
      name: ext.toLowerCase(),
      token(stream) {
        if (stream.sol() && stream.match(spec.comment)) return 'comment';
        if (stream.match(spec.string)) return 'string';
        if (stream.match(spec.number)) return 'number';
        stream.next();
        return null;
      },
    }),
  ];
}

/**
 * File types this view is for. Mirrors the set Code Files claims, since that is
 * what a user with it installed would expect to open here.
 */
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
  /** Path shown in the header: relative to the mount root, which is what the
   *  user recognises. The absolute path stays available as a tooltip. */
  displayPath = '';
  /** The mount this file came from, so the header can say where it lives. */
  mountPath = '';
  /** 挂载名——视图头部路径的第一段（「挂载名 / 子目录 / 文件名」） */
  mountLabel = '';

  /** 老 state 没有挂载名时，按最长前缀匹配在挂载配置里找回来。 */
  private mountLabelFromSettings(): string {
    const mounts = this.plugin.settings.externalMounts ?? [];
    const full = this.abs.replace(/\\/g, '/').toLowerCase();
    let best = '';
    let bestLen = -1;
    for (const m of mounts) {
      const root = String(m.path ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
      if (!root || !full.startsWith(root + '/')) continue;
      if (root.length > bestLen) {
        bestLen = root.length;
        best = m.label || '';
      }
    }
    return best;
  }
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
    return {
      abs: this.abs,
      name: this.fileName,
      mountPath: this.mountPath,
      mountLabel: this.mountLabel,
    };
  }

  async onOpen(): Promise<void> {
    // Mounting waits for setState: Obsidian calls onOpen BEFORE setState, so
    // mounting here would build an empty editor for a file whose path and
    // content have not arrived yet — and the state that carries them is the
    // only place they exist.
    if (this.abs) this.mount();
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as {
      abs?: string;
      name?: string;
      content?: string;
      mountPath?: string;
      mountLabel?: string;
    };
    if (typeof s.abs === 'string') this.abs = s.abs;
    if (typeof s.name === 'string') this.fileName = s.name;
    if (typeof s.content === 'string') this.lastDiskData = s.content;
    if (typeof s.mountPath === 'string') this.mountPath = s.mountPath;
    if (typeof s.mountLabel === 'string') this.mountLabel = s.mountLabel;
    this.displayPath = relativeDisplayPath(this.abs, this.mountPath, this.fileName);
    await super.setState(state, result);
    // Now the path is known; build the editor if onOpen ran before us.
    if (!this.editor && this.abs) this.mount();
    // 视图头部的完整路径（挂载名 / 子目录 / …）：库外文件没有库内路径，
    // Obsidian 不会给自定义视图生成目录链。
    const segments = headerPathSegments(
      this.abs,
      this.displayPath || this.fileName,
      this.mountLabel || this.mountLabelFromSettings(),
    );
    if (segments.length) segments[0].isMount = true;
    applyHeaderPath(this.containerEl, segments, this.plugin, this.abs);
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

    // The banner is optional and, when hidden, GONE — not compacted. Keeping a
    // one-line version still left a strip at the top, which is exactly what
    // turning the setting off is meant to remove. The file still autosaves on
    // the usual debounce, so nothing is lost by not showing it.
    if (this.plugin.settings.externalBanner) {
      const banner = contentEl.createDiv({ cls: 'logseq-external-banner' });
      banner.createSpan({ cls: 'logseq-external-banner-text', text: this.fileName });
      // Relative to the mount root — that is the name the user recognises. The
      // absolute path stays one hover away, since a linked file and an unlinked
      // one resolve to different places and that is worth being able to check.
      const pathEl = banner.createSpan({
        cls: 'logseq-external-banner-path',
        text: this.displayPath || this.fileName,
      });
      pathEl.setAttribute('title', this.abs);
      banner.createSpan({ cls: 'logseq-external-badge', text: '库外' });
      const status = banner.createSpan({ cls: 'logseq-external-hint', text: '与原文件实时同步' });
      status.setAttribute('title', '保存时写回原文件');
      const saveBtn = banner.createEl('button', { cls: 'logseq-external-save', text: '保存' });
      saveBtn.addEventListener('click', () => void this.flush(true));
    }

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
      // true = wrap (the default, and what the switch label says).
      ...(this.plugin.settings.externalCodeWrap === false ? [] : [EditorView.lineWrapping]),
      keymap.of([
        // Ctrl/Cmd+S saves immediately. The banner's save button is the visible
        // route, but the banner can be switched off entirely, and a file the user
        // is editing should never depend on a setting to be saveable.
        { key: 'Mod-s', run: () => { void this.flush(true); return true; } },
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
    // The leaf's own view header caches the name it was mounted with; on a fresh
    // mount that is nothing, on a re-mount it is the previous file. Writing it
    // here covers both.
    //
    // File name only — NOT the mount-relative path. The header now carries the
    // full path as breadcrumbs (挂载名 / 子目录 / …), so putting the path in the
    // title as well spelled it out twice (`挂载库/sub/sub/code.ts`).
    setLeafTitle(this.leaf, this.fileName);
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

  /**
   * Rebuild the editor, keeping the current buffer.
   *
   * The banner and the soft-wrap setting are baked into the CodeMirror
   * extensions at construction, and an instance cannot change them afterwards,
   * so a settings toggle has to remount. The unsaved text is carried across so
   * nothing is lost in the swap.
   */
  remount(): void {
    if (!this.abs) return;
    try {
      // Prefer what is on screen: an autosave may not have landed yet.
      const text = this.editor ? this.editor.state.doc.toString() : this.lastDiskData;
      this.editor?.destroy();
      this.editor = null;
      this.mount();
      // mount() rebuilds from lastDiskData, so put the live buffer back.
      const ed = this.editor as EditorView | null;
      if (ed && text !== this.lastDiskData) {
        ed.dispatch({ changes: { from: 0, to: ed.state.doc.length, insert: text } });
      }
    } catch {
      /* a failed remount leaves the previous view in place; not fatal */
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
