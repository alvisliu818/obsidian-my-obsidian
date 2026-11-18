/**
 * 本地 Git 管理弹窗(思源 git-dock + git-local-dialogs 的面板对齐):
 * 状态列表(暂存/取消暂存/diff 预览)+ 提交 + 拉取/推送 + 提交历史。
 *
 * 入口:挂载面板 external 目录行/挂载头行右键「Git 管理…」(目录在仓库里才有
 * 这一项——findRepoRoot 探测;探测在点击时做,菜单构建不等 git)。
 */

import { Modal, Notice, type App } from 'obsidian';
import {
  findRepoRoot,
  gitLocalCommit,
  gitLocalDiff,
  gitLocalLog,
  gitLocalPull,
  gitLocalPushCurrent,
  gitLocalShow,
  gitLocalStage,
  gitLocalStatus,
  gitLocalUnstage,
  isGitLocalAvailable,
  type GitLogEntry,
  type GitStatus,
  type GitStatusEntry,
} from '../features/gitLocal';

/** 状态码 → 展示徽标(暂存区 X 优先,其次工作区 Y,?? 未跟踪)。 */
function badgeOf(e: GitStatusEntry): { text: string; cls: string } {
  if (e.untracked) return { text: '??', cls: 'lgp-git__badge--untracked' };
  if (e.conflicted) return { text: e.index + e.worktree, cls: 'lgp-git__badge--conflict' };
  const code = e.index !== ' ' && e.index !== '?' ? e.index : e.worktree;
  return { text: code, cls: 'lgp-git__badge' };
}

export class GitPanelModal extends Modal {
  private repoRoot: string | null = null;
  private status: GitStatus | null = null;
  private logEntries: GitLogEntry[] = [];
  private busy = false;

