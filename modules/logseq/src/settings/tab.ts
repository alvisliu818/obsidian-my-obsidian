import { PluginSettingTab, Setting, Notice, type App } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { SqliteConsoleModal } from '../features/sqliteConsole';
import { ExtensionMarketModal } from '../extensions/marketModal';
import { getLoadedThemes } from '../extensions/themeLoader';
import { getLoadedIconThemes, activateIconThemeByPreference } from '../extensions/iconThemeLoader';
import { applyCodeThemePreference } from '../editor/monaco';
import { MountListModal } from '../panels/mountModals';
import { VIEW_TYPE_MOUNT_PANEL } from '../panels/mountPanel';
import { VIEW_TYPE_CONTENT_SEARCH } from '../panels/contentSearchPanel';
import { OpenWithEditModal } from '../features/openWithUi';
import { mountDisplayName, type LspServerSpec, type PagePropsEditor, type ScopeMode, type ShortcutOverrides } from '../types';
import { effectiveLspServers } from '../lsp/serverSpecs';
import { LspServerEditModal } from './lspServerModal';
import { renderEditorSettingsRows } from './editorSettingsUI';
import { SHORTCUT_GROUP_LABELS } from '../types';

export class LogseqEditorSettingTab extends PluginSettingTab {
  plugin: LogseqEditorPlugin;

