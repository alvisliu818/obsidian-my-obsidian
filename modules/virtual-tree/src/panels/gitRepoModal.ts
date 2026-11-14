/**
 * GitHub / Gitee 仓库挂载对话框:仓库地址 → 分支/标签 → 逐层浏览后挂载。
 *
 * - 仓库区:粘贴 https 地址 / git@ SSH 地址 / owner/repo 简写,或从「我的仓库」
 *   里选(按已保存令牌的可见范围列出);读取仓库信息与分支列表;分支名含斜杠
 *   (feature/login)也能正确往返(虚拟路径里 ref 按 URL 编码存放)。
 * - 令牌区:两家各一个可选令牌(存 settings)。公开仓库不填也能浏览,但匿名
 *   配额只有 60 次/小时,且写回提交必须有令牌。
 * - 挂载区:可挂仓库根、子目录,也可挂单个文件;选中经 onPick 交给
 *   promptMountEntry(位置选择复用 MountPositionModal)。
 *
 * 移植自 siyuan-virtual-tree 的 components/git-repo-dialog.ts(2026-11-14)。
 */

import { Modal, Notice, Setting } from 'obsidian';
import type VirtualTreePlugin from '../main';
import {
  clearGitRepoCache,
  gitListDir,
  gitListMyRepos,
  gitListRefs,
  gitRepoInfo,
  gitVerifyToken,
  type GitMyRepo,
} from '../features/gitRepoApi';
import { buildGitRepoPath, parseRepoInput, type GitProvider } from '../features/gitRepoPath';
import { remoteShortName } from '../features/remotePath';

const PROVIDER_LABEL: Record<GitProvider, string> = { github: 'GitHub', gitee: 'Gitee' };

/** 挂载结果:vPath 为 github:// 或 gitee:// 虚拟路径,label 为条目名 */
export interface GitRepoPick {
  vPath: string;
  label: string;
  isDir: boolean;
}

export class GitRepoMountModal extends Modal {
  private plugin: VirtualTreePlugin;
  private onPick?: (pick: GitRepoPick) => void;
  /** 入口 provider 只用于裸 owner/repo 简写的归属;粘贴完整地址时以主机名为准 */
  private entryProvider: GitProvider;
  private curProvider: GitProvider;
  private curRepo: { owner: string; repo: string } | null = null;
  private curRef = '';
  private browseSub = ''; // 仓库内相对路径,'' = 仓库根
  private repoLoading = false;
  private myRepos: GitMyRepo[] = [];
  private myReposLoading = false;

  // 控件引用(渲染时填充)
  private urlEl!: HTMLInputElement;
  private refEl!: HTMLSelectElement;
  private repoStatusEl!: HTMLElement;
  private tokenStatusEl!: HTMLElement;
  private crumbEl!: HTMLElement;
  private listEl!: HTMLElement;

  constructor(plugin: VirtualTreePlugin, opts: { provider?: GitProvider; onPick?: (pick: GitRepoPick) => void } = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.onPick = opts.onPick;
    this.entryProvider = opts.provider || 'github';
    this.curProvider = this.entryProvider;
  }

