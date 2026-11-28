/* eslint-disable @typescript-eslint/no-explicit-any */
import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import { SEARCH_ENGINES } from "../constants";
import type { BrowserSettings, ExtensionRecord } from "../types";
import type { UserscriptHost } from "../userscripts/userscriptHost";
import type { ExtensionHost } from "../extensions/extensionHost";
import { pickFolder } from "../utils/electron";

export interface SettingsHost {
  settings: BrowserSettings;
  save(): void;
  /** 代理相关设置变更后重放到会话。 */
  applyProxy(): void;
  /** DNR/Edge UA 网络钩子重放（设置变更/扩展装卸后）。 */
  applyNetFilters(): void;
  extHost: ExtensionHost;
  extensions(): ExtensionRecord[];
  refreshExtensionIcons(): void;
  clearHistory(): void;
  usHost(): UserscriptHost;
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

    new Setting(containerEl).setName("网络代理").setHeading();

    new Setting(containerEl)
      .setName("代理模式")
      .setDesc("自定义 = 按下方规则走代理；系统 = 跟随系统代理；直连 = 不用代理")
      .addDropdown((d) =>
        d
          .addOptions({ off: "直连", system: "系统代理", fixed: "自定义代理" })
          .setValue(s.proxyMode)
          .onChange((v) => {
            s.proxyMode = v as BrowserSettings["proxyMode"];
            this.host.save();
            this.host.applyProxy();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("代理规则")
      .setDesc(
        "Electron rules 语法：http=127.0.0.1:7890;https=socks5://127.0.0.1:7890；单个地址(127.0.0.1:7890)对全部协议生效",
      )
      .addText((t) =>
        t.setValue(s.proxyRules).onChange((v) => {
          s.proxyRules = v.trim();
          this.host.save();
          this.host.applyProxy();
        }),
      )
      .setDisabled(s.proxyMode !== "fixed");

    new Setting(containerEl)
      .setName("代理作用域")
      .setDesc(
        "应用 = 同时代理 Obsidian 本体流量(插件安装/更新、社区市场走默认会话)；浏览器 = 仅内置浏览器",
      )
      .addDropdown((d) =>
        d
          .addOptions({ browser: "仅浏览器", app: "浏览器 + Obsidian 应用" })
          .setValue(s.proxyScope)
          .onChange((v) => {
            s.proxyScope = v as BrowserSettings["proxyScope"];
            this.host.save();
            this.host.applyProxy();
          }),
      );

    new Setting(containerEl)
      .setName("绕过列表")
      .setDesc("不走代理的地址，分号分隔：localhost;127.0.0.1;<local>")
      .addText((t) =>
        t.setValue(s.proxyBypass).onChange((v) => {
          s.proxyBypass = v.trim();
          this.host.save();
          this.host.applyProxy();
        }),
      )
      .setDisabled(s.proxyMode !== "fixed");

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

    new Setting(containerEl)
      .setName("标签页模式")
      .setDesc(
        "插件内页签条：所有页面在一个 Obsidian 标签里，页签条由插件绘制。" +
          "Obsidian 原生标签页：每个页面占一个 Obsidian 标签，可拖到分栏、用 Ctrl+W 关闭、随工作区恢复。切换后请重新打开浏览器视图",
      )
      .addDropdown((d) => {
        d.addOption("internal", "插件内页签条");
        d.addOption("native", "Obsidian 原生标签页");
        d.setValue(s.tabMode).onChange((v) => {
          s.tabMode = v as BrowserSettings["tabMode"];
          this.host.save();
        });
      });

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

    new Setting(containerEl).setName("网页标注").setHeading();

    new Setting(containerEl)
      .setName("标注保存目录")
      .setDesc("每个网页一个 Markdown 笔记，按域名分文件夹")
      .addText((t) =>
        t.setValue(s.annotationsFolder).onChange((v) => {
          s.annotationsFolder = v.trim();
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("选区气泡显示取消按钮")
      .setDesc("取消高亮/取消小字只影响显示，标注数据保留")
      .addToggle((t) =>
        t.setValue(s.showAnnRemove !== false).onChange((v) => {
          s.showAnnRemove = v;
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("选中文字显示标注气泡")
      .setDesc("关闭后选中文字不再弹泡，可用工具栏 ✎ 或页面右键标注")
      .addToggle((t) =>
        t.setValue(s.showAnnBubble !== false).onChange((v) => {
          s.showAnnBubble = v;
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("悬停/点击高亮弹出悬浮窗")
      .addToggle((t) =>
        t.setValue(s.showAnnFloat !== false).onChange((v) => {
          s.showAnnFloat = v;
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("显示标注小字")
      .setDesc("高亮旁显示批注摘要，可随时切换")
      .addToggle((t) =>
        t.setValue(s.showAnnInline).onChange((v) => {
          s.showAnnInline = v;
          this.host.save();
        }),
      );

    new Setting(containerEl).setName("摘录预处理（思源同款）").setHeading();
    const expToggles: [keyof BrowserSettings & string, string][] = [
      ["clipExpBold", "粗体转为 <b> 标签"],
      ["clipExpItalic", "斜体转为 <i> 标签"],
      ["clipExpUnderline", "下划线转为 <u> 标签"],
      ["clipExpRemoveImgLink", "移除图片外层链接"],
      ["clipExpSpanBr", "span 换行转 <br>"],
      ["clipExpSvgToImg", "内嵌 SVG 转图片"],
    ];
    for (const [key, label] of expToggles) {
      new Setting(containerEl).setName(label).addToggle((t) =>
        t.setValue(s[key] === true).onChange((v) => {
          (s as unknown as Record<string, unknown>)[key] = v;
          this.host.save();
        }),
      );
    }

    this.renderExtensions();
  }

  private renderExtensions(): void {
    const { containerEl } = this;
    const s = this.host.settings;
    /** 目录输入框暂存：点「应用并迁移」才写回设置（换根要搬目录 + 重载扩展）。 */
    let dirInput: HTMLInputElement | null = null;

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
      .setName("扩展数据目录")
      .setDesc(
        "留空 = 库内 .obsidian/plugins/obsidian-browser/extensions。改到库外可避免扩展体积进同步盘；" +
          "「应用并迁移」会把已装扩展搬过去，并按 CRX 公钥固定扩展 ID（暴力猴脚本不丢）",
      )
      .addText((t) => {
        dirInput = t.inputEl;
        t.setPlaceholder(".obsidian/plugins/obsidian-browser/extensions")
          .setValue(s.extensionsDir || "")
          .onChange(() => {
            /* 输入过程中不换根：点「应用并迁移」才生效（换根要搬目录 + 重载扩展） */
          });
      })
      .addButton((b) =>
        b.setButtonText("选择文件夹…").onClick(async () => {
          const p = await pickFolder("选择扩展数据目录", s.extensionsDir || this.host.extHost.extensionsRoot());
          if (p && dirInput) dirInput.value = p;
        }),
      )
      .addButton((b) =>
        b.setButtonText("应用并迁移").onClick(async () => {
          const target = String(dirInput?.value || "").trim();
          const r = await this.host.extHost.migrateExtensionsDir(target);
          if (!r.ok) {
            new Notice("迁移失败：" + (r.error || "未知错误"), 6000);
            return;
          }
          s.extensionsDir = target;
          this.host.save();
          this.display();
          new Notice(r.moved ? `已迁移 ${r.moved} 项扩展数据` : "目录已是目标位置，无需迁移");
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

    this.renderUserscripts(containerEl);

    const list = containerEl.createDiv({ cls: "ob-ext-list" });
    for (const rec of this.host.extensions()) {
      new Setting(list)
        .setName(`${rec.name} ${rec.version}`)
        .setDesc((rec.description || rec.dir) + (rec.nativeId ? "（已原生装载）" : ""))
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

    const ntab = this.host.extHost.newtabExtensions();
    if (ntab.length) {
      new Setting(containerEl)
        .setName("新标签页扩展")
        .setDesc("用扩展自带的新标签页作为新建标签页/主页")
        .addDropdown((d) => {
          const opts: Record<string, string> = { "": "关闭（使用主页）" };
          for (const x of ntab) opts[x.id] = x.name;
          d.addOptions(opts).setValue(s.newTabExtId || "").onChange((v) => {
            s.newTabExtId = v;
            this.host.save();
          });
        });
    }

    new Setting(containerEl)
      .setName("DNR 网络层广告过滤")
      .setDesc("解析已装 AdGuard 扩展的 declarativeNetRequest 规则集做真网络拦截（元素隐藏过滤之外）")
      .addToggle((t) =>
        t.setValue(s.dnrEnabled).onChange((v) => {
          s.dnrEnabled = v;
          this.host.save();
          this.host.applyNetFilters();
        }),
      );
  }

  private renderUserscripts(containerEl: HTMLElement): void {
    const s = this.host.settings;
    new Setting(containerEl).setName("用户脚本").setHeading();

    new Setting(containerEl)
      .setName("自动修复脚本匹配模式")
      .setDesc(
        "部分油猴脚本使用非法的 @match 通配符（如 *://**/*），新版 Chromium 会判定扩展越权并直接终止页面进程。" +
          "开启后在注册到脚本管理器时自动替换为合法写法（*://*/*）并提醒；即时生效。",
      )
      .addToggle((t) =>
        t.setValue(s.autoFixScriptMatch !== false).onChange((v) => {
          s.autoFixScriptMatch = v;
          this.host.save();
        }),
      );

    new Setting(containerEl)
      .setName("从 URL 安装")
      .setDesc("粘贴 .user.js 地址（GreasyFork / GitHub raw 等），原生安装，无需暴力猴")
      .addButton((b) =>
        b.setButtonText("安装").onClick(() => {
          new UrlUserScriptModal(this.app, this.host.usHost()).open();
        }),
      );

    const scripts = this.host.usHost().list();
    if (!scripts.length) {
      containerEl.createDiv({ cls: "ob-ext-list", text: "（还没有安装用户脚本——在浏览器里点开 .user.js 链接即可安装）" });
      return;
    }
    const list = containerEl.createDiv({ cls: "ob-ext-list" });
    for (const rec of scripts) {
      new Setting(list)
        .setName(`${rec.name} ${rec.version}`)
        .setDesc((rec.description || rec.sourceUrl || rec.id) + (rec.runAt === "document_start" ? "（document_start）" : ""))
        .addToggle((t) =>
          t.setValue(rec.enabled).onChange((v) => {
            this.host.usHost().setEnabled(rec.id, v);
          }),
        )
        .addButton((b) =>
          b
            .setButtonText("删除")
            .setWarning()
            .onClick(() => {
              this.host.usHost().remove(rec.id);
              this.display();
            }),
        );
    }
  }
}

/** 从 URL 安装用户脚本。 */
class UrlUserScriptModal extends Modal {
  private input = "";

  constructor(
    app: App,
    private usHost: UserscriptHost,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "从 URL 安装用户脚本" });
    new Setting(contentEl).setName("脚本地址").addText((t) =>
      t.setPlaceholder("https://…/script.user.js").onChange((v) => (this.input = v.trim())),
    );
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("安装")
        .setCta()
        .onClick(async () => {
          if (!this.input) return;
          try {
            const rec = await this.usHost.installFromUrl(this.input);
            new Notice(`已安装用户脚本：${rec.name}`);
            this.close();
          } catch (e) {
            new Notice("安装失败：" + String((e as Error)?.message ?? e));
          }
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
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