  constructor(app: App, plugin: LogseqEditorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * The master dropdown's value: 'all' when every group is on, 'none' when
   * every group is off, 'custom' for any mix in between.
   */
  private shortcutPresetValue(): 'all' | 'none' | 'custom' {
    const s = this.plugin.settings.shortcuts;
    const values = Object.values(s);
    if (values.every(Boolean)) return 'all';
    if (values.every((v) => !v)) return 'none';
    return 'custom';
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // Obsidian 原生平铺布局:各分节拆成独立方法(按早期 h3 小节边界),这里
    // 顺序铺 h3 标题 + 调 builder。设置项多的插件同款做法。
    this.renderBlocksSection(containerEl);
    containerEl.createEl('h3', { text: '扩展市场' });
    this.renderMarketSection(containerEl);
    containerEl.createEl('h3', { text: 'LSP 语言服务器' });
    this.renderLspSection(containerEl);
    containerEl.createEl('h3', { text: '快捷键' });
    this.renderHotkeysSection(containerEl);
    containerEl.createEl('h3', { text: '安全（备份与日志）' });
    this.renderSafetySection(containerEl);
    containerEl.createEl('h3', { text: '日记（每日笔记）' });
    this.renderJournalSection(containerEl);
    containerEl.createEl('h3', { text: '外部挂载' });
    this.renderMountsSection(containerEl);
    containerEl.createEl('h3', { text: '查看器与搜索' });
    this.renderViewersSection(containerEl);
    containerEl.createEl('h3', { text: '模板' });
    this.renderTemplatesSection(containerEl);
    containerEl.createEl('h3', { text: 'SQLite 二级索引' });
    this.renderSqliteSection(containerEl);
    containerEl.createEl('h3', { text: '代码运行' });
    this.renderCodeRunSection(containerEl);
    containerEl.createEl('h3', { text: '代码编辑器' });
    this.renderEditorSettingsSection(containerEl);
  }

  private renderBlocksSection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('接管 Markdown 文件')
      .setDesc('默认用 Logseq 式块编辑器打开所有 .md 文件。单个文件随时可以切回原生编辑器。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.takeOverByDefault).onChange(async (v) => {
          this.plugin.settings.takeOverByDefault = v;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (this.plugin.settings.takeOverByDefault) {
      new Setting(containerEl)
        .setName('接管范围')
        .setDesc('哪些文件默认用块编辑器打开：全部 Markdown 文件，或仅限下面列出的文件夹。')
        .addDropdown((d) =>
          d
            .addOptions({ all: '全部文件（排除项除外）', folders: '仅指定文件夹' })
            .setValue(this.plugin.settings.scopeMode)
            .onChange(async (v) => {
              this.plugin.settings.scopeMode = v as ScopeMode;
              await this.plugin.saveSettings();
              this.display();
            }),
        );
    }

    if (this.plugin.settings.takeOverByDefault && this.plugin.settings.scopeMode === 'folders') {
      new Setting(containerEl)
        .setName('包含的文件夹')
        .setDesc(
          '以逗号分隔的文件夹路径，其中的 .md 文件用块编辑器打开（例如 "journals, projects/notes"）。这些文件夹之外的文件仍使用原生编辑器。',
        )
        .addText((t) =>
          t
            .setPlaceholder('journals, projects/notes')
            .setValue(this.plugin.settings.includedFolders)
            .onChange(async (v) => {
              this.plugin.settings.includedFolders = v;
              await this.plugin.saveSettings();
            }),
        );
    }

    if (this.plugin.settings.takeOverByDefault && this.plugin.settings.scopeMode === 'all') {
      new Setting(containerEl)
        .setName('排除的文件夹')
        .setDesc('以逗号分隔的文件夹路径，其中的文件仍使用原生编辑器打开（例如 "templates, attachments/notes"）。')
        .addText((t) =>
          t
            .setPlaceholder('folder1, folder2')
            .setValue(this.plugin.settings.excludedFolders)
            .onChange(async (v) => {
              this.plugin.settings.excludedFolders = v;
              await this.plugin.saveSettings();
            }),
        );
    }

    // ---------- Page properties editor ----------
    new Setting(containerEl)
      .setName('页面属性编辑器')
      .setDesc(
        '页面属性块（文件开头的 key:: value 行，或 frontmatter）在块编辑器里如何编辑。"原生（Obsidian 属性）"会挂载 Obsidian 自带的属性界面，' +
          '带有它的属性类型控件和你已安装的属性插件。无论选哪种，文件格式都不会变。',
      )
      .addDropdown((d) =>
        d
          .addOptions({ logseq: 'Logseq（key:: value 文本）', native: '原生（Obsidian 属性）' })
          .setValue(this.plugin.settings.pagePropsEditor)
          .onChange(async (v) => {
            this.plugin.settings.pagePropsEditor = v as PagePropsEditor;
            await this.plugin.saveSettings();
            if (v === 'native') void this.plugin.resolveNativePropsCtor();
          }),
      );

  }

  private renderMarketSection(containerEl: HTMLElement): void {

    new Setting(containerEl)
      .setName('扩展市场')
      .setDesc('从 Open VSX / VSCode Marketplace 搜索并安装 VSCode 扩展（TextMate 语法等），供块编辑器消费。')
      .addButton((b) => b.setButtonText('打开扩展市场').onClick(() => new ExtensionMarketModal(this.plugin).open()));

    // 代码配色主题偏好（'' 自动 / '__none__' 内置配色 / Monaco 主题名）
    new Setting(containerEl)
      .setName('代码配色主题')
      .setDesc('应用已安装扩展的颜色主题到代码编辑器；未装或指定主题不可用时回退内置 Obsidian 配色。')
      .addDropdown((d) => {
        const themes = getLoadedThemes();
        const options: Record<string, string> = { '': '自动（扩展主题优先）', __none__: '内置 Obsidian 配色' };
        for (const t of themes) options[t.name] = `${t.label}（${t.base === 'vs' ? '亮' : '暗'}）`;
        // 偏好指向的主题当前未加载（扩展被禁用等）也列出，避免显示成值本身
        if (this.plugin.settings.codeThemePref && !(this.plugin.settings.codeThemePref in options)) {
          options[this.plugin.settings.codeThemePref] = this.plugin.settings.codeThemePref;
        }
        d.addOptions(options).setValue(this.plugin.settings.codeThemePref).onChange(async (v) => {
          this.plugin.settings.codeThemePref = v;
          await this.plugin.saveSettings();
          applyCodeThemePreference(v);
        });
      });

    // 文件图标主题偏好（'' 自动 / '__none__' 不使用 / 扩展 id）
    new Setting(containerEl)
      .setName('文件图标主题')
      .setDesc('应用已安装扩展的图标主题到外部挂载面板；未装时用默认图标。')
      .addDropdown((d) => {
        const themes = getLoadedIconThemes();
        const options: Record<string, string> = { '': '自动（第一个已装主题）', __none__: '不使用扩展图标主题' };
        for (const t of themes) options[t.extensionId] = t.label;
        if (this.plugin.settings.iconThemePref && !(this.plugin.settings.iconThemePref in options)) {
          options[this.plugin.settings.iconThemePref] = this.plugin.settings.iconThemePref;
        }
        d.addOptions(options).setValue(this.plugin.settings.iconThemePref).onChange(async (v) => {
          this.plugin.settings.iconThemePref = v;
          await this.plugin.saveSettings();
          activateIconThemeByPreference(v);
        });
      });

  }

  private renderLspSection(containerEl: HTMLElement): void {

    new Setting(containerEl)
      .setName('LSP（补全/悬停/诊断）')
      .setDesc(
        '库外代码文件的补全、悬停提示与诊断。语言服务器随下面配置的 Python 环境解析代码（如 ai 环境的 numpy/torch），' +
          '切换环境后自动重启。内置 pyright（Python）开箱即用；其他语言用下方列表接入任意 --stdio 语言服务器。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.lspEnabled !== false).onChange(async (v) => {
          this.plugin.settings.lspEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.rerenderExternalViews();
        }),
      );

