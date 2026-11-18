/**
 * 挂载链接/网址 与 脚本/命令 的挂载弹窗（思源 action-mount-dialog 同款形态）。
 */
import { App, Modal } from 'obsidian';
import { makeWeblinkVPath } from '../features/linkMount';
import { makeActionVPath, type ActionSpec } from '../features/actionMount';

/** 挂载链接/网址：名称（可空 = 用域名）+ URL。 */
export function openWeblinkMountDialog(
  app: App,
  plugin: { promptMountEntry(draft: { kind: 'remote'; path: string; label: string; include: string; exclude: string; refreshSeconds: number; pinned: boolean }): void },
): void {
  new WeblinkMountModal(app, plugin).open();
}

class WeblinkMountModal extends Modal {
  constructor(
    app: App,
    private plugin: { promptMountEntry(draft: { kind: 'remote'; path: string; label: string; include: string; exclude: string; refreshSeconds: number; pinned: boolean }): void },
  ) {
    super(app as never);
  }
  onOpen(): void {
    this.contentEl.createEl('h3', { text: '挂载链接/网址' });
    const name = this.contentEl.createEl('input', { type: 'text', placeholder: '名称（留空 = 用域名）' });
    name.style.cssText = 'width:100%;margin-bottom:8px';
    const url = this.contentEl.createEl('input', { type: 'text', placeholder: 'https://…' });
    url.style.cssText = 'width:100%;margin-bottom:10px';
    const submit = (): void => {
      const u = url.value.trim();
      if (!/^https?:\/\//i.test(u)) return;
      const label = name.value.trim() || (() => {
        try {
          return new URL(u).hostname;
        } catch {
          return u;
        }
      })();
      this.close();
      this.plugin.promptMountEntry({
        kind: 'remote',
        path: makeWeblinkVPath(u),
        label,
        include: '',
        exclude: '',
        refreshSeconds: 0,
        pinned: false,
      });
    };
    url.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    const btn = this.contentEl.createEl('button', { text: '挂载', cls: 'mod-cta' });
    btn.style.width = '100%';
    btn.addEventListener('click', submit);
    url.focus();
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

/** 挂载脚本/命令：名称 + 类型（shell|js）+ 命令体 + cwd（仅 shell）。Ctrl+Enter 提交。 */
export function openActionMountDialog(
  app: App,
  opts: { onPicked: (vPath: string, name: string) => void },
  initial?: { name: string; spec: ActionSpec; vPath: string },
): void {
  new ActionMountModal(app, opts, initial).open();
}

class ActionMountModal extends Modal {
  constructor(
    app: App,
    private opts: { onPicked: (vPath: string, name: string) => void },
    private initial?: { name: string; spec: ActionSpec; vPath: string },
  ) {
    super(app as never);
  }
  onOpen(): void {
    const init = this.initial;
    this.contentEl.createEl('h3', { text: init ? '编辑脚本/命令' : '挂载脚本/命令' });
    const name = this.contentEl.createEl('input', { type: 'text', placeholder: '名称' });
    name.value = init?.name ?? '';
    name.style.cssText = 'width:100%;margin-bottom:8px';
    const typeSel = this.contentEl.createEl('select');
    typeSel.style.cssText = 'width:100%;margin-bottom:8px';
    typeSel.createEl('option', { text: 'shell 命令（桌面端）', value: 'shell' });
    typeSel.createEl('option', { text: 'js 脚本（页面上下文）', value: 'js' });
    typeSel.value = init?.spec.type ?? 'shell';
    const cmd = this.contentEl.createEl('textarea');
    cmd.placeholder = typeSel.value === 'js' ? '// js 代码，console 被捕获进输出' : '命令行，如 node build.js';
    cmd.value = init?.spec.cmd ?? '';
    cmd.style.cssText = 'width:100%;min-height:110px;font-family:monospace;margin-bottom:8px';
    const cwd = this.contentEl.createEl('input', { type: 'text', placeholder: '工作目录（仅 shell，可空）' });
    cwd.value = init?.spec.cwd ?? '';
    cwd.style.cssText = 'width:100%;margin-bottom:10px';
    const syncCwdVisibility = (): void => {
      cwd.style.display = typeSel.value === 'shell' ? '' : 'none';
    };
    typeSel.addEventListener('change', syncCwdVisibility);
    syncCwdVisibility();
    const submit = (): void => {
      const spec: ActionSpec = {
        type: (typeSel.value as 'shell' | 'js') ?? 'shell',
        cmd: cmd.value.trim(),
        ...(typeSel.value === 'shell' && cwd.value.trim() ? { cwd: cwd.value.trim() } : {}),
      };
      if (!spec.cmd) return;
      const label = name.value.trim() || (spec.type === 'shell' ? '命令' : '脚本');
      this.close();
      this.opts.onPicked(makeActionVPath(spec), label);
    };
    cmd.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      }
    });
    const btn = this.contentEl.createEl('button', { text: init ? '保存' : '挂载', cls: 'mod-cta' });
    btn.style.width = '100%';
    btn.addEventListener('click', submit);
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