  onOpen(): void {
    this.titleEl.setText('Git 仓库');
    this.renderRepoSection();
    this.renderTokenSection();
    this.renderMountSection();
    void this.renderMountList();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // ------------------------------------------------------------------
  // 仓库区
  // ------------------------------------------------------------------

  private renderRepoSection(): void {
    const c = this.contentEl;
    c.createEl('p', {
      cls: 'setting-item-description',
      text: '粘贴仓库地址(如 https://github.com/octocat/Hello-World、git@gitee.com:owner/repo.git),或直接填 owner/repo 简写;也可以从「我的仓库」里选。',
    });

    new Setting(c).setName('地址').addText((t) => {
      this.urlEl = t.inputEl;
      t.setPlaceholder(
        this.entryProvider === 'gitee' ? 'https://gitee.com/owner/repo 或 owner/repo' : 'https://github.com/owner/repo 或 owner/repo',
      );
      t.inputEl.addEventListener('keydown', (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          this.loadRepo();
        }
      });
    });

    new Setting(c)
      .setName('我的仓库')
      .setDesc('按已保存令牌列出你有权限的仓库;未填令牌时不可用。')
      .addDropdown((d) => {
        d.selectEl.addClass('lgp-gitrepo__wide');
        d.addOption('', '点右侧按钮按令牌列出');
        d.onChange((v) => {
          const r = this.myRepos[Number(v)];
          if (!r) return;
          this.curProvider = r.provider;
          this.urlEl.value = r.fullName;
          this.loadRepo();
        });
        this.myReposEl = d.selectEl;
      })
      .addButton((b) => b.setButtonText('列出').setTooltip('按令牌列出我的仓库').onClick(() => this.loadMyRepos()));

    new Setting(c).setName('分支').addDropdown((d) => {
      d.selectEl.addClass('lgp-gitrepo__wide');
      d.addOption('', '先读取仓库');
      d.setValue('');
      d.onChange((v) => {
        if (!v) return;
        this.curRef = v;
        this.browseSub = '';
        void this.renderMountList();
      });
      this.refEl = d.selectEl;
    });

    const actions = new Setting(c);
    actions.addButton((b) => b.setButtonText('读取仓库').setCta().onClick(() => this.loadRepo()));
    this.repoStatusEl = createSpan({ cls: 'lgp-gitrepo__status' });
    actions.nameEl.appendChild(this.repoStatusEl);
  }

  private myReposEl!: HTMLSelectElement;

  /** 读取仓库:解析地址 → 仓库信息 + 分支/标签 → 渲染挂载区 */
  private loadRepo(): void {
    if (this.repoLoading) return;
    const parsed = parseRepoInput(this.urlEl.value, this.curProvider);
    if (!parsed) {
      new Notice('无法识别仓库地址,请填 https 地址或 owner/repo');
      return;
    }
    this.curProvider = parsed.provider;
    this.curRepo = { owner: parsed.owner, repo: parsed.repo };
    this.repoLoading = true;
    this.repoStatusEl.textContent = '读取中…';
    void (async () => {
      try {
        const info = await gitRepoInfo(this.curProvider, parsed.owner, parsed.repo);
        const refs = await gitListRefs(this.curProvider, parsed.owner, parsed.repo);
        const want = parsed.ref || info.defaultBranch;
        // 分支/标签分组填下拉;地址里带的 ref 不在列表里(commit SHA、超出 100
        // 条的分支)也要能选,放最前面
        this.refEl.innerHTML = '';
        const addOpt = (v: string) => {
          const o = document.createElement('option');
          o.value = v;
          o.textContent = v;
          this.refEl.appendChild(o);
        };
        const group = (label: string, list: string[]) => {
          if (!list.length) return;
          const g = document.createElement('optgroup');
          g.label = label;
          for (const n of list) {
            const o = document.createElement('option');
            o.value = n;
            o.textContent = n;
            g.appendChild(o);
          }
          this.refEl.appendChild(g);
        };
        if (want && !refs.branches.includes(want) && !refs.tags.includes(want)) addOpt(want);
        group('分支', refs.branches);
        group('标签', refs.tags);
        this.curRef = want;
        this.refEl.value = want;
        this.browseSub = '';
        this.repoStatusEl.textContent = `${PROVIDER_LABEL[this.curProvider]} ${parsed.owner}/${parsed.repo} · ${info.isPrivate ? '私有' : '公开'}${info.description ? ' · ' + info.description : ''}`;
        await this.renderMountList();
      } catch (e) {
        this.curRepo = null;
        this.curRef = '';
        this.repoStatusEl.textContent = '读取失败';
        this.refEl.innerHTML = '<option value="">先读取仓库</option>';
        new Notice(String((e as Error)?.message || e), 6000);
        await this.renderMountList();
      } finally {
        this.repoLoading = false;
      }
    })();
  }

