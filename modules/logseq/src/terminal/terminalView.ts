// 终端视图：工作区标签页 + xterm.js 前端 + pty 会话。
// 一个 Tab 一个 shell 会话；多 Tab 共享一个 helper 进程。
// 会话里的 shell 可以现场换（视图条上的下拉），选择写回设置作为默认值。

import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type LogseqEditorPlugin from '../main';
import { absolutePluginDir, createPtySession, type PtySession } from './ptyClient';
import { SHELL_CHOICES } from './ptyClient';

export const VIEW_TYPE_TERMINAL = 'lgp-terminal-view';

export class TerminalView extends ItemView {
  private plugin: LogseqEditorPlugin;
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private session: PtySession | null = null;
  private closedByUser = false;
  /** 当前视图选用的 shell id；切换即重启会话。 */
  private shellId = 'auto';
  private shellPicker: HTMLSelectElement | null = null;
  private hintEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = false;
  }

  getViewType(): string {
    return VIEW_TYPE_TERMINAL;
  }

  getDisplayText(): string {
    return '终端';
  }

  getIcon(): string {
    return 'terminal-square';
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('lgp-terminal');
    const host = root.createDiv({ cls: 'lgp-terminal__host' });
    const bar = root.createDiv({ cls: 'lgp-terminal__bar' });

    this.hintEl = bar.createSpan({ cls: 'lgp-terminal__hint', text: '正在启动…' });
    this.shellPicker = bar.createEl('select', { cls: 'lgp-terminal__shell' });
    for (const c of SHELL_CHOICES) {
      const opt = this.shellPicker.createEl('option', { text: c.name });
      opt.value = c.id;
    }
    this.shellPicker.value = this.plugin.settings.terminalShell || 'auto';
    this.shellId = this.shellPicker.value;
    this.shellPicker.addEventListener('change', () => {
      void this.switchShell(this.shellPicker?.value ?? 'auto');
    });

    bar.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '清屏', title: '清屏' } }).addEventListener('click', () => {
      this.term?.clear();
    });
    bar.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '终止会话', title: '终止会话' } }).addEventListener('click', () => {
      this.closedByUser = true;
      this.session?.dispose();
    });

    this.term = new Terminal({
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
      },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(host);
    this.term.writeln('正在启动终端…');

    await this.startSession();
    this.registerDomEvent(window, 'resize', () => this.fitNow());
    this.registerInterval(window.setInterval(() => this.fitNow(), 1500));
  }

  /** Start (or restart) the pty session with the given shell. */
  private async startSession(): Promise<void> {
    const term = this.term;
    if (!term) return;
    this.closedByUser = false;
    try {
      this.session = await createPtySession(
        absolutePluginDir(this.plugin.manifest.dir ?? '', this.plugin.app.vault.adapter),
        { cols: term.cols, rows: term.rows, shell: this.shellId },
        {
          onData: (data) => {
            try {
              term?.write(data);
            } catch {
              // 视图已关闭
            }
          },
          onExit: (code) => {
            term?.writeln(`\r\n\x1b[90m[会话已结束${code != null ? ` (exit ${code})` : ''}]\x1b[0m`);
            if (!this.closedByUser) term?.writeln('换个 shell 重开，或关闭标签页。');
          },
          onError: (msg) => {
            term?.writeln(`\r\n\x1b[31m${msg}\x1b[0m`);
          },
        },
      );
      if (this.hintEl) {
        this.hintEl.setText(`${this.session.shellName} · 关闭标签页即结束会话`);
      }
      term.reset();
      term.onData((d) => this.session?.write(d));
      this.fitNow();
    } catch (e) {
      term.writeln(`\x1b[31m终端启动失败: ${String((e as Error).message || e)}\x1b[0m`);
      new Notice(`终端启动失败: ${String((e as Error).message || e)}`);
    }
  }

  /** Switch the shell of THIS view, and remember it as the default. */
  private async switchShell(id: string): Promise<void> {
    const choice = SHELL_CHOICES.find((c) => c.id === id);
    if (!choice) return;
    this.shellId = id;
    this.plugin.settings.terminalShell = id;
    await this.plugin.saveSettings();
    this.term?.clear();
    this.term?.writeln(`切换到 ${choice.name} …`);
    this.session?.dispose();
    await this.startSession();
  }

  private fitNow(): void {
    try {
      this.fit?.fit();
      this.session?.resize(this.term!.cols, this.term!.rows);
    } catch {
      // 布局未就绪
    }
  }

  async onClose(): Promise<void> {
    this.closedByUser = true;
    this.session?.dispose();
    this.session = null;
    this.term?.dispose();
    this.term = null;
    this.contentEl.empty();
  }
}
