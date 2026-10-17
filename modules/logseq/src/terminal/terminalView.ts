// 终端视图：工作区标签页 + xterm.js 前端 + pty 会话。
// 一个 Tab 一个 shell 会话；多 Tab 共享一个 helper 进程。

import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type LogseqEditorPlugin from '../main';
import { absolutePluginDir, createPtySession, type PtySession } from './ptyClient';

export const VIEW_TYPE_TERMINAL = 'lgp-terminal-view';

export class TerminalView extends ItemView {
  private plugin: LogseqEditorPlugin;
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private session: PtySession | null = null;
  private closedByUser = false;

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
    bar.createSpan({ cls: 'lgp-terminal__hint', text: 'PowerShell · 关闭标签页即结束会话' });
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

    try {
      this.session = await createPtySession(
        absolutePluginDir(this.plugin.manifest.dir ?? '', this.plugin.app.vault.adapter),
        { cols: this.term.cols, rows: this.term.rows },
        {
          onData: (data) => {
            try {
              this.term?.write(data);
            } catch {
              // 视图已关闭
            }
          },
          onExit: (code) => {
            this.term?.writeln(`\r\n\x1b[90m[会话已结束${code != null ? ` (exit ${code})` : ''}]\x1b[0m`);
            if (!this.closedByUser) this.term?.writeln('按 Ctrl+Shift+P → “重载终端” 或关闭标签页。');
          },
          onError: (msg) => {
            this.term?.writeln(`\r\n\x1b[31m${msg}\x1b[0m`);
          },
        },
      );
      this.term.reset();
      this.term.onData((d) => this.session?.write(d));
      const fitNow = () => {
        try {
          this.fit?.fit();
          this.session?.resize(this.term!.cols, this.term!.rows);
        } catch {
          // 布局未就绪
        }
      };
      fitNow();
      this.registerInterval(window.setInterval(fitNow, 1500));
      this.registerDomEvent(window, 'resize', fitNow);
    } catch (e) {
      this.term.writeln(`\x1b[31m终端启动失败: ${String((e as Error).message || e)}\x1b[0m`);
      new Notice(`终端启动失败: ${String((e as Error).message || e)}`);
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
