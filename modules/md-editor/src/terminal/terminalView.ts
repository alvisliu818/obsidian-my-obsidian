// 终端视图：工作区标签页 + xterm.js 前端 + pty 会话。
// 一个 Tab 一个 shell 会话；多 Tab 共享一个 helper 进程。
// shell 由打开入口的选择菜单决定（activateTerminalView），随 state 持久化——
// 布局恢复后同一标签页还是原来的 shell。会话启动必须等 setState：Obsidian
// 先调 onOpen 再调 setState，shell 选择随 state 到达（ExternalCodeView 同款
// 时序约定），onOpen 只架 UI。

import { ItemView, Notice, WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type LogseqEditorPlugin from '../main';
import {
  absolutePluginDir,
  createPtySession,
  detectShell,
  type PtySession,
  type ShellInfo,
} from '../../../code-editor/src/terminal/ptyClient';
import { setLeafTitle } from '../features/leafTitle';

export const VIEW_TYPE_TERMINAL = 'lgp-terminal-view';

export class TerminalView extends ItemView {
  private plugin: LogseqEditorPlugin;
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private session: PtySession | null = null;
  private closedByUser = false;
  /** 本会话的 shell（选择菜单带入；缺省探测默认） */
  private shell: ShellInfo | null = null;
  /** 会话只启动一次（setState 可能多次到达：布局恢复 + 换叶复用） */
  private sessionStarted = false;
  /** bar 提示随实际 shell 变（探测完成后刷新一次) */
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
    return this.shell?.name ?? '终端';
  }

  getIcon(): string {
    return 'terminal-square';
  }

  getState(): Record<string, unknown> {
    // shell 随布局持久化：重载后同一标签页还是原来的 shell
    const state: Record<string, unknown> = {};
    if (this.shell) {
      state.shellFile = this.shell.file;
      state.shellName = this.shell.name;
    }
    return state;
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as { shellFile?: string; shellName?: string };
    if (typeof s.shellFile === 'string' && s.shellFile) {
      this.shell = {
        file: s.shellFile,
        name: typeof s.shellName === 'string' ? s.shellName : 'shell',
      };
    }
    await super.setState(state, result);
    void this.startSession();
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('lgp-terminal');
    const host = root.createDiv({ cls: 'lgp-terminal__host' });
    const bar = root.createDiv({ cls: 'lgp-terminal__bar' });
    this.hintEl = bar.createSpan({ cls: 'lgp-terminal__hint' });
    this.refreshHint();
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
  }

  /** 启动 pty 会话（幂等）：shell 缺省时探测默认项 */
  private async startSession(): Promise<void> {
    if (this.sessionStarted || !this.term) return;
    this.sessionStarted = true;
    try {
      if (!this.shell) {
        this.shell = await detectShell();
      }
      // state 带壳(onOpen 时 shell 还是 null)与探测路径都要刷提示与页签
      this.refreshHint();
      setLeafTitle(this.leaf, this.shell.name);
      this.session = await createPtySession(
        absolutePluginDir(this.plugin.manifest.dir ?? '', this.plugin.app.vault.adapter),
        { cols: this.term.cols, rows: this.term.rows, shell: this.shell },
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
    } catch (e) {
      this.sessionStarted = false; // 失败允许下次 setState 重试
      this.term?.writeln(`\x1b[31m终端启动失败: ${String((e as Error).message || e)}\x1b[0m`);
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

  private refreshHint(): void {
    if (this.hintEl) {
      this.hintEl.setText(`${this.shell?.name ?? 'shell'} · 关闭标签页即结束会话`);
    }
  }
}
