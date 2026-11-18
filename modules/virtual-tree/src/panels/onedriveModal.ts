/**
 * OneDrive 挂载弹窗(思源 onedrive-dialog 同款交互):
 * 接入配置(clientId)→ 设备码授权(输码轮询)→ 浏览驱动器 → 挂载目录。
 *
 * 与百度网盘弹窗同构:onPick 回调把选中的 onedrive:// 虚拟路径交给宿主的
 * promptMountEntry 落成 remote 挂载。凭据存设置切片(settings.oneDrive)。
 */

import { Modal, Notice, setIcon, type App } from 'obsidian';
import {
  clearOneDriveListCache,
  getOneDriveConfig,
  isOneDriveConfigured,
  odListDir,
  odPollDeviceAuth,
  odQuota,
  odStartDeviceAuth,
  saveOneDriveConfig,
  type OdDeviceAuth,
} from '../features/onedriveApi';
import { oneDriveRootLabel } from '../features/onedrivePath';
import type { MountNode } from '../features/mountFilter';

export interface OneDrivePick {
  vPath: string;
  label: string;
}

export class OneDriveMountModal extends Modal {
  private browseVPath = 'onedrive://';
  private browsing = false;
  private auth: OdDeviceAuth | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onPick: (p: OneDrivePick) => void;

  constructor(app: App, opts: { onPick: (p: OneDrivePick) => void }) {
    super(app);
    this.onPick = opts.onPick;
  }

  onOpen(): void {
    this.contentEl.addClass('lgp-od-modal');
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
    contentEl.createEl('h3', { text: '挂载 OneDrive' });
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        '需要在 Azure(Entra 管理中心)注册一个自己的应用:「个人」类型、重定向 URI 留空、' +
        'API 权限勾 Files.ReadWrite.All + User.Read + offline_access、「允许公共客户端流」设为是,' +
        '然后把应用(client) ID 填进来。授权走设备码流:在任意设备打开 microsoft.com/devicelogin 输码即可。',
    });

    const cfg = getOneDriveConfig();
    const idRow = contentEl.createDiv({ cls: 'lgp-name-prompt-row' });
    const idInput = idRow.createEl('input', {
      type: 'text',
      cls: 'lgp-search-modal__input',
      attr: { placeholder: '应用(client) ID,如 00000000-0000-…', spellcheck: 'false' },
    });
    idInput.value = cfg.clientId;
    idInput.style.flex = '1';
    const authBtn = idRow.createEl('button', { cls: 'mod-cta', text: isOneDriveConfigured() ? '重新授权' : '发起授权' });

    const statusEl = contentEl.createDiv({ cls: 'lgp-od-modal__status' });
    if (isOneDriveConfigured()) {
      statusEl.textContent = `已授权${cfg.account ? `:${cfg.account}` : ''}。可以直接浏览挂载,或重新授权换账号。`;
      const browseBtn = contentEl.createEl('button', { cls: 'mod-cta', text: '浏览驱动器…' });
      browseBtn.addEventListener('click', () => this.renderBrowse());
    }

    authBtn.addEventListener('click', () => {
      const clientId = idInput.value.trim();
      if (!clientId) {
        new Notice('请先填写应用(client) ID');
        return;
      }
      void (async () => {
        try {
          await saveOneDriveConfig({ clientId, account: '' });
          this.auth = await odStartDeviceAuth(clientId, getOneDriveConfig().authority);
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
      if (Date.now() > this.auth.expiresAt) {
        statusEl.textContent = '授权码已过期,请重新发起授权。';
        return;
      }
      void odPollDeviceAuth(this.auth).then(
        (r) => {
          if (r === 'done') {
            new Notice('OneDrive 授权成功');
            this.renderIntro();
            return;
          }
          // pending/slow:按 interval 继续轮询(slow 加 5s 退避)
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

  // ===== 第三步:浏览驱动器 =====

  private async renderBrowse(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: `选择要挂载的目录:${oneDriveRootLabel(this.browseVPath)}` });
    const crumb = contentEl.createDiv({ cls: 'lgp-od-modal__crumbs' });
    const upBtn = crumb.createEl('button', { text: '上级' });
    upBtn.disabled = this.browseVPath === 'onedrive://';
    upBtn.addEventListener('click', () => {
      const body = this.browseVPath.slice('onedrive://'.length).replace(/\/+$/, '');
      const slash = body.lastIndexOf('/');
      this.browseVPath = slash > 0 ? 'onedrive://' + body.slice(0, slash) : 'onedrive://';
      void this.renderBrowse();
    });
    const refreshBtn = crumb.createEl('button', { text: '刷新' });
    refreshBtn.addEventListener('click', () => {
      clearOneDriveListCache(this.browseVPath);
      void this.renderBrowse();
    });
    const pickBtn = crumb.createEl('button', { cls: 'mod-cta', text: '挂载当前目录' });
    pickBtn.addEventListener('click', () => {
      this.close();
      this.onPick({
        vPath: this.browseVPath,
        label: oneDriveRootLabel(this.browseVPath),
      });
    });

    const list = contentEl.createDiv({ cls: 'lgp-od-modal__list' });
    if (!isOneDriveConfigured()) {
      list.createDiv({ cls: 'lgp-od-modal__empty', text: '尚未授权,请先完成授权。' });
      return;
    }
    if (this.browseVPath === 'onedrive://') {
      // 驱动器根顺手展示配额(验证凭据 + 让用户知道空间状况)
      void odQuota()
        .then((q) => {
          const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(1);
          const quotaEl = contentEl.createDiv({ cls: 'lgp-od-modal__status' });
          quotaEl.textContent = `已用 ${gb(q.used)} GB / 共 ${gb(q.quota)} GB`;
        })
        .catch(() => undefined);
    }
    if (this.browsing) return;
    this.browsing = true;
    try {
      const entries: MountNode[] = await odListDir(this.browseVPath);
      const dirs = entries.filter((e) => e.isDir);
      if (!dirs.length) {
        list.createDiv({ cls: 'lgp-od-modal__empty', text: '(空目录或没有子文件夹)' });
      }
      for (const d of dirs) {
        const row = list.createDiv({ cls: 'lgp-od-modal__row' });
        const icon = row.createSpan({ cls: 'lgp-od-modal__icon' });
        setIcon(icon, 'folder');
        row.createSpan({ text: d.name });
        row.addEventListener('click', () => {
          this.browseVPath = d.abs;
          void this.renderBrowse();
        });
      }
    } catch (e) {
      list.createDiv({ cls: 'lgp-od-modal__empty', text: `列目录失败:${(e as Error)?.message ?? '未知错误'}` });
    } finally {
      this.browsing = false;
    }
  }
}