  /** 按已保存令牌列出可见仓库,填进下拉(选中即由 onChange 触发 loadRepo) */
  private loadMyRepos(): void {
    if (this.myReposLoading) return;
    this.myReposLoading = true;
    this.myReposEl.innerHTML = '<option value="">读取中…</option>';
    void (async () => {
      try {
        this.myRepos = await gitListMyRepos(this.curProvider);
        this.myReposEl.innerHTML = '';
        const head = document.createElement('option');
        head.value = '';
        head.textContent = this.myRepos.length ? `共 ${this.myRepos.length} 个,选一个…` : '该令牌下没有仓库';
        this.myReposEl.appendChild(head);
        this.myRepos.forEach((r, i) => {
          const o = document.createElement('option');
          o.value = String(i);
          o.textContent = `${r.fullName}${r.isPrivate ? '(私有)' : ''}`;
          this.myReposEl.appendChild(o);
        });
      } catch (e) {
        this.myReposEl.innerHTML = '<option value="">列出失败</option>';
        new Notice(String((e as Error)?.message || e), 6000);
      } finally {
        this.myReposLoading = false;
      }
    })();
  }

  // ------------------------------------------------------------------
  // 令牌区
  // ------------------------------------------------------------------

  private renderTokenSection(): void {
    const c = this.contentEl;
    c.createEl('h3', { text: '访问令牌(可选)' });
    c.createEl('p', {
      cls: 'setting-item-description',
      text: '公开仓库不填令牌也能浏览,但匿名配额仅 60 次/小时;私有仓库与写回提交必须填令牌。GitHub:Settings → Developer settings → Personal access tokens(classic 勾 repo,细粒度给 Contents 读写);Gitee:设置 → 私人令牌(勾 projects)。令牌仅保存在本地插件数据。',
    });
    // 令牌直接读写 settings(编辑中不落盘,保存并验证时才写)
    const tokens: Record<GitProvider, string> = {
      github: this.plugin.settings.gitGithubToken,
      gitee: this.plugin.settings.gitGiteeToken,
    };

    const gh = new Setting(c).setName('GitHub 令牌');
    gh.addText((t) => {
      t.setPlaceholder('ghp_… / github_pat_…(可留空)').setValue(tokens.github);
      t.inputEl.type = 'password';
      t.onChange((v) => {
        tokens.github = v;
      });
    });
    const ge = new Setting(c).setName('Gitee 令牌');
    ge.addText((t) => {
      t.setPlaceholder('Gitee 私人令牌(可留空)').setValue(tokens.gitee);
      t.inputEl.type = 'password';
      t.onChange((v) => {
        tokens.gitee = v;
      });
    });

    const actions = new Setting(c);
    actions.addButton((b) => b.setButtonText('保存并验证').setCta().onClick(() => {
      void (async () => {
        this.tokenStatusEl.textContent = '保存中…';
        // 换令牌后可见仓库范围会变:写回 settings 前先清掉整树缓存
        this.plugin.settings.gitGithubToken = tokens.github.trim();
        this.plugin.settings.gitGiteeToken = tokens.gitee.trim();
        clearGitRepoCache();
        await this.plugin.saveSettings();
        const parts: string[] = [];
        const failed: string[] = [];
        for (const [provider, token] of [
          ['github', tokens.github.trim()],
          ['gitee', tokens.gitee.trim()],
        ] as [GitProvider, string][]) {
          if (!token) continue;
          try {
            const login = await gitVerifyToken(provider);
            parts.push(`${PROVIDER_LABEL[provider]}: ${login || '已连接'}`);
          } catch (e) {
            failed.push(`${PROVIDER_LABEL[provider]}: ${(e as Error)?.message || e}`);
          }
        }
        this.tokenStatusEl.textContent =
          parts.length || failed.length
            ? [...parts, ...failed].join(' / ')
            : '未填令牌(公开仓库可浏览,写回提交需要令牌)';
        if (failed.length) new Notice(failed.join('\n'), 6000);
        else if (parts.length) new Notice('令牌验证通过');
        // 换令牌后可见仓库范围会变,已读过的仓库重新拉一次
        if (this.curRepo) this.loadRepo();
      })();
    }));
    this.tokenStatusEl = createSpan({ cls: 'lgp-gitrepo__status' });
    actions.nameEl.appendChild(this.tokenStatusEl);
  }

