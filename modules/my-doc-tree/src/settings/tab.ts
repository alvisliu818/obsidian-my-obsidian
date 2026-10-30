/**
 * Settings tab for the virtual document tree module: mounts, the tree's
 * display toggles, the out-of-vault markdown default editor, and the media
 * viewer / "open with" configuration.
 *
 * 2026-10-27 module split: these rows used to live in logseq's setting tab
 * (renderMountsSection / renderViewersSection). The block-editor rows that
 * shared those sections (codeBlockPrewarm, externalCodeHybrid, the banner and
 * the references toggles) stayed behind in logseq's tab.
 */

import { PluginSettingTab, Setting, type App } from 'obsidian';
import type DocTreePlugin from '../main';
import { MountListModal } from '../panels/mountModals';
import { VIEW_TYPE_MOUNT_PANEL } from '../panels/mountPanel';
import { mountDisplayName, type EditorChoice, type VideoOpenMode } from '../types';
import { OpenWithEditModal } from '../features/openWithUi';
import { isDirectory } from '../features/extFs';
import {
  hasSystemPicker,
  pickExternalPath,
  rememberedDirFor,
  startDirFor,
} from '../features/systemDialog';

export class DocTreeSettingTab extends PluginSettingTab {
  plugin: DocTreePlugin;

  constructor(app: App, plugin: DocTreePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h3', { text: '外部挂载' });
    this.renderMountsSection(containerEl);
    containerEl.createEl('h3', { text: '查看器' });
    this.renderViewersSection(containerEl);
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
      .setName('库外 Markdown 默认编辑器')
      .setDesc(
        '点击挂载面板（及搜索结果）里的库外 .md 文件时用哪个编辑器打开。"Obsidian 原生编辑器"走' +
          'Obsidian 自己的库外文件打开路线（需要 1.14.4+ 桌面版安装器，反链、大纲、链接解析都是原生行为）；' +
          '"Logseq 块编辑器"是本插件的块编辑器（折叠 / 缩放 / 块引用可用，没有反链）。' +
          '单个文件可在自己的属性里覆盖此默认：frontmatter 写 editor: logseq 或 editor: native，' +
          'Logseq 格式写文件顶部的 editor:: 同样有效。' +
          '本机不支持库外原生打开时，选了原生也会落回块编辑器。',
      )
      .addDropdown((d) =>
        d
          .addOptions({ native: 'Obsidian 原生编辑器', logseq: 'Logseq 块编辑器' })
          .setValue(this.plugin.settings.externalMarkdownEditor ?? 'native')
          .onChange(async (v) => {
            this.plugin.settings.externalMarkdownEditor = v as EditorChoice;
            await this.plugin.saveSettings();
          }),
      );

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

    // 新建笔记的落盘目录：与它在树上出现的位置解耦（attachTo 决定位置，
    // 这里只决定文件写在哪 —— 见 features/extFs 与 mountPanel.promptNewNote）。
    const noteDir = new Setting(containerEl)
      .setName('新建笔记的位置')
      .setDesc(
        '虚拟文档树右键「新建笔记…」时，文件实际写入的目录；留空 = 库根目录。' +
          '新建的笔记同时挂成你右键那个条目的子文档，所以磁盘位置和树上的位置互不牵连。',
      )
      .addText((t) =>
        t
          .setPlaceholder('留空 = 库根目录')
          .setValue(this.plugin.settings.mountNewNotePath ?? '')
          .onChange(async (v) => {
            this.plugin.settings.mountNewNotePath = v;
            await this.plugin.saveSettings();
          }),
      );
    if (hasSystemPicker()) {
      noteDir.addButton((b) =>
        b.setButtonText('浏览').setTooltip('打开系统资源管理器选择目录').onClick(() => {
          void (async () => {
            const current = this.plugin.settings.mountNewNotePath ?? '';
            const picked = await pickExternalPath({
              kind: 'folder',
              title: '选择新建笔记的保存目录',
              startDir: startDirFor(current, isDirectory(current), this.plugin.settings.mountPickDir ?? ''),
            });
            if (!picked) return;
            this.plugin.settings.mountNewNotePath = picked;
            this.plugin.settings.mountPickDir = rememberedDirFor(picked, 'folder') || this.plugin.settings.mountPickDir;
            await this.plugin.saveSettings();
            this.display();
          })();
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
      .setName('视频打开方式')
      .setDesc(
        '点击库内视频文件时用哪个播放器。"视频播放器"是本插件的增强播放器：' +
          '倍速（0.5–2x）、循环、截图到剪贴板、同目录上一个 / 下一个、时间戳标记；' +
          '"Obsidian 原生播放器"是 Obsidian 自带的裸视频预览。' +
          '库外视频（挂载树、命令面板的「打开库外视频…」）始终走内置播放器，不受此设置影响。' +
          '启用 my Media Extended 模块时，它会在本插件之后接管 mp4 / webm / ogv / mov / mkv。' +
          '修改后需重启 Obsidian 生效。',
      )
      .addDropdown((d) =>
        d
          .addOptions({ player: '视频播放器（本插件）', native: 'Obsidian 原生播放器' })
          .setValue(this.plugin.settings.videoOpenMode)
          .onChange(async (v) => {
            this.plugin.settings.videoOpenMode = v as VideoOpenMode;
            await this.plugin.saveSettings();
          }),
      );

    // ---------- 视频时间戳标记 ----------
    new Setting(containerEl)
      .setName('视频时间戳标记')
      .setDesc(
        '播放器工具栏与命令(Ctrl/Cmd+Shift+M,可在热键设置改)在当前播放时间打标记:' +
          '优先插入当前活动笔记的光标处;没有活动笔记时写入标记笔记' +
          '(笔记里点时间戳跳回视频该时刻;播放器的「标记列表」读它,即双向链接)。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.videoTimestampsEnabled !== false).onChange(async (v) => {
          this.plugin.settings.videoTimestampsEnabled = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('标记笔记目录')
      .setDesc('没有活动笔记时,标记自动写入这个库内目录下的《视频名.md》。留空用默认 Video Marks。')
      .addText((t) =>
        t
          .setPlaceholder('Video Marks')
          .setValue(this.plugin.settings.videoMarksFolder ?? '')
          .onChange(async (v) => {
            this.plugin.settings.videoMarksFolder = v.trim() || 'Video Marks';
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
}