    const lspServers = effectiveLspServers(this.plugin.settings.lspServers);
    for (const s of lspServers) {
      const covered = (this.plugin.settings.lspServers ?? []).find((u) => u.id === s.id);
      const enabledNow = s.enabled;
      const row = new Setting(containerEl)
        .setName(`${s.builtin ? '内置 ' : ''}${s.id}${enabledNow ? '' : '（已停用）'}`)
        .setDesc(`${s.languages.join(', ')} → ${s.launch === 'node' ? `node ${s.command}` : s.command} ${s.args.join(' ')}`.trim());
      row.addToggle((t) =>
        t.setValue(enabledNow).onChange(async (v) => {
          if (s.builtin) {
            // 内置 pyright 的开关存在用户覆盖条目里，升级不丢
            const list = this.plugin.settings.lspServers ?? [];
            const i = list.findIndex((u) => u.id === s.id);
            if (i >= 0) list[i] = { ...list[i], enabled: v };
            else list.push({ id: s.id, languages: [...s.languages], launch: s.launch, command: s.command, args: [...s.args], enabled: v });
            this.plugin.settings.lspServers = list;
          } else {
            s.enabled = v;
          }
          await this.plugin.saveSettings();
          this.plugin.rerenderExternalViews();
          this.display();
        }),
      );
      if (!s.builtin) {
        row
          .addExtraButton((b) =>
            b.setIcon('settings').setTooltip('编辑').onClick(() => {
              new LspServerEditModal(this.plugin.app, s, async (next: LspServerSpec) => {
                const list = this.plugin.settings.lspServers ?? [];
                const i = list.findIndex((u) => u.id === covered?.id);
                if (i >= 0) list[i] = next;
                else list.push(next);
                this.plugin.settings.lspServers = list;
                await this.plugin.saveSettings();
                this.plugin.rerenderExternalViews();
                this.display();
              }).open();
            }),
          )
          .addExtraButton((b) =>
            b.setIcon('trash').setTooltip('删除').onClick(async () => {
              this.plugin.settings.lspServers = (this.plugin.settings.lspServers ?? []).filter((u) => u.id !== s.id);
              await this.plugin.saveSettings();
              this.plugin.rerenderExternalViews();
              this.display();
            }),
          );
      }
    }

