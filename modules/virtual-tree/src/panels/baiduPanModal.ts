/**
 * 百度网盘挂载对话框:账号配置 + 挂载目标选择,两区合而为一。
 *
 * - 账号区:接入方式二选一
 *     official —— 官方 API:填写开放平台 AppKey/SecretKey(pan.baidu.com/union
 *                  创建应用),设备码授权(发起 → 验证码 → 轮询,令牌自动续期);
 *     cookie   —— 网页 Cookie(BDUSS/STOKEN,全盘 + 同步空间,非官方接口)。
 * - 挂载区(onPick 提供时显示):快捷挂载「同步空间」(仅 cookie 模式),或逐层
 *   浏览网盘目录后挂载任意文件夹。
 * - 挂载结果经 onPick 交给 promptMountEntry(位置选择复用 MountPositionModal)。
 *
 * 移植自 siyuan-virtual-tree 的 components/baidu-pan-dialog.ts(2026-11-14)。
 */

import { Modal, Notice, Setting } from 'obsidian';
import type VirtualTreePlugin from '../main';
import {
  BdAuthTransientError,
  bdListDir,
  bdPollDeviceAuth,
  bdQuota,
  bdStartDeviceAuth,
  getBaiduPanConfig,
  isBaiduConfigured,
  saveBaiduPanConfig,
  type BdDeviceAuth,
} from '../features/baiduPanApi';
import { BDPAN_SYNC_ROOT, baiduShortName } from '../features/baiduPath';
import type { BaiduPanSettings } from '../types';

export interface BaiduPanPick {
  vPath: string;
  label: string;
}

export class BaiduPanMountModal extends Modal {
  private plugin: VirtualTreePlugin;
  private onPick?: (pick: BaiduPanPick) => void;
  /** 对话框内独立的浏览状态与接入方式(确认保存后才写入配置) */
  private browseVPath: string | null = null;
  private curMode: BaiduPanSettings['mode'];
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前接入方式下的可编辑草稿(保存时才落盘) */
  private draft: BaiduPanSettings;
  private authSecEl!: HTMLElement;
  private statusEl!: HTMLElement;

  constructor(plugin: VirtualTreePlugin, opts: { onPick?: (pick: BaiduPanPick) => void } = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.onPick = opts.onPick;
    const cfg = getBaiduPanConfig();
    this.curMode = cfg.mode;
    this.draft = { ...cfg };
  }

  onOpen(): void {
    this.titleEl.setText('百度网盘');
    this.renderAuthSection();
    if (this.onPick) this.renderMountSection();
    void this.renderMountList();
  }

  onClose(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.contentEl.empty();
  }

  // ------------------------------------------------------------------
  // 账号区
  // ------------------------------------------------------------------

  private renderAuthSection(): void {
    const c = this.contentEl;
    c.createEl('h3', { text: '接入方式' });
    const head = new Setting(c).setName('接入方式');
    head.addDropdown((d) => {
      d.addOption('official', '官方 API(推荐:合规稳定,需在开放平台创建应用)');
      d.addOption('cookie', '网页 Cookie(全盘 + 同步空间,非官方接口)');
      d.setValue(this.curMode);
      d.onChange((v) => {
        this.curMode = v === 'cookie' ? 'cookie' : 'official';
        this.renderAuthFields();
      });
    });
    head.addButton((b) => b.setButtonText('保存并验证').setCta().onClick(() => void this.saveAndVerify()));
    this.statusEl = createSpan({ cls: 'lgp-bdpan__status' });
    head.nameEl.appendChild(this.statusEl);
    this.authSecEl = c.createDiv({ cls: 'lgp-bdpan__auth' });
    this.renderAuthFields();
  }

