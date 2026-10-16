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
import type * as monacoNS from 'monaco-editor';
// 代码编辑器:Monaco(开源 VS Code 内核)。语言解析/高亮/worker 见 src/editor/monaco.ts;
// pyright LSP 的 Monaco provider 接线在 extensions/grammarLoader 侧(与 SiYuan 同源)。
import { createEditor, setupMonaco, getLanguageByPath } from '../editor/monaco';
import { readExternalText, writeExternalText } from '../features/extFs';
import { logOp } from '../features/logger';
import type LogseqEditorPlugin from '../main';
import { relativeDisplayPath } from '../features/codeFileKind';
import { setLeafTitle } from '../features/leafTitle';
import { applyHeaderPath, headerPathSegments } from './headerPath';
import { runFile, langFromExt } from '../exec/runner';
import type { RunHandle } from '../exec/pythonRunner';

export { relativeDisplayPath };

export const VIEW_TYPE_EXTERNAL_CODE = 'logseq-external-code';

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
  /** 运行输出区(首次运行时创建) */
  private runOutputEl: HTMLPreElement | null = null;
  private runHandle: RunHandle | null = null;

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
  editor: monacoNS.editor.IStandaloneCodeEditor | null = null;
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
    const model = this.editor?.getModel();
    this.editor?.dispose();
    model?.dispose();
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

      // 运行:仅对可执行的扩展名显示(py / js / sh / ps1 …),用设置里选中的
      // Python 环境跑 —— 与代码块 ▶ 走同一条执行路径。
      const runLang = langFromExt(this.fileName);
      if (runLang) {
        const runBtn = banner.createEl('button', { cls: 'logseq-external-save', text: '▶ 运行' });
        runBtn.setAttribute('title', `运行 ${this.fileName}`);
        runBtn.addEventListener('click', () => void this.runCurrentFile());
      }
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

    setupMonaco((rel) => this.app.vault.adapter.getResourcePath(rel));

    // 语言由路径扩展名决定(Monaco basic-languages + TS worker);高亮与
    // VS Code 同源。保存仍走原防抖链路,Ctrl/Cmd+S 即时落盘。
    const language = getLanguageByPath(this.abs);
    this.editor = createEditor(host, {
      value: content,
      language,
      wordWrap: this.plugin.settings.externalCodeWrap === false ? 'off' : 'on',
      lineNumbers: true,
      onSave: () => void this.flush(true),
      onChange: () => {
        // Debounced like the vault editor, so typing is not a write per keystroke.
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => void this.flush(), 900);
      },
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
  /** 运行当前文件(先写回磁盘,再按扩展名分派)。 */
  async runCurrentFile(): Promise<void> {
    const lang = langFromExt(this.fileName);
    if (!lang || !this.abs) return;
    await this.flush(true);
    const out = this.ensureRunOutput();
    out.textContent = '';
    out.style.display = 'block';
    const cwd = this.abs.replace(/[\/][^\/]+$/, '');
    this.runHandle?.interrupt();
    this.runHandle = runFile(
      this.abs,
      lang,
      cwd,
      (chunk) => {
        out.textContent += chunk;
        out.scrollTop = out.scrollHeight;
      },
      (code) => {
        out.textContent += `
[退出码 ${code}]
`;
        this.runHandle = null;
      },
    );
  }

  private ensureRunOutput(): HTMLPreElement {
    if (this.runOutputEl && this.runOutputEl.isConnected) return this.runOutputEl;
    const el = this.contentEl.createEl('pre', { cls: 'logseq-external-run-output' });
    el.style.display = 'none';
    this.runOutputEl = el;
    return el;
  }

  async flush(notify = false): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.editor || !this.abs) return;
    const data = this.editor.getValue();
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
      const text = this.editor ? this.editor.getValue() : this.lastDiskData;
      const model = this.editor?.getModel();
      this.editor?.dispose();
      model?.dispose();
      this.editor = null;
      this.mount();
      // mount() rebuilds from lastDiskData, so put the live buffer back.
      const ed = this.editor as monacoNS.editor.IStandaloneCodeEditor | null;
      if (ed && text !== this.lastDiskData) {
        ed.getModel()?.setValue(text);
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
      this.editor?.getModel()?.setValue(data);
    } catch (e) {
      new Notice(`重新读取失败：${String(e).slice(0, 100)}`);
    }
  }
}
