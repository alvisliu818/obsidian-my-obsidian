/**
 * 云端历史版本弹窗(2026-11-22 用户:OneDrive / 百度同步空间)。
 *
 * 入口:挂载面板里右键 OneDrive / 百度网盘文件 →「云端历史版本…」。
 * 数据/动作全部走 features/cloudVersions(按路径自动分发到 Graph 或百度网页接口):
 *  - OneDrive:可预览任一历史版本、可恢复(下载后覆盖当前文件);
 *  - 百度同步空间:只列版本,恢复按客户端语义「另存为新文件」,不支持预览。
 */
import { App, Modal, Notice } from 'obsidian';
import {
  cloudProviderOf,
  listCloudVersions,
  readCloudVersionText,
  restoreCloudVersion,
  type CloudProvider,
  type CloudVersion,
} from '../features/cloudVersions';

function fmtTime(iso: string): string {
  if (!iso) return '时间未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export class CloudHistoryModal extends Modal {
  private readonly provider: CloudProvider | null;
  private busy = false;

  constructor(app: App, private readonly filePath: string) {
    super(app);
    this.provider = cloudProviderOf(filePath);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('lgp-cloud-history');
    const name = this.filePath.split('/').pop() || this.filePath;
    contentEl.createEl('h3', { text: `云端历史版本 · ${name}` });
    contentEl.createDiv({ cls: 'lgp-cloud-history-path', text: this.filePath });
    if (!this.provider) {
      contentEl.createDiv({ cls: 'lgp-cloud-history-muted', text: '该路径不在 OneDrive / 百度网盘挂载内。' });
      return;
    }
    contentEl.createDiv({
      cls: 'lgp-cloud-history-muted',
      text:
        this.provider === 'onedrive'
          ? '来自 Microsoft Graph 的云端版本列表;恢复会用所选版本覆盖当前文件。'
          : '来自百度网盘同步空间的云端版本列表;百度不支持版本内容下载,恢复会把该版本另存为新文件(不覆盖当前文件)。',
    });
    void this.load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    const host = this.contentEl.createDiv({ cls: 'lgp-cloud-history-list' });
    host.createDiv({ cls: 'lgp-cloud-history-muted', text: '加载中…' });
    try {
      const versions = await listCloudVersions(this.filePath);
      host.empty();
      if (!versions.length) {
        host.createDiv({
          cls: 'lgp-cloud-history-muted',
          text:
            this.provider === 'bdpan'
              ? '没有历史版本。百度只对同步空间内、已开启历史版本的文件保留版本(免费用户保留前 3 个,SVIP 保留更多)。'
              : '没有历史版本(云端只保留当前版本,或版本保留期已过)。',
        });
        return;
      }
      for (const v of versions) this.renderRow(host, v);
    } catch (e) {
      host.empty();
      host.createDiv({ cls: 'lgp-cloud-history-error', text: String(e).slice(0, 300) });
      const retry = host.createEl('button', { text: '重试' });
      retry.addEventListener('click', () => void this.load());
    }
  }

  private renderRow(host: HTMLElement, v: CloudVersion): void {
    const row = host.createDiv({ cls: 'lgp-cloud-history-row' + (v.current ? ' is-current' : '') });
    row.createSpan({ cls: 'lgp-cloud-history-time', text: fmtTime(v.modified) });
    row.createSpan({ cls: 'lgp-cloud-history-size', text: fmtSize(v.size) });
    if (v.current) {
      row.createSpan({ cls: 'lgp-cloud-history-badge', text: '当前' });
      return;
    }
    const btns = row.createDiv({ cls: 'lgp-cloud-history-btns' });
    if (this.provider === 'onedrive') {
      const preview = btns.createEl('button', { text: '预览' });
      preview.addEventListener('click', () => void this.preview(v));
      const restore = btns.createEl('button', { text: '恢复' });
      restore.addEventListener('click', () => void this.restore(v, '恢复'));
    } else {
      const save = btns.createEl('button', { text: '另存为' });
      save.addEventListener('click', () => void this.restore(v, '另存为'));
    }
  }

  private async preview(v: CloudVersion): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const text = await readCloudVersionText(this.filePath, v.id);
      const box = this.contentEl.createDiv({ cls: 'lgp-cloud-history-preview' });
      const head = box.createDiv({ cls: 'lgp-cloud-history-preview-head' });
      head.createSpan({ text: `${fmtTime(v.modified)} · ${fmtSize(v.size) || '大小未知'}` });
      const close = head.createEl('button', { text: '关闭预览' });
      close.addEventListener('click', () => box.remove());
      box.createEl('pre', { text: text.length ? text : '(空文件)' });
      box.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      new Notice(String(e).slice(0, 200), 6000);
    } finally {
      this.busy = false;
    }
  }

  private async restore(v: CloudVersion, label: string): Promise<void> {
    if (this.busy) return;
    const ok = window.confirm(
      this.provider === 'onedrive'
        ? `恢复 ${fmtTime(v.modified)} 的版本?\n\n当前文件内容会被覆盖(云端会保留一个新版本)。`
        : `把 ${fmtTime(v.modified)} 的版本另存为新文件?\n\n百度历史版本恢复不会覆盖当前文件。`,
    );
    if (!ok) return;
    this.busy = true;
    try {
      const msg = await restoreCloudVersion(this.filePath, v.id);
      new Notice(`${label}成功:${msg}`, 6000);
      await this.load();
    } catch (e) {
      new Notice(`${label}失败:${String(e).slice(0, 200)}`, 8000);
    } finally {
      this.busy = false;
    }
  }
}