  /** 渲染当前接入方式的凭据字段 */
  private renderAuthFields(): void {
    const c = this.authSecEl;
    c.empty();
    if (this.curMode === 'official') {
      c.createEl('p', {
        cls: 'setting-item-description',
        text: '1. 访问 pan.baidu.com/union 注册开发者并创建应用,拿到 AppKey / SecretKey;2. 填入后点「获取授权」,在百度页面输入验证码确认即可(令牌 30 天有效,自动续期)。注意:未过审应用仅能访问网盘「我的应用数据 /apps/应用名/」目录,且官方 API 无同步空间。',
      });
      new Setting(c).setName('AppKey').addText((t) => {
        t.setPlaceholder('开放平台应用的 AppKey(必需)').setValue(this.draft.appKey);
        t.onChange((v) => {
          this.draft.appKey = v;
        });
      });
      const sk = new Setting(c).setName('SecretKey');
      sk.addText((t) => {
        t.setPlaceholder('开放平台应用的 SecretKey(必需)').setValue(this.draft.secretKey);
        t.inputEl.type = 'password';
        t.onChange((v) => {
          this.draft.secretKey = v;
        });
      });
      const auth = new Setting(c);
      auth.addButton((b) =>
        b.setButtonText('获取授权').setTooltip('发起设备码授权').onClick(() => void this.startDeviceAuth()),
      );
      this.authStatusEl = createSpan({ cls: 'lgp-bdpan__status' });
      auth.nameEl.appendChild(this.authStatusEl);
      this.authStatusEl.textContent = this.draft.accessToken ? '已授权(令牌自动续期)' : '尚未授权';
      this.authFlowEl = c.createDiv({ cls: 'lgp-bdpan__authflow' });
    } else {
      c.createEl('p', {
        cls: 'setting-item-description',
        text: '登录 pan.baidu.com 后,浏览器 F12 → 应用/存储 → Cookies → 复制 BDUSS 与 STOKEN。凭据仅保存在本地插件数据;接口为非官方接口,请勿高频操作以免触发风控。',
      });
      new Setting(c).setName('BDUSS').addText((t) => {
        t.setPlaceholder('网页 Cookie 中的 BDUSS 值(必需)').setValue(this.draft.bduss);
        t.inputEl.type = 'password';
        t.onChange((v) => {
          this.draft.bduss = v;
        });
      });
      new Setting(c).setName('STOKEN').addText((t) => {
        t.setPlaceholder('网页 Cookie 中的 STOKEN 值(建议)').setValue(this.draft.stoken);
        t.inputEl.type = 'password';
        t.onChange((v) => {
          this.draft.stoken = v;
        });
      });
      new Setting(c)
        .setName('同步空间')
        .setDesc('「同步空间」对应的云端目录,默认 /apps/sync。')
        .addText((t) => {
          t.setPlaceholder('/apps/sync').setValue(this.draft.syncDir);
          t.onChange((v) => {
            this.draft.syncDir = v;
          });
        });
    }
  }

  private authStatusEl!: HTMLElement;
  private authFlowEl!: HTMLElement;

  /** 设备码授权:发起 → 展示验证码 → 轮询(对话框关闭即停止) */
  private async startDeviceAuth(): Promise<void> {
    const appKey = this.draft.appKey.trim();
    const secretKey = this.draft.secretKey.trim();
    if (!appKey || !secretKey) {
      new Notice('请先填写 AppKey 与 SecretKey');
      return;
    }
    this.authStatusEl.textContent = '发起授权中…';
    let auth: BdDeviceAuth;
    try {
      auth = await bdStartDeviceAuth(appKey, secretKey);
    } catch (e) {
      this.authStatusEl.textContent = '发起失败';
      new Notice(String((e as Error)?.message || e), 6000);
      return;
    }
    this.draft.mode = 'official';
    const flow = this.authFlowEl;
    flow.empty();
    flow.createEl('p', { cls: 'setting-item-description', text: '请在打开的百度页面输入验证码并确认:' });
    flow.createDiv({ cls: 'lgp-bdpan__usercode', text: auth.userCode });
    const actions = flow.createDiv({ cls: 'lgp-bdpan__actions' });
    const openBtn = actions.createEl('button', { text: '打开授权页面' });
    const pollStatus = createSpan({ cls: 'lgp-bdpan__status', text: '等待确认…' });
    actions.appendChild(pollStatus);
    openBtn.addEventListener('click', () => window.open(auth.verificationUrl, '_blank'));
    window.open(auth.verificationUrl, '_blank');
    // 轮询:临时异常自动重试,仅致命错误才终止
    let interval = auth.interval * 1000;
    let failures = 0;
    const poll = async (): Promise<void> => {
      // 模态被关掉后 flow 已不在文档里
      if (!flow.isConnected) return;
      try {
        const result = await bdPollDeviceAuth(auth);
        failures = 0;
        if (result === 'done') {
          this.authStatusEl.textContent = '已授权(令牌自动续期)';
          this.draft.accessToken = getBaiduPanConfig().accessToken;
          pollStatus.setText('授权成功');
          await this.plugin.saveSettings();
          new Notice('百度网盘授权成功');
          void this.renderMountList();
          return;
        }
        if (result === 'slow') interval += 5000;
        pollStatus.setText(result === 'slow' ? '请求过快,自动放慢…' : '等待你在百度页面确认…');
      } catch (e) {
        if (e instanceof BdAuthTransientError && ++failures < 6) {
          pollStatus.setText((e as Error).message);
        } else {
          this.authStatusEl.textContent = '授权失败';
          pollStatus.setText(String((e as Error)?.message || e));
          new Notice(String((e as Error)?.message || e), 6000);
          return;
        }
      }
      this.pollTimer = setTimeout(() => void poll(), interval);
    };
    this.pollTimer = setTimeout(() => void poll(), interval);
  }