  // ------------------------------------------------------------------
  // 挂载区
  // ------------------------------------------------------------------

  private renderMountSection(): void {
    if (!this.onPick) return;
    const c = this.contentEl;
    c.createEl('h3', { text: '选择挂载目标' });
    this.crumbEl = c.createDiv({ cls: 'lgp-gitrepo__crumb' });
    this.listEl = c.createDiv({ cls: 'lgp-gitrepo__list' });
  }

  private curVPath(): string {
    return buildGitRepoPath({
      provider: this.curProvider,
      owner: this.curRepo!.owner,
      repo: this.curRepo!.repo,
      ref: this.curRef,
      path: this.browseSub,
    });
  }

  private pick(vPath: string, label: string, isDir: boolean): void {
    this.close();
    this.onPick?.({ vPath, label, isDir });
  }

  /** 渲染挂载区:仓库根 / 子目录浏览层 */
  private async renderMountList(): Promise<void> {
    if (!this.onPick) return;
    const crumb = this.crumbEl;
    const list = this.listEl;
    if (!this.curRepo || !this.curRef) {
      crumb.empty();
      crumb.createSpan({ text: '选择挂载目标' });
      list.empty();
      list.createDiv({ cls: 'setting-item-description', text: '请先在上方填写仓库地址并点「读取仓库」' });
      return;
    }
    const vPath = this.curVPath();
    const label = remoteShortName(vPath);
    crumb.empty();
    if (this.browseSub) {
      const back = crumb.createSpan({ cls: 'lgp-gitrepo__back', text: '‹ 返回' });
      back.setAttribute('title', '返回上一级');
      back.addEventListener('click', () => {
        const idx = this.browseSub.lastIndexOf('/');
        this.browseSub = idx > 0 ? this.browseSub.slice(0, idx) : '';
        void this.renderMountList();
      });
    }
    crumb.createSpan({ cls: 'lgp-gitrepo__cur', attr: { title: label }, text: label });
    const pickCur = crumb.createEl('button', {
      cls: 'mod-cta',
      text: this.browseSub ? '挂载当前目录' : '挂载仓库根',
    });
    pickCur.addEventListener('click', () => {
      this.pick(this.curVPath(), this.browseSub || `${this.curRepo!.owner}/${this.curRepo!.repo}@${this.curRef}`, true);
    });
    list.empty();
    list.createDiv({ cls: 'setting-item-description', text: '加载中…' });
    try {
      const entries = await gitListDir(vPath);
      // 目录在前、文件在后;文件也能直接挂(挂单个文件时下游按文件打开,不展开)
      const sorted = [...entries].sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1);
      list.empty();
      if (sorted.length === 0) {
        list.createDiv({ cls: 'setting-item-description', text: '空目录(可直接挂载当前目录)' });
        return;
      }
      for (const e of sorted) {
        const row = list.createDiv({ cls: 'lgp-gitrepo__row' });
        row.createSpan({ cls: 'lgp-gitrepo__name', attr: { title: e.name }, text: e.name });
        if (e.isDir) {
          const enter = row.createEl('button', { text: '进入' });
          enter.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.browseSub = e.rel;
            void this.renderMountList();
          });
        }
        const pickBtn = row.createEl('button', { cls: 'mod-cta', text: '挂载' });
        pickBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.pick(e.abs, e.name, e.isDir);
        });
        if (e.isDir) {
          row.addEventListener('click', () => {
            this.browseSub = e.rel;
            void this.renderMountList();
          });
        }
      }
    } catch (err) {
      list.empty();
      list.createDiv({ cls: 'setting-item-description', text: `加载失败: ${String((err as Error)?.message || err)}` });
    }
  }
}