    new Setting(containerEl).setName('添加').addButton((b) =>
      b
        .setButtonText('添加语言服务器')
        .onClick(() => {
          new LspServerEditModal(this.plugin.app, null, async (next: LspServerSpec) => {
            const list = this.plugin.settings.lspServers ?? [];
            list.push(next);
            this.plugin.settings.lspServers = list;
            await this.plugin.saveSettings();
            this.plugin.rerenderExternalViews();
            this.display();
          }).open();
        }),
    );

  }

  private renderHotkeysSection(containerEl: HTMLElement): void {

    new Setting(containerEl)
      .setName('Logseq 快捷键')
      .setDesc(
        '下面这些 Logseq 专属快捷键的总开关。"全部"保留 Logseq 的默认绑定；"无"把它们全部交还给 Obsidian/CodeMirror，' +
          '块编辑器就像纯文本编辑器一样工作。之后可以再逐组单独开启。本项只影响块编辑器——原生 Obsidian 编辑器始终使用 Obsidian 的快捷键。',
      )
      .addDropdown((d) =>
        d
          .addOptions({
            all: '全部分组（Logseq 默认）',
            none: '无（使用 Obsidian 快捷键）',
            custom: '自定义——在下面逐组选择',
          })
          .setValue(this.shortcutPresetValue())
          .onChange(async (v) => {
            if (v === 'custom') return; // driven by the per-group toggles
            const value = v === 'all';
            for (const k of Object.keys(this.plugin.settings.shortcuts) as (keyof ShortcutOverrides)[]) {
              this.plugin.settings.shortcuts[k] = value;
            }
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '每一组都是独立的。关闭其中一组，只把这些键交还给 Obsidian，其余保持不变。',
    });

    for (const key of Object.keys(SHORTCUT_GROUP_LABELS) as (keyof ShortcutOverrides)[]) {
      new Setting(containerEl)
        .setName(SHORTCUT_GROUP_LABELS[key])
        .setClass('lgp-shortcut-group')
        .addToggle((t) =>
          t.setValue(this.plugin.settings.shortcuts[key]).onChange(async (v) => {
            this.plugin.settings.shortcuts[key] = v;
            await this.plugin.saveSettings();
            // Re-render so the master dropdown flips to "Custom".
            this.display();
          }),
        );
    }

    // ---------- Outline guide line ----------
    const levelOptions = {
      '1': '1 级',
      '2': '2 级',
      '3': '3 级',
      '4': '4 级',
      '5': '5 级',
      '0': '全部层级',
    };

    new Setting(containerEl)
      .setName('任意块折叠')
      .setDesc(
        '在正文超过一行的块上显示折叠箭头——标题、代码围栏、表格、引用、图片和多行段落——而不只是带子块的列表项。' +
          '点击折叠为一行摘要；Alt+点击直接折叠成类型标签。折叠状态会像列表块那样，以 `collapsed::` 属性的形式存进你的 Markdown。',
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.foldEnabled !== false)
          .onChange(async (v) => {
            this.plugin.settings.foldEnabled = v;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          }),
      );

    new Setting(containerEl)
      .setName('文末添加块')
      .setDesc(
        '大纲最后一块下方那条可点击的空白提示行——鼠标移过去会浮现一条横线和一个加号（与思源文档底部一致），' +
          '点击就在末尾追加新块并聚焦。关掉它，页面滚到底就是最后一块，不再多一行占位；' +
          '在最后一块里按 Enter 仍然照常分裂出新块，所以只是少了这个视觉入口，不影响接着写。',
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.addBlockAffordance !== false)
          .onChange(async (v) => {
            this.plugin.settings.addBlockAffordance = v;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          }),
      );

    new Setting(containerEl)
      .setName('隐藏的块属性')
      .setDesc(
        '以逗号分隔的属性名，它们仍保留在你的 Markdown 里，但不渲染成 `key:: value` 行。隐藏只是显示层面的：' +
          '属性照样会被解析、照样参与查询索引，也照样能在块属性菜单里编辑。`collapsed` 默认隐藏，以免折叠标记弄乱视图。',
      )
      .addText((t) =>
        t
          .setPlaceholder('collapsed')
          .setValue(this.plugin.settings.hiddenProps ?? '')
          .onChange(async (v) => {
            this.plugin.settings.hiddenProps = v;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          }),
      );

    new Setting(containerEl)
      .setName('竖线折叠深度')
      .setDesc(
        '点击竖直参考线会折叠它里面的内容：一级块仍以折叠行的形式可见，其下的一切都隐藏起来。' +
          '这一项决定有多少层级承载折叠状态（直接子块算第 1 级）；更深的层级在再次展开时保持折叠。"全部层级"表示第 1 级以下全部折叠。',
      )
      .addDropdown((d) =>
        d
          .addOptions(levelOptions)
          .setValue(String(this.plugin.settings.guideLineCollapseLevels))
          .onChange(async (v) => {
            this.plugin.settings.guideLineCollapseLevels = Number(v);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('竖线展开深度')
      .setDesc(
        '点击已折叠的内容时，一次展开多少层级（直接子块算第 1 级；被点击的块本身若已折叠总会打开）。' +
          '"1 级"表示每点一次展开一步；"全部层级"表示第 1 级以下全部展开。',
      )
      .addDropdown((d) =>
        d
          .addOptions(levelOptions)
          .setValue(String(this.plugin.settings.guideLineExpandLevels))
          .onChange(async (v) => {
            this.plugin.settings.guideLineExpandLevels = Number(v);
            await this.plugin.saveSettings();
          }),
      );

  }

  private renderSafetySection(containerEl: HTMLElement): void {

    new Setting(containerEl)
      .setName('自动备份')
      .setDesc('在插件写入笔记之前，先把原文件存到 .logseq-editor/backups/（每个文件保留最近 10 份）。通过命令面板恢复。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.backupsEnabled).onChange(async (v) => {
          this.plugin.settings.backupsEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('操作日志')
      .setDesc('把每次同步/写入操作（时间、文件、结果）记录到 .logseq-editor/log.jsonl，并通过"显示操作日志"查看。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.opLogEnabled).onChange(async (v) => {
          this.plugin.settings.opLogEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

  }

  private renderJournalSection(containerEl: HTMLElement): void {

    new Setting(containerEl)
      .setName('日记文件夹')
      .setDesc('每日笔记所在文件夹。留空则使用核心 Daily notes 插件的设置，或库根目录。')
      .addText((t) =>
        t
          .setPlaceholder('例如 journals')
          .setValue(this.plugin.settings.journalFolder)
          .onChange(async (v) => {
            this.plugin.settings.journalFolder = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('日记日期格式')
      .setDesc('可用标记：YYYY MM DD HH mm ss。留空则使用核心 Daily notes 插件的设置，或 YYYY-MM-DD。')
      .addText((t) =>
        t
          .setPlaceholder('YYYY-MM-DD')
          .setValue(this.plugin.settings.journalFormat)
          .onChange(async (v) => {
            this.plugin.settings.journalFormat = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('日记模板')
      .setDesc('新建日记文件时写入的文本（Markdown，支持 Logseq 块语法）。')
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.journalTemplate).onChange(async (v) => {
          this.plugin.settings.journalTemplate = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 4;
        t.inputEl.cols = 40;
      });

  }

  private renderMountsSection(containerEl: HTMLElement): void {
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        '把库外的文件夹挂到挂载面板。Markdown 在原地编辑并存回原文件，不会复制进库。' +
        '每个挂载可以用包含 / 排除两条正则过滤；在面板里右键任意条目还可以把它链接进库，' +
        '之后就能用原生块编辑器打开（反链、块引用、搜索全部生效）。',
    });

    new Setting(containerEl)
      .setName('启用挂载过滤')
      .setDesc(
        '默认关闭：虚拟文档树显示挂载文件夹下的全部内容，不做任何过滤。' +
          '开启后，每个挂载自己的包含 / 排除正则才会生效；正则原样保留，' +
          '随时开关都不用重新填写。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.mountFilterEnabled === true).onChange(async (v) => {
          this.plugin.settings.mountFilterEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.refreshMounts();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName('显示「已加载」统计')
      .setDesc(
        '挂载标题下方的「已加载 N 文件 · M 文件夹」提示。' +
          '树是逐层懒加载的，这只是已读取层的统计，不是总数；' +
          '嫌它占地方可以关掉。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.mountShowLoadedCount !== false).onChange(async (v) => {
          this.plugin.settings.mountShowLoadedCount = v;
          await this.plugin.saveSettings();
          this.plugin.refreshMounts();
        }),
      );

    new Setting(containerEl)
      .setName('显示「链接到库」')
      .setDesc(
        '右键菜单里的链接进库入口（目录联接 / 硬链接到 Mounts/，' +
          '含「链接整个上级文件夹」和「从库中取消链接」）。' +
          '不需要把库外文件链接进库的话可以关掉；' +
          '已经建立的链接不受影响，仍会照常打开。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.mountLinkEnabled !== false).onChange(async (v) => {
          this.plugin.settings.mountLinkEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.refreshMounts();
        }),
      );

    const mounts = this.plugin.settings.externalMounts ?? [];
    if (mounts.length === 0) {
      containerEl.createDiv({ cls: 'setting-item-description', text: '暂无外部挂载。' });
    }
    for (const m of mounts) {
      new Setting(containerEl)
        .setName(mountDisplayName(m))
        .setDesc(m.path)
        .addExtraButton((b) =>
          b
            .setIcon('settings')
            .setTooltip('编辑这个挂载')
            .onClick(() => this.plugin.editMount(m)),
        )
        .addExtraButton((b) =>
          b
            .setIcon('trash')
            .setTooltip('卸载')
            .onClick(async () => {
              await this.plugin.removeMount(m);
              this.display();
            }),
        );
    }

    const mountActions = new Setting(containerEl).setName('管理');
    mountActions.addButton((b) =>
      b
        .setButtonText('打开挂载面板')
        .setCta()
        .onClick(() => void this.plugin.activatePanel(VIEW_TYPE_MOUNT_PANEL)),
    );
    mountActions.addButton((b) =>
      b.setButtonText('添加挂载').onClick(() => this.plugin.promptAddMount()),
    );
    mountActions.addButton((b) =>
      b.setButtonText('管理全部').onClick(() => new MountListModal(this.plugin).open()),
    );
    mountActions.addButton((b) => b.setButtonText('重新扫描').onClick(() => this.plugin.refreshMounts()));

    new Setting(containerEl)
      .setName('启动时预建代码块编辑器')
      .setDesc(
        '文档里的代码块共用一个 Monaco 编辑器实例（聚焦时搬进来、提交后搬回池里，' +
          '不销毁），但第一次使用前实例还不存在——那一次创建是插件里最贵的一步，' +
          '表现为「第一次点进代码块要顿一下」。开启后 Obsidian 启动完成就把实例建好，' +
          '第一次点进代码块也就是搬一下 DOM。代价是启动阶段多占一份内存。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.codeBlockPrewarm === true).onChange(async (v) => {
          this.plugin.settings.codeBlockPrewarm = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('代码文件注释用 Logseq 编辑器编辑（可选）')
      .setDesc(
        '默认关闭：代码文件整台是一个 Monaco 纯代码编辑器，注释即语法高亮。' +
          '开启后，注释区（连续的整行注释，以及 /* */ 与 """ 块注释、docstring）' +
          '以 Logseq 块编辑器呈现，嵌在代码行的对应位置：可编辑、按 Markdown 渲染、' +
          '可写 [[双链]]；代码区仍由 Monaco 编辑，未编辑时保存完全无损。' +
          '单个文件可在视图头部按钮临时切换到另一种呈现。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.externalCodeHybrid === true).onChange(async (v) => {
          this.plugin.settings.externalCodeHybrid = v;
          await this.plugin.saveSettings();
          this.plugin.rerenderExternalViews();
        }),
      );

    new Setting(containerEl)
      .setName('库外文件分栏打开')
      .setDesc(
        '在侧边分栏中打开库外文件，不替换当前标签页。' +
          '关闭则直接用当前标签页打开（默认）——窗口更整洁，' +
          '但若该标签页正显示着别的笔记，会被替换掉。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.externalSplitView === true).onChange(async (v) => {
          this.plugin.settings.externalSplitView = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('显示库外文件提示栏')
      .setDesc(
        '在文件顶部显示提示栏（文件名、相对路径、「库外」标记与保存按钮）。' +
          '关闭后提示栏完全不显示；文件仍按原有的自动保存节奏写回原文件，' +
          '随时可按 Ctrl+S 立即保存。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.externalBanner !== false).onChange(async (v) => {
          this.plugin.settings.externalBanner = v;
          await this.plugin.saveSettings();
          this.plugin.rerenderExternalViews();
        }),
      );

  }

  private renderViewersSection(containerEl: HTMLElement): void {

    new Setting(containerEl)
      .setName('接管 Office 文件')
      .setDesc(
        '用内置预览器打开 .docx / .xlsx / .pptx（以及 .odt / .rtf / .csv 等）文件，' +
          '只读渲染。Obsidian 本身对这类文件没有预览能力，所以开启不挤占任何现有功能；' +
          '需要编辑时点预览器工具栏的「用外部应用打开」。修改后需重启 Obsidian 生效。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.officeViewerEnabled !== false).onChange(async (v) => {
          this.plugin.settings.officeViewerEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('接管图片文件')
      .setDesc(
        '用增强图片查看器打开图片：滚轮 / 按钮缩放、旋转 90°、按住拖拽平移、' +
          '同目录上一张 / 下一张、复制与另存为。Obsidian 自带图片预览，因此默认关闭；' +
          '命令面板与右键菜单里的入口无论是否开启都可用。修改后需重启 Obsidian 生效。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.imageViewerTakeOver === true).onChange(async (v) => {
          this.plugin.settings.imageViewerTakeOver = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('文件内容搜索')
      .setDesc(
        '跨整个库搜索文件内容：支持正则表达式、区分大小写、全词匹配，可按文件夹与扩展名过滤，' +
          '结果带上下文并可直接跳转到对应行。',
      )
      .addButton((b) =>
        b
          .setButtonText('打开面板')
          .setCta()
          .onClick(() => void this.plugin.activatePanel(VIEW_TYPE_CONTENT_SEARCH)),
      );

    const cs = this.plugin.settings.contentSearch;
    new Setting(containerEl)
      .setName('搜索：默认扩展名')
      .setDesc('逗号分隔，点号可省略。留空则回退到一组常用文本扩展名。')
      .addText((t) =>
        t.setValue(cs.extensions).onChange(async (v) => {
          this.plugin.settings.contentSearch = { ...cs, extensions: v };
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('搜索：单文件大小上限（KB）')
      .setDesc('超过此大小的文件不参与搜索，避免大文件拖慢整库扫描。')
      .addText((t) =>
        t.setValue(String(cs.maxFileKB)).onChange(async (v) => {
          const n = Number(v);
          this.plugin.settings.contentSearch = {
            ...cs,
            maxFileKB: Number.isFinite(n) && n >= 1 ? Math.min(n, 10240) : 1024,
          };
          await this.plugin.saveSettings();
        }),
      );

    // ---------- Open with ----------
    containerEl.createEl('h4', { text: '打开方式' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        '为文件配置「用 XX 打开」的入口。%1 替换为文件绝对路径，%d 替换为所在文件夹。' +
        '配置后出现在文件右键菜单、图片查看器与 Office 预览器的菜单里，' +
        '命令面板中也会生成对应命令（需重启后刷新命令列表）。',
    });

    const apps = this.plugin.settings.openWithApps ?? [];
    if (apps.length === 0) {
      containerEl.createDiv({ cls: 'setting-item-description', text: '暂无配置。' });
    }
    for (const a of apps) {
      new Setting(containerEl)
        .setName(a.name)
        .setDesc(`${a.command} ${a.args}${a.enabled ? '' : '（已停用）'}`)
        .addExtraButton((b) =>
          b
            .setIcon('settings')
            .setTooltip('编辑')
            .onClick(() => {
              new OpenWithEditModal(this.plugin.app, a, async (next) => {
                const list = this.plugin.settings.openWithApps ?? [];
                const i = list.findIndex((x) => x.id === a.id);
                if (i >= 0) list[i] = next;
                await this.plugin.saveSettings();
                this.display();
              }).open();
            }),
        )
        .addExtraButton((b) =>
          b
            .setIcon(a.enabled ? 'toggle-right' : 'toggle-left')
            .setTooltip(a.enabled ? '停用' : '启用')
            .onClick(async () => {
              a.enabled = !a.enabled;
              await this.plugin.saveSettings();
              this.display();
            }),
        )
        .addExtraButton((b) =>
          b
            .setIcon('trash')
            .setTooltip('删除')
            .onClick(async () => {
              this.plugin.settings.openWithApps = (this.plugin.settings.openWithApps ?? []).filter(
                (x) => x.id !== a.id,
              );
              await this.plugin.saveSettings();
              this.display();
            }),
        );
    }

    new Setting(containerEl).setName('添加').addButton((b) =>
      b.setButtonText('添加打开方式').onClick(() => {
        new OpenWithEditModal(this.plugin.app, null, async (next) => {
          this.plugin.settings.openWithApps = [...(this.plugin.settings.openWithApps ?? []), next];
          await this.plugin.saveSettings();
          this.display();
        }).open();
      }),
    );

  }

  private renderTemplatesSection(containerEl: HTMLElement): void {

    new Setting(containerEl)
      .setName('自定义模板变量')
      .setDesc('每行一个 "名称 = 值"。可在任意块中用 <% 名称 %> 引用。内置变量：today、yesterday、tomorrow、now、time、current page。')
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.customTemplateVars).onChange(async (v) => {
          this.plugin.settings.customTemplateVars = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 4;
        t.inputEl.cols = 40;
      });

  }

  private renderSqliteSection(containerEl: HTMLElement): void {
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        '从 Markdown 派生出的可重建数据库。Markdown 始终是唯一真值——' +
        '数据库绝不回写笔记，「重建」也完全从文件重新推导。',
    });

    new Setting(containerEl)
      .setName('启用 SQLite 索引')
      .setDesc('维护一个可查询的数据库，收录块、标签、链接、属性和块引用。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.sqliteIndexEnabled).onChange(async (v) => {
          this.plugin.settings.sqliteIndexEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.applySqliteSettings();
          this.display();
        }),
      );

    if (this.plugin.settings.sqliteIndexEnabled) {
      new Setting(containerEl)
        .setName('在磁盘保留快照')
        .setDesc('把数据库保存到会话之间，让重启只重新索引变化的部分。')
        .addToggle((t) =>
          t.setValue(this.plugin.settings.sqlitePersist).onChange(async (v) => {
            this.plugin.settings.sqlitePersist = v;
            await this.plugin.saveSettings();
          }),
        );

      new Setting(containerEl)
        .setName('文件变化时同步')
        .setDesc('文件一被编辑、新建、重命名或删除就重新索引——包括其他应用造成的改动。')
        .addToggle((t) =>
          t.setValue(this.plugin.settings.sqliteAutoSync).onChange(async (v) => {
            this.plugin.settings.sqliteAutoSync = v;
            await this.plugin.saveSettings();
          }),
        );

      const stats = this.plugin.sqliteIndex?.stats;
      const detail = stats
        ? `${stats.files} 个文件 · ${stats.blocks} 个块 · ${stats.tags} 个标签 · ${stats.links} 条链接 · ${stats.refs} 处引用（上次运行 ${stats.ms} 毫秒）`
        : '尚未开始';
      new Setting(containerEl).setName('索引').setDesc(detail).addButton((b) =>
        b.setButtonText('控制台').onClick(() => new SqliteConsoleModal(this.plugin).open()),
      );

      const actions = new Setting(containerEl).setName('Markdown → 数据库');
      actions.addButton((b) =>
        b.setButtonText('同步').onClick(async () => {
          const idx = this.plugin.sqliteIndex;
          if (!idx) return;
          const s = await idx.sync();
          new Notice(`已同步：+${s.added} ~${s.changed} -${s.removed}（${s.unchanged} 个未变）`);
          this.display();
        }),
      );
      actions.addButton((b) =>
        b.setButtonText('重建').onClick(async () => {
          const idx = this.plugin.sqliteIndex;
          if (!idx) return;
          const s = await idx.rebuild();
          new Notice(`已从 Markdown 重建：${s.files} 个文件，${s.blocks} 个块（${s.ms} 毫秒）`);
          this.display();
        }),
      );
      actions.addButton((b) =>
        b.setButtonText('校验').onClick(async () => {
          const idx = this.plugin.sqliteIndex;
          if (!idx) return;
          const v = await idx.verify();
          new Notice(
            v.drift.length === 0 && v.missing.length === 0
              ? `与文件一致（已校验 ${v.checked} 个）`
              : `已过期——不一致 ${v.drift.length} 处，缺失 ${v.missing.length} 处`,
          );
        }),
      );
    }

  }

  private renderCodeRunSection(containerEl: HTMLElement): void {
    containerEl.createEl('p', {
      text: '代码块与代码文件的 ▶ 运行使用这里选中的 Python 环境（conda / venv / 系统）。切换后对下一次运行生效。',
      cls: 'setting-item-description',
    });

    const envs = this.plugin.discoveredPythonEnvs();
    new Setting(containerEl)
      .setName('Python 环境')
      .setDesc(this.plugin.activePythonEnvLabel())
      .addDropdown((d) => {
        d.addOption('', '自动探测（PATH → py.exe → Program Files）');
        for (const e of envs) {
          d.addOption(e.id, `${e.name}${e.version ? ' · ' + e.version : ''}`);
        }
        d.setValue(this.plugin.settings.pythonEnvId);
        d.onChange(async (v) => {
          this.plugin.settings.pythonEnvId = v;
          await this.plugin.saveSettings();
          this.plugin.applyPythonEnv();
          this.display();
        });
      })
      .addExtraButton((b) =>
        b
          .setIcon('refresh-cw')
          .setTooltip('重新扫描环境')
          .onClick(async () => {
            await this.plugin.refreshPythonEnvs();
            this.display();
            new Notice(`已扫描到 ${this.plugin.discoveredPythonEnvs().length} 个 Python 环境`);
          }),
      );

    new Setting(containerEl)
      .setName('自定义解释器路径')
      .setDesc('留空使用上面的下拉选择。填了就优先用它（例如 D:\programs\anaconda3\envs\ai\python.exe）')
      .addText((t) =>
        t
          .setPlaceholder('例如 D:\programs\anaconda3\envs\ai\python.exe')
          .setValue(this.plugin.settings.pythonEnvCustomPath)
          .onChange(async (v) => {
            this.plugin.settings.pythonEnvCustomPath = v.trim();
            await this.plugin.saveSettings();
            this.plugin.applyPythonEnv();
          }),
      );

  }

  private renderEditorSettingsSection(containerEl: HTMLElement): void {
    // 编辑器设置(25 行 + settings.json 操作行),平铺 Setting 行,Obsidian 原生观感
    renderEditorSettingsRows(containerEl, this.plugin);
  }
}