  /** 保存并验证:按当前接入方式写配置 → 查配额 */
  private async saveAndVerify(): Promise<void> {
    try {
      this.statusEl.textContent = '验证中…';
      if (this.curMode === 'official') {
        await saveBaiduPanConfig({
          mode: 'official',
          appKey: this.draft.appKey,
          secretKey: this.draft.secretKey,
        });
        if (!isBaiduConfigured()) {
          this.statusEl.textContent = '尚未授权';
          new Notice('请先点「获取授权」完成设备码授权', 4000);
          return;
        }
      } else {
        const bduss = this.draft.bduss.trim();
        if (!bduss) {
          this.statusEl.textContent = '请填写 BDUSS';
          new Notice('请填写 BDUSS');
          return;
        }
        await saveBaiduPanConfig({
          mode: 'cookie',
          bduss,
          stoken: this.draft.stoken,
          syncDir: this.draft.syncDir,
        });
      }
      await this.plugin.saveSettings();
      const q = await bdQuota();
      const fmt = (n: number): string => {
        if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
        if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
        return `${n} B`;
      };
      this.statusEl.textContent = `已连接:总 ${fmt(q.quota)},已用 ${fmt(q.used)}`;
      new Notice('百度网盘连接成功');
      await this.renderMountList();
    } catch (e) {
      this.statusEl.textContent = '连接失败';
      new Notice(String((e as Error)?.message || e), 6000);
    }
  }

  // ------------------------------------------------------------------
  // 挂载区
  // ------------------------------------------------------------------

  private renderMountSection(): void {
    const c = this.contentEl;
    c.createEl('h3', { text: '选择挂载目标' });
    this.crumbEl = c.createDiv({ cls: 'lgp-gitrepo__crumb' });
    this.listEl = c.createDiv({ cls: 'lgp-gitrepo__list' });
  }

  private crumbEl!: HTMLElement;
  private listEl!: HTMLElement;

  private pick(vPath: string, label: string): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.close();
    this.onPick?.({ vPath, label });
  }

  /** 快捷层 / 目录浏览层 */
  private async renderMountList(): Promise<void> {
    if (!this.onPick) return;
    const crumb = this.crumbEl;
    const list = this.listEl;
    crumb.empty();
    list.empty();
    if (!isBaiduConfigured()) {
      crumb.createSpan({ text: '选择挂载目标' });
      list.createDiv({ cls: 'setting-item-description', text: '请先在上方完成账号配置并验证通过' });
      return;
    }
    if (this.browseVPath === null) {
      // 快捷层:同步空间(cookie 模式)+ 浏览整个网盘
      crumb.createSpan({ text: '选择挂载目标' });
      if (this.curMode === 'cookie') {
        const row = list.createDiv({ cls: 'lgp-gitrepo__row' });
        row.createSpan({ cls: 'lgp-gitrepo__name', text: '同步空间' });
        const enter = row.createEl('button', { text: '浏览' });
        enter.addEventListener('click', () => {
          this.browseVPath = BDPAN_SYNC_ROOT;
          void this.renderMountList();
        });
        const pickBtn = row.createEl('button', { cls: 'mod-cta', text: '挂载' });
        pickBtn.addEventListener('click', () => this.pick(BDPAN_SYNC_ROOT, '同步空间'));
      } else {
        list.createDiv({
          cls: 'setting-item-description',
          text: '同步空间仅「网页 Cookie」模式支持(官方 API 无同步空间接口);未过审应用只能访问 /apps/<应用名>/ 目录。',
        });
      }
      const row = list.createDiv({ cls: 'lgp-gitrepo__row' });
      row.createSpan({ cls: 'lgp-gitrepo__name', text: '全部文件' });
      const enter = row.createEl('button', { text: '进入' });
      enter.addEventListener('click', () => {
        this.browseVPath = 'bdpan:///';
        void this.renderMountList();
      });
      return;
    }
    // 目录浏览层:列出子目录,可挂载/进入;顶部返回快捷层
    const label = baiduShortName(this.browseVPath);
    const back = crumb.createSpan({ cls: 'lgp-gitrepo__back', text: '‹ 返回' });
    back.addEventListener('click', () => {
      this.browseVPath = null;
      void this.renderMountList();
    });
    crumb.createSpan({ cls: 'lgp-gitrepo__cur', attr: { title: label }, text: label });
    const pickCur = crumb.createEl('button', { cls: 'mod-cta', text: '挂载当前目录' });
    pickCur.addEventListener('click', () => {
      this.pick(this.browseVPath!, label);
    });
    list.createDiv({ cls: 'setting-item-description', text: '加载中…' });
    try {
      const entries = await bdListDir(this.browseVPath);
      const dirs = entries.filter((e) => e.isDir);
      list.empty();
      if (dirs.length === 0) {
        list.createDiv({ cls: 'setting-item-description', text: '没有子文件夹' });
        return;
      }
      for (const e of dirs) {
        const row = list.createDiv({ cls: 'lgp-gitrepo__row' });
        row.createSpan({ cls: 'lgp-gitrepo__name', attr: { title: e.name }, text: e.name });
        const enter = row.createEl('button', { text: '进入' });
        enter.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.browseVPath = e.abs;
          void this.renderMountList();
        });
        const pickBtn = row.createEl('button', { cls: 'mod-cta', text: '挂载' });
        pickBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.pick(e.abs, e.name);
        });
        row.addEventListener('click', () => {
          this.browseVPath = e.abs;
          void this.renderMountList();
        });
      }
    } catch (err) {
      list.empty();
      list.createDiv({ cls: 'setting-item-description', text: `加载失败: ${String((err as Error)?.message || err)}` });
    }
  }
}