  constructor(
    app: App,
    private targetAbs: string,
    private title: string,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass('lgp-git-modal');
    contentEl.createEl('h3', { text: `Git 管理:${this.title}` });
    if (!(await isGitLocalAvailable())) {
      contentEl.createEl('p', { text: 'git 不可用:请确认本机安装了 Git 并在 PATH 中(Obsidian 桌面端)。' });
      return;
    }
    this.repoRoot = await findRepoRoot(this.targetAbs);
    if (!this.repoRoot) {
      contentEl.createEl('p', { text: '该目录不在 Git 仓库里。' });
      return;
    }
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.repoRoot) return;
    try {
      this.status = await gitLocalStatus(this.repoRoot);
    } catch (e) {
      new Notice(`git status 失败:${(e as Error)?.message ?? '未知错误'}`);
      return;
    }
    this.renderStatus();
  }

  /** busy 包装:进行中禁点,结束按需重渲。 */
  private async run(fn: () => Promise<string | void>, done?: () => void): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const info = this.contentEl.querySelector('.lgp-git-modal__info') as HTMLElement | null;
    if (info) info.textContent = '执行中…';
    try {
      const out = await fn();
      if (typeof out === 'string' && out.trim()) new Notice(out.trim().slice(0, 400));
    } catch (e) {
      new Notice(`${(e as Error)?.message ?? '操作失败'}`, 8000);
    } finally {
      this.busy = false;
      done?.();
    }
  }

  private renderStatus(): void {
    const { contentEl } = this;
    contentEl.empty();
    const st = this.status;
    if (!st || !this.repoRoot) return;
    const head = contentEl.createDiv({ cls: 'lgp-git-modal__info' });
    const branchText = st.detached
      ? `HEAD detached @ ${st.head || '(空仓库)'}`
      : `${st.branch || '(无分支)'}${st.upstream ? ` → ${st.upstream}` : ''}${
          st.ahead || st.behind ? ` [↑${st.ahead} ↓${st.behind}]` : ''
        }`;
    head.textContent = `${branchText} · ${st.entries.length} 个变更 · ${this.repoRoot}`;

    const bar = contentEl.createDiv({ cls: 'lgp-git-modal__bar' });
    const mkBtn = (text: string, cls: string, fn: () => void) => {
      const b = bar.createEl('button', { text, cls });
      b.addEventListener('click', () => {
        if (this.busy) return;
        fn();
      });
      return b;
    };
    mkBtn('刷新', '', () => void this.refresh());
    mkBtn('拉取', '', () =>
      void this.run(() => gitLocalPull(this.repoRoot!), () => void this.refresh()),
    );
    mkBtn('推送', '', () =>
      void this.run(() => gitLocalPushCurrent(this.repoRoot!).then(() => '已推送'), () => void this.refresh()),
    );
    mkBtn('历史', '', () => void this.showLog());

    // 提交区:信息输入 + 提交(只提交已暂存;没有暂存条目时给提示)
    const commitBox = contentEl.createDiv({ cls: 'lgp-git-modal__commit' });
    const msgInput = commitBox.createEl('textarea', {
      cls: 'lgp-git-modal__msg',
      attr: { placeholder: '提交信息(只提交已暂存的变更)…', rows: '2', spellcheck: 'false' },
    });
    const commitBtn = commitBox.createEl('button', { cls: 'mod-cta', text: '提交' });
    commitBtn.addEventListener('click', () => {
      const msg = msgInput.value.trim();
      if (!msg) {
        new Notice('请填写提交信息');
        return;
      }
      void this.run(async () => {
        await gitLocalCommit(this.repoRoot!, msg);
        return '已提交';
      }, () => {
        msgInput.value = '';
        void this.refresh();
      });
    });

    // 变更列表
    const list = contentEl.createDiv({ cls: 'lgp-git-modal__list' });
    if (!st.entries.length) {
      list.createDiv({ cls: 'lgp-git-modal__empty', text: '工作区干净,没有变更。' });
      return;
    }
    for (const e of st.entries) {
      const row = list.createDiv({ cls: 'lgp-git-modal__row' });
      const badge = badgeOf(e);
      row.createSpan({ cls: `lgp-git-modal__badge ${badge.cls}`, text: badge.text });
      const nameEl = row.createSpan({ cls: 'lgp-git-modal__path', text: e.origPath ? `${e.origPath} → ${e.path}` : e.path });
      if (e.staged) nameEl.addClass('lgp-git-modal__path--staged');
      // 点击条目 = 暂存/取消暂存(思源 git 面板同款);diff 按钮独立
      row.addEventListener('click', () => {
        void this.run(
          async () => {
            if (e.staged) await gitLocalUnstage(this.repoRoot!, [e.path]);
            else await gitLocalStage(this.repoRoot!, [e.path]);
          },
          () => void this.refresh(),
        );
      });
      const diffBtn = row.createEl('button', { text: 'diff', cls: 'lgp-git-modal__diffbtn' });
      diffBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const existed = row.nextElementSibling?.classList.contains('lgp-git-modal__patch');
        list.querySelectorAll('.lgp-git-modal__patch').forEach((el) => el.remove());
        if (existed) return;
        void this.run(async () => {
          const text = await gitLocalDiff(this.repoRoot!, {
            staged: e.staged && !e.unstaged,
            path: e.path,
            untracked: e.untracked,
          });
          const pre = document.createElement('pre');
          pre.className = 'lgp-git-modal__patch';
          pre.textContent = text || '(无差异)';
          row.after(pre);
        });
      });
    }
  }

  private async showLog(): Promise<void> {
    if (!this.repoRoot) return;
    try {
      this.logEntries = await gitLocalLog(this.repoRoot, { limit: 100 });
    } catch (e) {
      new Notice(`git log 失败:${(e as Error)?.message ?? '未知错误'}`);
      return;
    }
    const { contentEl } = this;
    contentEl.empty();
    const head = contentEl.createDiv({ cls: 'lgp-git-modal__info' });
    head.textContent = `提交历史(${this.logEntries.length})`;
    const bar = contentEl.createDiv({ cls: 'lgp-git-modal__bar' });
    const backBtn = bar.createEl('button', { text: '← 返回状态' });
    backBtn.addEventListener('click', () => this.renderStatus());
    const list = contentEl.createDiv({ cls: 'lgp-git-modal__list' });
    if (!this.logEntries.length) {
      list.createDiv({ cls: 'lgp-git-modal__empty', text: '空仓库,还没有提交。' });
      return;
    }
    for (const c of this.logEntries) {
      const row = list.createDiv({ cls: 'lgp-git-modal__row' });
      row.createSpan({ cls: 'lgp-git-modal__badge', text: c.short });
      const main = row.createDiv({ cls: 'lgp-git-modal__logmain' });
      main.createDiv({ cls: 'lgp-git-modal__logsubject', text: c.subject });
      main.createDiv({ cls: 'lgp-git-modal__logmeta', text: `${c.author} · ${c.date}` });
      // 点击 = 展开该提交的 patch(git show)
      row.addEventListener('click', () => {
        const existed = row.nextElementSibling?.classList.contains('lgp-git-modal__patch');
        list.querySelectorAll('.lgp-git-modal__patch').forEach((el) => el.remove());
        if (existed) return;
        void this.run(async () => {
          const text = await gitLocalShow(this.repoRoot!, c.sha);
          const pre = document.createElement('pre');
          pre.className = 'lgp-git-modal__patch';
          pre.textContent = text || '(空提交)';
          row.after(pre);
        });
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
