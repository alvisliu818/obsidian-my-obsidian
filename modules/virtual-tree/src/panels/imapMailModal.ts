/**
 * 挂载 IMAP 邮箱对话框（思源 imap-mail-dialog.ts 对齐）：
 * provider 选择（QQ/163/126）+ 邮箱地址 + IMAP 授权码 + host/port 覆盖。
 * 凭据写入模块设置（imapMail 字段），确认后挂载 `imap://<provider>` 根。
 */
import { App, Modal, Notice, Setting } from 'obsidian';
import { IMAP_PROVIDERS } from '../features/imapPath';

export interface ImapMailPick {
  vPath: string;
  label: string;
}

export class ImapMailMountModal extends Modal {
  constructor(
    app: App,
    private opts: {
      onPick: (p: ImapMailPick) => void;
      /** 凭据确认时回调（宿主落到 virtual-tree 设置 imapMail 字段）。 */
      onConfig: (cfg: { provider: string; user: string; pass: string; host?: string; port?: number }) => void;
    },
  ) {
    super(app as never);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '挂载 IMAP 邮箱（只读）' });
    contentEl.createEl('p', { text: '邮箱需先在网页端开启 IMAP 并生成授权码（QQ：设置→账户；163/126：POP3/SMTP/IMAP）。' }, ).style.cssText = 'font-size:12px;color:var(--text-muted)';

    let provider = 'qq';
    let user = '';
    let pass = '';
    let customHost = '';
    let customPort = '';

    const rows = contentEl.createDiv();
    rows.style.cssText = 'display:flex;flex-direction:column;gap:10px';

    const providerSetting = new Setting(rows)
      .setName('邮箱服务商')
      .addDropdown((d) => {
        for (const p of IMAP_PROVIDERS) d.addOption(p.key, p.label);
        d.setValue(provider).onChange((v) => {
          provider = v;
        });
      });

    new Setting(rows)
      .setName('邮箱地址')
      .addText((t) => {
        t.setPlaceholder('user@qq.com');
        t.setValue(user);
        t.onChange((v) => {
          user = v.trim();
        });
      });

    new Setting(rows)
      .setName('IMAP 授权码')
      .setDesc('不是登录密码；QQ/163/126 均在网页端设置里生成')
      .addText((t) => {
        t.setPlaceholder('授权码');
        t.inputEl.type = 'password';
        t.onChange((v) => {
          pass = v.trim();
        });
      });

    const adv = new Setting(rows).setName('自定义服务器（可选）');
    adv.addText((t) => {
      t.setPlaceholder('imap.example.com');
      t.onChange((v) => {
        customHost = v.trim();
      });
    });
    adv.addText((t) => {
      t.setPlaceholder('993');
      t.inputEl.type = 'number';
      t.onChange((v) => {
        customPort = v.trim();
      });
    });
    void providerSetting;

    const btn = contentEl.createEl('button', { text: '挂载', cls: 'mod-cta' });
    btn.style.cssText = 'width:100%;margin-top:10px';
    btn.addEventListener('click', () => {
      if (!user || !pass) {
        new Notice('请填写邮箱地址与授权码');
        return;
      }
      const cfg: { provider: string; user: string; pass: string; host?: string; port?: number } = { provider, user, pass };
      if (customHost) cfg.host = customHost;
      if (customPort) cfg.port = Number(customPort) || undefined;
      // 凭据回落宿主设置（imapMail 字段持久化），面板据此连接
      this.opts.onConfig(cfg);
      this.close();
      const label = '[IMAP] ' + user;
      this.opts.onPick({ vPath: `imap://${encodeURIComponent(provider)}`, label });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
