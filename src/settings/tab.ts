import { PluginSettingTab, Setting, Notice, type App } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { SqliteConsoleModal } from '../features/sqliteConsole';
import { MountListModal } from '../panels/mountModals';
import { VIEW_TYPE_MOUNT_PANEL } from '../panels/mountPanel';
import { VIEW_TYPE_CONTENT_SEARCH } from '../panels/contentSearchPanel';
import { OpenWithEditModal } from '../features/openWithUi';
import { mountDisplayName, type PagePropsEditor, type ScopeMode, type ShortcutOverrides } from '../types';
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

    // ---------- Shortcuts ----------
    containerEl.createEl('h3', { text: '快捷键' });

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

    // ---------- Safety: backups & operation log ----------
    containerEl.createEl('h3', { text: '安全（备份与日志）' });

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

    // ---------- Journal (daily notes) ----------
    containerEl.createEl('h3', { text: '日记（每日笔记）' });

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

    // ---------- External mounts ----------
    containerEl.createEl('h3', { text: '外部挂载' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        '把库外的文件夹挂到挂载面板。Markdown 在原地编辑并存回原文件，不会复制进库。' +
        '每个挂载可以用包含 / 排除两条正则过滤；在面板里右键任意条目还可以把它链接进库，' +
        '之后就能用原生块编辑器打开（反链、块引用、搜索全部生效）。',
    });

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
      .setName('代码编辑器自动换行')
      .setDesc(
        '默认开启：长行自动折行，宽度始终适应窗口。关闭后改为横向滚动而不折行，' +
          '深层缩进的代码更易读。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.externalCodeWrap !== false).onChange(async (v) => {
          this.plugin.settings.externalCodeWrap = v;
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

    // ---------- Viewers & content search ----------
    containerEl.createEl('h3', { text: '查看器与搜索' });

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

    // ---------- Templates ----------
    containerEl.createEl('h3', { text: '模板' });

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

    // ---------- SQLite secondary index ----------
    containerEl.createEl('h3', { text: 'SQLite 二级索引' });
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
}