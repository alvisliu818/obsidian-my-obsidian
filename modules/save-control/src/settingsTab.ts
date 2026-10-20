/**
 * 合并后的设置页。
 *
 * 五个开关在最上面（改完即时 applyToggles 让子系统启停）；其下按「自动保存 /
 * 版本历史 / 库外文件 / 外观」分组。上游两个插件各自的设置项都搬了进来，
 * 文案沿用 save-history 的 locale（中英俄西），新增项用中文。
 */

import { PluginSettingTab, Setting, TextComponent } from "obsidian";
import type { App } from "obsidian";
import type { SaveControlPlugin } from "./main";
import type { GroupByMode, Language, PreviewMode } from "./settings";
import { translate, setLanguage } from "./locale";
import {
  renameSnapshotFolder,
  renameExportFolder,
  renameTempVersionFolder,
} from "./storage";

export class SaveControlSettingTab extends PluginSettingTab {
  plugin: SaveControlPlugin;

  constructor(app: App, plugin: SaveControlPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("sh-settings-container");

    // ----------------------------------------------------------------
    // 开关
    // ----------------------------------------------------------------
    new Setting(containerEl).setName("开关").setHeading();

    const toggle = (name: string, desc: string, get: () => boolean, set: (v: boolean) => void): void => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) => {
          t.setValue(get());
          t.onChange((v) => {
            void (async () => {
              set(v);
              await this.plugin.saveSettings();
              await this.plugin.applyToggles();
              // 关掉版本历史时把侧栏视图收掉由宿主重启模块完成；这里只管运行态。
            })();
          });
        });
    };

    toggle(
      "自动保存",
      "编辑停止若干秒后自动落盘（含退出/关窗前的冲刷）。",
      () => this.plugin.settings.autosaveEnabled,
      (v) => (this.plugin.settings.autosaveEnabled = v),
    );
    toggle(
      "版本历史",
      "保存/定时快照文件版本，可在侧栏查看、恢复、对比与搜索。",
      () => this.plugin.settings.versionHistoryEnabled,
      (v) => (this.plugin.settings.versionHistoryEnabled = v),
    );
    toggle(
      "库外文件",
      "虚拟文档树挂载的文件同样支持自动保存与版本历史（快照存到插件目录或下方指定的位置）。",
      () => this.plugin.settings.externalFilesEnabled,
      (v) => (this.plugin.settings.externalFilesEnabled = v),
    );
    toggle(
      "状态栏待保存指示",
      "底部状态栏显示待保存数量（悬停列出文件名）。",
      () => this.plugin.settings.statusIndicatorEnabled,
      (v) => (this.plugin.settings.statusIndicatorEnabled = v),
    );
    toggle(
      "关闭标签页前提示未保存",
      "有关未保存更改的标签页时，询问：保存并关闭 / 不保存并关闭 / 取消。",
      () => this.plugin.settings.promptUnsavedOnClose,
      (v) => (this.plugin.settings.promptUnsavedOnClose = v),
    );

    // ----------------------------------------------------------------
    // 自动保存
    // ----------------------------------------------------------------
    new Setting(containerEl).setName(translate("settingsTitle")).setHeading();

    // 语言
    new Setting(containerEl)
      .setName(translate("language"))
      .setDesc(translate("languageDesc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("system", translate("langSystem"));
        dropdown.addOption("en", "English");
        dropdown.addOption("ru", "\u0420\u0443\u0441\u0441\u043a\u0438\u0439");
        dropdown.addOption("es", "Espa\u00f1ol");
        dropdown.setValue(this.plugin.settings.language);
        dropdown.onChange((val) => {
          void (async () => {
            const lang = val as Language;
            this.plugin.settings.language = lang;
            setLanguage(lang);
            await this.plugin.saveSettings();
            this.plugin.refreshCommands();
            this.display();
          })();
        });
      });

    const seconds = (name: string, desc: string, get: () => number, set: (v: number) => void, min = 1, max = 3600): void => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.min = String(min);
          text.inputEl.max = String(max);
          text.setValue(String(get()));
          text.onChange((v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n >= min && n <= max) set(n);
          });
          text.inputEl.addEventListener("blur", () => {
            void this.plugin.saveSettings();
            this.display();
          });
        });
    };

    seconds(
      "落盘延迟（秒）",
      "编辑停止多少秒后才真正写盘（0-2s 会接近每次按键都写）。",
      () => this.plugin.settings.saveDelaySeconds,
      (v) => (this.plugin.settings.saveDelaySeconds = v),
      1,
      600,
    );
    seconds(
      "自动保存间隔（分钟）",
      "每隔多少分钟给当前文件记一个 autosave 版本；0 = 关闭。按文件覆盖见版本历史侧栏。",
      () => this.plugin.settings.autosaveInterval,
      (v) => (this.plugin.settings.autosaveInterval = v),
      0,
      720,
    );
    seconds(
      "关标签页自动保存版本",
      "开 = 切走/关闭标签页时给该文件记一个 autosave 版本。",
      () => (this.plugin.settings.autosaveOnTabClose ? 1 : 0),
      (v) => (this.plugin.settings.autosaveOnTabClose = v === 1),
      0,
      1,
    );
    seconds(
      "autosave 版本保留数",
      "每个文件最多保留多少个 autosave 版本（0 = 不限制）。",
      () => this.plugin.settings.maxAutosaveVersions,
      (v) => (this.plugin.settings.maxAutosaveVersions = v),
      0,
      500,
    );

    // ----------------------------------------------------------------
    // 工作区布局（workspace.json）写盘时机
    // ----------------------------------------------------------------
    new Setting(containerEl).setName("工作区布局写盘").setHeading();

    toggle(
      "延迟写入 workspace.json",
      "布局变动（开/关标签页、拖分栏等）不立即写 workspace.json，先缓冲再写，减少磁盘写入与网盘同步抖动。",
      () => this.plugin.settings.deferWorkspaceLayoutSaves,
      (v) => (this.plugin.settings.deferWorkspaceLayoutSaves = v),
    );
    seconds(
      "缓冲多久后写（秒）",
      "「延迟写入 workspace.json」打开时，缓冲多少秒后才真正写盘。",
      () => this.plugin.settings.workspaceLayoutSaveDelaySeconds,
      (v) => (this.plugin.settings.workspaceLayoutSaveDelaySeconds = v),
      1,
      3600,
    );
    toggle(
      "直到关闭 Obsidian 才写入",
      "更激进：workspace.json 全程只在内存里缓冲，关闭 Obsidian 时才真正写盘（忽略上面的秒数）。注意：进程被强杀（崩溃、任务管理器结束）会丢失最后一次布局改动。",
      () => this.plugin.settings.deferWorkspaceLayoutUntilQuit,
      (v) => (this.plugin.settings.deferWorkspaceLayoutUntilQuit = v),
    );

    new Setting(containerEl)
      .setName("允许的扩展名")
      .setDesc("md 之外也要做版本历史的扩展名，逗号分隔（如 txt,md,toml）。库外文件同样按此过滤。")
      .addText((text) => {
        text.setValue(this.plugin.settings.allowedExtensions);
        text.onChange((v) => {
          this.plugin.settings.allowedExtensions = v;
          void this.plugin.saveSettings();
        });
      });

    // ----------------------------------------------------------------
    // 版本历史
    // ----------------------------------------------------------------
    new Setting(containerEl).setName("版本历史").setHeading();

    toggle(
      "写盘自动存版本",
      "任意文本文件写入磁盘时自动留一个版本副本（与下方的定时 autosave 互补：那个按时间取样，这个按每次写盘取样）。",
      () => this.plugin.settings.versionOnWriteEnabled,
      (v) => (this.plugin.settings.versionOnWriteEnabled = v),
    );

    new Setting(containerEl)
      .setName("写盘版本保留数")
      .setDesc("每个文件最多保留多少个「写盘」版本（1-50）。超出后删最旧的（收藏的不删）。只滚转「写盘」本身，不动手动/定时版本。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "50";
        text.setValue(String(this.plugin.settings.maxOnWriteVersions));
        text.onChange((v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1 && n <= 50) {
            this.plugin.settings.maxOnWriteVersions = Math.trunc(n);
            void this.plugin.saveSettings();
          }
        });
        text.inputEl.addEventListener("blur", () => {
          void this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName(translate("groupVersionsBy"))
      .setDesc(translate("groupVersionsDesc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("none", translate("groupNone"));
        dropdown.addOption("day", translate("groupDay"));
        dropdown.addOption("week", translate("groupWeek"));
        dropdown.addOption("month", translate("groupMonth"));
        dropdown.addOption("year", translate("groupYear"));
        dropdown.setValue(this.plugin.settings.groupBy);
        dropdown.onChange((val) => {
          void (async () => {
            this.plugin.settings.groupBy = val as GroupByMode;
            await this.plugin.saveSettings();
          })();
        });
      });

    const folderField = (
      name: string,
      desc: string,
      get: () => string,
      set: (v: string) => void,
      rename?: (oldName: string, newName: string) => Promise<boolean>,
    ): Setting => {
      const s = new Setting(containerEl).setName(name).setDesc(desc);
      let text: TextComponent;
      s.addText((t) => {
        text = t;
        t.setValue(get());
        t.inputEl.addClass("sh-settings-input");
      });
      if (rename) {
        s.addButton((btn) => {
          btn.setButtonText(translate("save"));
          btn.onClick(() => {
            void (async () => {
              const newName = text.getValue().trim();
              const oldName = get();
              if (!newName || newName === oldName) return;
              if (/[<>:"|?*]/.test(newName) || newName.startsWith("/") || newName.endsWith("/") || newName.includes("..")) {
                this.plugin.toast("名称无效。");
                return;
              }
              const ok = await rename(oldName, newName);
              if (ok) {
                set(newName);
                await this.plugin.saveSettings();
                this.plugin.toast("已重命名并迁移现有快照。");
              } else {
                this.plugin.toast("重命名失败。");
              }
            })();
          });
        });
      } else {
        s.addExtraButton((b) => {
          b.setIcon("save").setTooltip("保存");
          b.onClick(() => {
            void (async () => {
              set(text.getValue().trim());
              await this.plugin.saveSettings();
              this.plugin.toast("已保存。");
            })();
          });
        });
      }
      return s;
    };

    folderField(
      translate("snapshotFolder"),
      translate("snapshotFolderDesc"),
      () => this.plugin.settings.snapshotFolder,
      (v) => (this.plugin.settings.snapshotFolder = v),
      (o, n) => renameSnapshotFolder(this.plugin.app.vault.adapter, o, n),
    );
    folderField(
      translate("exportFolder"),
      translate("exportFolderDesc"),
      () => this.plugin.settings.exportFolder,
      (v) => (this.plugin.settings.exportFolder = v),
      (o, n) => renameExportFolder(this.plugin.app.vault.adapter, o, n),
    );
    folderField(
      translate("tempVersionFolder"),
      translate("tempVersionFolderDesc"),
      () => this.plugin.settings.tempVersionFolder,
      (v) => (this.plugin.settings.tempVersionFolder = v),
      (o, n) => renameTempVersionFolder(this.plugin.app.vault.adapter, o, n),
    );

    new Setting(containerEl)
      .setName(translate("previewMode"))
      .setDesc(translate("previewModeDesc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("modal", translate("previewModeModal"));
        dropdown.addOption("tab", translate("previewModeTab"));
        dropdown.setValue(this.plugin.settings.previewMode);
        dropdown.onChange((val) => {
          void (async () => {
            this.plugin.settings.previewMode = val as PreviewMode;
            await this.plugin.saveSettings();
            if (val === "modal") {
              await this.plugin.cleanupAllTempFiles();
            }
          })();
        });
      });

    // ----------------------------------------------------------------
    // 库外文件
    // ----------------------------------------------------------------
    new Setting(containerEl).setName("库外文件").setHeading();

    const extSetting = new Setting(containerEl)
      .setName("库外快照目录")
      .setDesc("库外文件的版本快照存放位置。留空 = 插件目录下的 save-control-snapshots；绝对路径按原样用；相对路径相对库根。改动只影响之后的新快照。");
    let extText: TextComponent;
    extSetting.addText((t) => {
      extText = t;
      t.setValue(this.plugin.settings.externalSnapshotFolder);
      t.inputEl.addClass("sh-settings-input");
    });
    extSetting.addExtraButton((b) => {
      b.setIcon("save").setTooltip("保存");
      b.onClick(() => {
        void (async () => {
          this.plugin.settings.externalSnapshotFolder = extText.getValue().trim();
          await this.plugin.saveSettings();
          this.plugin.toast("已保存（现有快照不搬动）。");
        })();
      });
    });

    // ----------------------------------------------------------------
    // 外观
    // ----------------------------------------------------------------
    new Setting(containerEl).setName("外观").setHeading();

    new Setting(containerEl)
      .setName("已保存颜色")
      .addText((t) => {
        t.setValue(this.plugin.settings.savedStatusColor);
        t.onChange((v) => {
          this.plugin.settings.savedStatusColor = v;
          void this.plugin.saveSettings();
          this.plugin.applyStatusColors();
        });
      });
    new Setting(containerEl)
      .setName("待保存颜色")
      .addText((t) => {
        t.setValue(this.plugin.settings.pendingStatusColor);
        t.onChange((v) => {
          this.plugin.settings.pendingStatusColor = v;
          void this.plugin.saveSettings();
          this.plugin.applyStatusColors();
        });
      });
    new Setting(containerEl)
      .setName("状态栏图标大小（px）")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(this.plugin.settings.statusIconSizePx));
        t.onChange((v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 8 && n <= 40) {
            this.plugin.settings.statusIconSizePx = n;
            void this.plugin.saveSettings();
            this.plugin.applyStatusIconSize();
          }
        });
      });
  }
}
