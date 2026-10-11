/* eslint-disable @typescript-eslint/no-explicit-any */
import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import { SEARCH_ENGINES } from "../constants";
import type { BrowserSettings, ExtensionRecord } from "../types";
import type { ExtensionHost } from "../extensions/extensionHost";

export interface SettingsHost {
  settings: BrowserSettings;
  save(): void;
  extHost: ExtensionHost;
  extensions(): ExtensionRecord[];
  refreshExtensionIcons(): void;
  clearHistory(): void;
}

export class BrowserSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: unknown,
    private host: SettingsHost,
  ) {
    super(app, plugin as never);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.host.settings;

    new Setting(containerEl).setName("浏览器").setHeading();

    new Setting(containerEl)
      .setName("主页")
      .setDesc("点击主页按钮、以及新建标签页时打开的网址")
      .addText((t) =>
        t.setValue(s.homePage).onChange((v) => {
          s.homePage = v.trim();
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("默认搜索引擎")
      .setDesc("地址栏输入非网址内容时使用")
      .addDropdown((d) => {
        for (const e of SEARCH_ENGINES) d.addOption(e.id, e.name);
        d.addOption("custom", "自定义");
        d.setValue(s.searchEngine).onChange((v) => {
          s.searchEngine = v as BrowserSettings["searchEngine"];
          this.host.save();
          this.display();
        });
      });

    if (s.searchEngine === "custom") {
      new Setting(containerEl)
        .setName("自定义搜索地址")
        .setDesc("用 {q} 表示搜索词，例如 https://www.zhihu.com/search?q={q}")
        .addText((t) =>
          t.setValue(s.customSearchUrl).onChange((v) => {
            s.customSearchUrl = v.trim();
            this.host.save();
          }),
        );
    }

    new Setting(containerEl)
      .setName("User-Agent")
      .setDesc("留空使用 Electron 默认 UA。修改后在新页面生效")
      .addText((t) =>
        t.setValue(s.userAgent).onChange((v) => {
          s.userAgent = v.trim();
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("会话分区")
      .setDesc("同一分区共享 Cookie 与登录状态；改成新值等于全新的登录态")
      .addText((t) =>
        t.setValue(s.partition).onChange((v) => {
          s.partition = v.trim() || "persist:obsidian-browser";
          this.host.save();
        }),
      );

    new Setting(containerEl).setName("历史与隐私").setHeading();

    new Setting(containerEl)
      .setName("记录浏览历史")
      .addToggle((t) =>
        t.setValue(s.recordHistory).onChange((v) => {
          s.recordHistory = v;
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("历史条数上限")
      .setDesc("超过上限后自动丢弃最早的记录")
      .addText((t) =>
        t
          .setValue(String(s.historyLimit))
          .onChange((v) => {
            const n = Number(v);
            s.historyLimit = Number.isFinite(n) && n >= 0 ? Math.floor(n) : s.historyLimit;
            this.host.save();
          }),
      );

    new Setting(containerEl)
      .setName("恢复上次打开的标签页")
      .setDesc("关闭 Obsidian 时保存标签页，下次打开浏览器视图时恢复")
      .addToggle((t) =>
        t.setValue(s.restoreSession).onChange((v) => {
          s.restoreSession = v;
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("清空浏览历史")
      .addButton((b) =>
        b.setButtonText("清空").onClick(() => {
          this.host.clearHistory();
          new Notice("浏览历史已清空");
        }),
      );

    new Setting(containerEl).setName("链接处理").setHeading();

    new Setting(containerEl)
      .setName("在插件内打开 Obsidian 中的链接")
      .setDesc("点击笔记里的 http(s) 链接时，用本插件打开而不是系统浏览器")
      .addToggle((t) =>
        t.setValue(s.interceptAllLinks).onChange((v) => {
          s.interceptAllLinks = v;
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("排除站点")
      .setDesc("每行一个域名，这些站点始终用系统浏览器打开。支持 *.example.com 只匹配子域")
      .addTextArea((t) =>
        t.setValue(s.excludedSites).onChange((v) => {
          s.excludedSites = v;
          this.host.save();
        }),
      );

    new Setting(containerEl).setName("广告过滤").setHeading();

    new Setting(containerEl)
      .setName("启用元素隐藏过滤")
      .setDesc("按 Adblock 规则隐藏广告元素（渲染进程无法做网络拦截）")
      .addToggle((t) =>
        t.setValue(s.adBlockEnabled).onChange((v) => {
          s.adBlockEnabled = v;
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("自定义过滤规则")
      .setDesc("每行一条，格式：example.com##选择器；例外用 #@#")
      .addTextArea((t) =>
        t.setValue(s.adBlockRules).onChange((v) => {
          s.adBlockRules = v;
          this.host.save();
        }),
      );

    new Setting(containerEl).setName("下载与摘录").setHeading();

    new Setting(containerEl)
      .setName("下载目录")
      .setDesc("仓库内的相对路径")
      .addText((t) =>
        t.setValue(s.downloadDir).onChange((v) => {
          s.downloadDir = v.trim();
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("摘录保存目录")
      .addText((t) =>
        t.setValue(s.clipFolder).onChange((v) => {
          s.clipFolder = v.trim();
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("摘录时下载图片到仓库")
      .addToggle((t) =>
        t.setValue(s.clipAssets).onChange((v) => {
          s.clipAssets = v;
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("包含 Frontmatter")
      .addToggle((t) =>
        t.setValue(s.clipFrontmatter).onChange((v) => {
          s.clipFrontmatter = v;
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("摘录标签")
      .setDesc("空格或逗号分隔，写入 frontmatter 的 tags")
      .addText((t) =>
        t.setValue(s.clipTags).onChange((v) => {
          s.clipTags = v;
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("摘录模板")
      .setDesc("可用变量：${title} ${url} ${byline} ${siteName} ${excerpt} ${date} ${time} ${tags} ${content}")
      .addTextArea((t) => {
        t.setValue(s.clipTemplate).onChange((v) => {
          s.clipTemplate = v;
          this.host.save();
        });
        t.inputEl.rows = 12;
      });

    new Setting(containerEl)
      .setName("摘录同时复制到剪贴板")
      .addToggle((t) =>
        t.setValue(s.clipAlsoCopy).onChange((v) => {
          s.clipAlsoCopy = v;
          this.host.save();
        }),
      );

    this.renderExtensions();
  }

  private renderExtensions(): void {
    const { containerEl } = this;
    const s = this.host.settings;

    new Setting(containerEl).setName("Chrome 扩展").setHeading();

    new Setting(containerEl)
      .setName("启用扩展")
      .setDesc("内容脚本与 popup 可用；background / service worker 不执行")
      .addToggle((t) =>
        t.setValue(s.extensionsEnabled).onChange((v) => {
          s.extensionsEnabled = v;
          this.host.save();
          this.host.refreshExtensionIcons();
        }),
      );

    new Setting(containerEl)
      .setName("安装扩展")
      .setDesc("支持 CRX / ZIP 包、已解压的扩展目录，或直接填 CRX 下载地址")
      .addButton((b) =>
        b.setButtonText("选择文件 / 目录").onClick(() => {
          new InstallExtensionModal(this.app, this.host).open();
        }),
      )
      .addButton((b) =>
        b.setButtonText("从 URL 安装").onClick(() => {
          new UrlInstallModal(this.app, this.host).open();
        }),
      );

    const list = containerEl.createDiv({ cls: "ob-ext-list" });
    for (const rec of this.host.extensions()) {
      new Setting(list)
        .setName(`${rec.name} ${rec.version}`)
        .setDesc(rec.description || rec.dir)
        .addToggle((t) =>
          t.setValue(rec.enabled).onChange((v) => {
            this.host.extHost.setEnabled(rec.id, v);
            this.host.refreshExtensionIcons();
          }),
        )
        .addButton((b) =>
          b
            .setButtonText("删除")
            .setWarning()
            .onClick(() => {
              this.host.extHost.remove(rec.id);
              this.display();
            }),
        );
    }
  }
}

/** File / directory picker. Obsidian's own DOM helpers wrap the input element. */
class InstallExtensionModal extends Modal {
  constructor(
    app: App,
    private host: SettingsHost,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "安装扩展" });
    contentEl.createDiv({
      text: "选择 CRX / ZIP 包，或选择已解压扩展的目录（目录内需含 manifest.json）",
      cls: "ob-modal-hint",
    });

    const archive = contentEl.createEl("input", { type: "file" });
    archive.accept = ".crx,.zip";
    archive.addEventListener("change", () => {
      const file = archive.files?.[0];
      if (!file) return;
      void file
        .arrayBuffer()
        .then((buf) => this.host.extHost.installFromArchive(buf, file.name))
        .then((rec) => {
          new Notice(`已安装扩展：${rec.name}`);
          this.close();
        })
        .catch((e) => new Notice("安装失败：" + String(e?.message ?? e)));
    });

    const dir = contentEl.createEl("input", { type: "file" });
    dir.setAttribute("webkitdirectory", "");
    dir.setAttribute("directory", "");
    dir.style.marginTop = "8px";
    dir.addEventListener("change", () => {
      const files = Array.from(dir.files ?? []);
      if (!files.length) return;
      const root = files[0].webkitRelativePath.split("/")[0];
      void Promise.all(
        files.map(async (f) => ({
          path: f.webkitRelativePath.slice(root.length + 1),
          data: await f.arrayBuffer(),
        })),
      )
        .then((entries) => this.host.extHost.installFromFiles(entries))
        .then((rec) => {
          new Notice(`已安装扩展：${rec.name}`);
          this.close();
        })
        .catch((e) => new Notice("安装失败：" + String(e?.message ?? e)));
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class UrlInstallModal extends Modal {
  constructor(
    app: App,
    private host: SettingsHost,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "从 URL 安装扩展" });
    contentEl.createDiv({
      text: "填入 CRX 文件的直接下载地址（浏览器扩展商店页面本身不是 CRX）",
      cls: "ob-modal-hint",
    });
    let url = "";
    new Setting(contentEl).setName("CRX 地址").addText((t) =>
      t.onChange((v) => {
        url = v.trim();
      }),
    );
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("下载并安装")
        .setCta()
        .onClick(async () => {
          if (!url) return;
          try {
            const rec = await this.host.extHost.installFromUrl(url);
            new Notice(`已安装扩展：${rec.name}`);
            this.close();
          } catch (e: any) {
            new Notice("安装失败：" + String(e?.message ?? e));
          }
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
