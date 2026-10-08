/**
 * 交互式内核面板(REPL)— 对应思源 notebook-tab 的执行能力,以独立面板形态落地:
 * 多行输入(Ctrl+Enter 执行)、输出历史、Tab 补全、Hover 提示、重置/中断。
 *
 * 为什么是面板而不是接管 .ipynb:obsidian-logseq 的核心是 markdown 大纲编辑器,
 * 笔记本文件不是它的场景;REPL 面板让「随手验证一段代码」的交互式需求成立,
 * 且变量跨次保留(内核是持久的)。
 *
 * 状态与生命周期:内核实例来自 registry(默认 docId,全局共享);
 * 面板关闭不关内核(下次打开接着用),插件卸载时由 main.ts disposeAllKernels。
 */

import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { getKernel, DEFAULT_KERNEL_ID, disposeKernel } from '../exec/kernel/registry';
import type { ExecuteOutcome, KernelStatus } from '../exec/kernel/types';

export const VIEW_TYPE_KERNEL_PANEL = 'logseq-kernel-panel';

export class KernelPanelView extends ItemView {
  private outEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;
  private unsubStatus?: () => void;
  /** 本面板累积的输出(内核事件流的镜像) */
  private lines: { kind: 'in' | 'out' | 'err' | 'result' | 'info'; text: string }[] = [];
  private executing = false;

  constructor(leaf: WorkspaceLeaf, _plugin: LogseqEditorPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_KERNEL_PANEL;
  }

  getDisplayText(): string {
    return 'Python 内核';
  }

  getIcon(): string {
    return 'terminal';
  }

