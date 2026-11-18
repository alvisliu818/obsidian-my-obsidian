/**
 * Outlook 邮箱挂载弹窗(思源 outlook-mail-dialog 同款交互):
 * 接入配置(clientId,可复用 OneDrive 的应用)→ 设备码授权 → 选文件夹 → 挂载。
 *
 * 邮箱挂载是只读源,挂载根可以是 outlook://(全部文件夹)或某个具体文件夹
 * outlook:///<folder>。
 */

import { Modal, Notice, setIcon, type App } from 'obsidian';
import {
  getOutlookMailConfig,
  isOutlookMailConfigured,
  mailListFolders,
  mailPollDeviceAuth,
  mailStartDeviceAuth,
  saveOutlookMailConfig,
  type MailDeviceAuth,
} from '../features/outlookMailApi';
import { getOneDriveConfig } from '../features/onedriveApi';
import { OUTLOOK_PREFIX } from '../features/outlookMailPath';

export interface OutlookMailPick {
  vPath: string;
  label: string;
}

export class OutlookMailMountModal extends Modal {
  private auth: MailDeviceAuth | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onPick: (p: OutlookMailPick) => void;

  constructor(app: App, opts: { onPick: (p: OutlookMailPick) => void }) {
    super(app);
    this.onPick = opts.onPick;
  }

  onOpen(): void {
    this.renderIntro();
  }

  onClose(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.contentEl.empty();
  }

  // ===== 第一步:接入配置 + 授权 =====

  private renderIntro(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '挂载 Outlook 邮箱(只读)' });
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        '同一个 Azure 应用可以同时用于 OneDrive 与邮箱:API 权限再加 Mail.ReadWrite 即可。' +
        'client_id 留空时自动复用 OneDrive 已保存的应用 ID。邮箱挂载为只读:邮件以 Markdown 文件呈现' +
        '(正文转文本 + 元信息头),附件在 <邮件>.files/ 下懒下载。',
    });

    const cfg = getOutlookMailConfig();
    const odCfg = getOneDriveConfig();
    const idRow = contentEl.createDiv({ cls: 'lgp-name-prompt-row' });
    const idInput = idRow.createEl('input', {
      type: 'text',
      cls: 'lgp-search-modal__input',
      attr: { placeholder: `应用(client) ID(留空复用 OneDrive 的${odCfg.clientId ? '已填' : '未填'})`, spellcheck: 'false' },
    });
    idInput.value = cfg.clientId;
    idInput.style.flex = '1';
    const authBtn = idRow.createEl('button', { cls: 'mod-cta', text: isOutlookMailConfigured() ? '重新授权' : '发起授权' });

    const statusEl = contentEl.createDiv({ cls: 'lgp-od-modal__status' });
    if (isOutlookMailConfigured()) {
      statusEl.textContent = `已授权${cfg.account ? `:${cfg.account}` : ''}。可以直接选择文件夹挂载。`;
    }

    const folderBtn = contentEl.createEl('button', {
      cls: 'mod-cta',
      text: '选择文件夹挂载…',
    });
    folderBtn.disabled = !isOutlookMailConfigured();
    folderBtn.addEventListener('click', () => this.renderFolders());

    authBtn.addEventListener('click', () => {
      const clientId = idInput.value.trim() || getOutlookMailConfig().clientId;
      if (!clientId) {
        new Notice('请填写应用(client) ID,或先在 OneDrive 挂载里完成配置');
        return;
      }
      void (async () => {
        try {
          await saveOutlookMailConfig({ clientId, account: '' });
          this.auth = await mailStartDeviceAuth(clientId, getOutlookMailConfig().authority);
        } catch (e) {
          new Notice(`${(e as Error)?.message ?? '发起授权失败'}`, 8000);
          return;
        }
        this.renderAuthWait();
      })();
    });
  }

  // ===== 第二步:设备码输码等待 =====

  private renderAuthWait(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '等待授权…' });
    const auth = this.auth;
    if (!auth) return;
    const box = contentEl.createDiv({ cls: 'lgp-od-modal__authbox' });
    box.createEl('p', { text: '1. 在任意设备打开下面的链接并登录微软账号:' });
    const linkRow = box.createDiv({ cls: 'lgp-od-modal__code' });
    const link = linkRow.createEl('a', { text: auth.verificationUrl, href: auth.verificationUrl });
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(auth.verificationUrl, '_blank');
    });
    box.createEl('p', { text: '2. 输入设备码:' });
    box.createDiv({ cls: 'lgp-od-modal__code lgp-od-modal__code--big', text: auth.userCode });
    const statusEl = contentEl.createDiv({ cls: 'lgp-od-modal__status', text: '等待你在微软页面完成授权…' });
    const cancelBtn = contentEl.createEl('button', { text: '取消' });
    cancelBtn.addEventListener('click', () => {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.renderIntro();
    });

    const poll = (): void => {
      if (!this.auth) return;
      void mailPollDeviceAuth(this.auth).then(
        (r) => {
          if (r === 'done') {
            new Notice('Outlook 邮箱授权成功');
            this.renderIntro();
            return;
          }
          const delay = (this.auth?.interval ?? 5) * 1000 + (r === 'slow' ? 5000 : 0);
          this.pollTimer = setTimeout(poll, delay);
        },
        (e) => {
          statusEl.textContent = `授权失败:${(e as Error)?.message ?? '未知错误'}`;
        },
      );
    };
    this.pollTimer = setTimeout(poll, (auth.interval ?? 5) * 1000);
  }

  // ===== 第三步:选文件夹挂载 =====

  private async renderFolders(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '选择要挂载的邮件文件夹' });
    const bar = contentEl.createDiv({ cls: 'lgp-od-modal__crumbs' });
    const rootBtn = bar.createEl('button', { text: '挂载全部文件夹(outlook://)' });
    rootBtn.addEventListener('click', () => {
      this.close();
      this.onPick({ vPath: OUTLOOK_PREFIX, label: '[Outlook 邮箱]' });
    });
    const list = contentEl.createDiv({ cls: 'lgp-od-modal__list' });
    list.createDiv({ cls: 'lgp-od-modal__empty', text: '加载文件夹中…' });
    try {
      const folders = await mailListFolders();
      list.empty();
      for (const f of folders) {
        const row = list.createDiv({ cls: 'lgp-od-modal__row' });
        const icon = row.createSpan({ cls: 'lgp-od-modal__icon' });
        setIcon(icon, 'mail');
        row.createSpan({ text: `${f.name} (${f.total})` });
        row.addEventListener('click', () => {
          this.close();
          this.onPick({
            vPath: OUTLOOK_PREFIX + '/' + f.name,
            label: `[Outlook] ${f.name}`,
          });
        });
      }
    } catch (e) {
      list.empty();
      list.createDiv({ cls: 'lgp-od-modal__empty', text: `加载失败:${(e as Error)?.message ?? '未知错误'}` });
    }
  }
}