  async onOpen(): Promise<void> {
    const content = this.contentEl;
    content.empty();
    content.addClass('lgp-kernel-panel');

    const head = content.createDiv({ cls: 'lgp-kernel-head' });
    this.statusEl = head.createSpan({ cls: 'lgp-kernel-status', text: '状态：未启动' });
    const actions = head.createDiv({ cls: 'lgp-kernel-actions' });

    const infoBtn = actions.createEl('button', { text: '信息' });
    infoBtn.addEventListener('click', () => void this.showInfo());
    const resetBtn = actions.createEl('button', { text: '重置' });
    resetBtn.addEventListener('click', () => void this.resetKernel());
    const interruptBtn = actions.createEl('button', { text: '中断' });
    interruptBtn.addEventListener('click', () => void this.interruptKernel());

    this.outEl = content.createDiv({ cls: 'lgp-kernel-out' });
    this.renderOut();

    const editorWrap = content.createDiv({ cls: 'lgp-kernel-editor' });
    this.inputEl = editorWrap.createEl('textarea', {
      attr: { placeholder: 'Python 代码…  Ctrl+Enter 执行,Tab 补全', spellcheck: 'false' },
    });
    this.inputEl.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter' && (ev as KeyboardEvent).ctrlKey) {
        ev.preventDefault();
        void this.run();
        return;
      }
      if ((ev as KeyboardEvent).key === 'Tab') {
        ev.preventDefault();
        void this.complete();
      }
    });

    // 内核状态镜像到面板
    const k = getKernel(DEFAULT_KERNEL_ID);
    this.unsubStatus = k.onStatus((s, detail) => this.renderStatus(s, detail));
    this.renderStatus(k.currentStatus);
  }

  async onClose(): Promise<void> {
    this.unsubStatus?.();
    this.unsubStatus = undefined;
    this.contentEl.empty();
  }

  private renderStatus(s: KernelStatus, detail?: string): void {
    const label =
      s === 'ready' ? '就绪' : s === 'starting' ? '启动中…' : s === 'error' ? `错误${detail ? '：' + detail : ''}` : '未启动';
    this.statusEl.textContent = `状态：${label}`;
    this.statusEl.classList.toggle('is-error', s === 'error');
    this.statusEl.classList.toggle('is-ready', s === 'ready');
  }

  private renderOut(): void {
    this.outEl.empty();
    for (const l of this.lines) {
      const row = this.outEl.createDiv({ cls: 'lgp-kernel-line is-' + l.kind });
      row.textContent = l.text;
    }
    this.outEl.scrollTop = this.outEl.scrollHeight;
  }

  private push(kind: 'in' | 'out' | 'err' | 'result' | 'info', text: string): void {
    // 输出上限:防止一个死循环输出把内存吃光
    if (this.lines.length > 2000) this.lines = this.lines.slice(-1000);
    this.lines.push({ kind, text });
    this.renderOut();
  }

  private async run(): Promise<void> {
    const code = this.inputEl.value.trim();
    if (!code || this.executing) return;
    this.executing = true;
    this.inputEl.value = '';
    this.push('in', `>>> ${code.replace(/\n/g, '\n... ')}`);

    const k = getKernel(DEFAULT_KERNEL_ID);
    const outcome: ExecuteOutcome | null = await k.execute(code, { timeoutMs: 300000 });

    if (!outcome) {
      this.push('err', '[无结果] 内核未就绪或执行超时');
    } else {
      if (outcome.stdout) this.push('out', outcome.stdout.replace(/\n$/, ''));
      if (outcome.stderr) this.push('err', outcome.stderr.replace(/\n$/, ''));
      if (outcome.error) {
        const tb = outcome.error.traceback?.length
          ? outcome.error.traceback.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
          : `${outcome.error.ename}: ${outcome.error.evalue}`;
        this.push('err', tb);
      } else if (outcome.result !== undefined && outcome.result !== null) {
        this.push('result', outcome.result.replace(/\n$/, ''));
      }
    }
    this.executing = false;
  }

  private async complete(): Promise<void> {
    const el = this.inputEl;
    // Tab 补全用「光标前到行首」作为前缀;多行时把整个输入给内核更准
    const cursor = el.selectionStart ?? el.value.length;
    const k = getKernel(DEFAULT_KERNEL_ID);
    const res = await k.complete(el.value, cursor);
    if (!res || res.matches.length === 0) return;
    if (res.matches.length === 1) {
      // 唯一候选:直接替换待补区间
      const insert = res.matches[0];
      const start = res.cursorStart ?? cursor;
      const end = res.cursorEnd ?? cursor;
      el.value = el.value.slice(0, start) + insert + el.value.slice(end);
      const pos = start + insert.length;
      el.setSelectionRange(pos, pos);
      el.focus();
      return;
    }
    // 多候选:公共前缀先补上,再列出
    const common = commonPrefix(res.matches);
    if (common && common.length > (res.cursorEnd ?? cursor) - (res.cursorStart ?? cursor)) {
      const start = res.cursorStart ?? cursor;
      el.value = el.value.slice(0, start) + common + el.value.slice(res.cursorEnd ?? cursor);
      const pos = start + common.length;
      el.setSelectionRange(pos, pos);
    }
    this.push('info', res.matches.join('  '));
  }

  private async showInfo(): Promise<void> {
    const k = getKernel(DEFAULT_KERNEL_ID);
    const info = await k.info2();
    if (!info) {
      this.push('err', '[信息] 内核未就绪');
      return;
    }
    this.push('info', `Python ${info.version}\n${info.executable}`);
  }

  private async resetKernel(): Promise<void> {
    const k = getKernel(DEFAULT_KERNEL_ID);
    const ok = await k.reset();
    new Notice(ok ? '内核已重置(变量已清空)' : '重置失败');
    if (ok) {
      this.lines = [];
      this.renderOut();
    }
  }

  private async interruptKernel(): Promise<void> {
    // Legacy 后端的中断 = 杀进程重建 + 重放历史(见 legacyPython 注释)
    await disposeKernel(DEFAULT_KERNEL_ID);
    this.lines = [];
    this.renderOut();
    new Notice('内核已中断重建');
  }
}

/** 候选集的公共前缀(逐字符,无大小写折叠 —— 内核补全本来大小写敏感)。 */
function commonPrefix(list: string[]): string {
  if (list.length === 0) return '';
  let prefix = list[0];
  for (const s of list.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}
