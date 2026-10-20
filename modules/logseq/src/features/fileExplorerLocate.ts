import { App, Notice, setIcon, WorkspaceLeaf } from 'obsidian';

/**
 * 在 Obsidian **自带文件浏览器**（核心的 file-explorer 边栏）工具栏注入
 * 「定位当前文件」按钮。
 *
 * 与挂载面板的那个定位按钮区别：挂载面板只认 externalMounts 里的路径，
 * 库内文件不在任何挂载下就定位不了；这个按钮走 Obsidian 自己的揭示逻辑，
 * 对库内文件总是有效。
 *
 * 揭示优先用内置命令 `…:reveal-active-file`（内部实现随版本变，命令 id 前缀
 * 不保证稳定，故按包含匹配查找）；找不到再回退 FileExplorerView 的
 * revealFile()。两条路都没有才提示失败——绝不静默。
 */
export class FileExplorerLocateButton {
  private readonly installed = new Set<HTMLElement>();
  private readonly onClick = (): void => {
    void this.revealActiveFile();
  };

  constructor(private readonly app: App) {}

  /** 给当前所有文件浏览器面板装按钮（幂等）。 */
  public installAll(): void {
    for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
      this.install(leaf);
    }
  }

  /** 卸载：移除所有注入的按钮。 */
  public uninstall(): void {
    for (const btn of this.installed) btn.remove();
    this.installed.clear();
  }

  private install(leaf: WorkspaceLeaf): void {
    const container = (
      leaf.view as unknown as { containerEl?: HTMLElement } | undefined
    )?.containerEl;
    if (!container) return;
    const bar = container.querySelector('.nav-buttons-container');
    if (!bar) return;
    // 幂等：已经装过就不再装（布局变化会反复触发本方法）。
    if (bar.querySelector('.logseq-locate-active-file')) return;

    const btn = document.createElement('button');
    btn.className = 'nav-action-button logseq-locate-active-file';
    btn.setAttribute('aria-label', '定位当前文件');
    btn.title = '定位当前文件';
    setIcon(btn, 'crosshair');
    btn.addEventListener('click', this.onClick);
    bar.appendChild(btn);
    this.installed.add(btn);
  }

  private async revealActiveFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('当前没有打开的文件');
      return;
    }

    const app = this.app as unknown as {
      commands?: {
        commands?: Record<string, unknown>;
        executeCommandById?: (id: string) => unknown;
      };
    };
    const cmdId = Object.keys(app.commands?.commands ?? {}).find(id =>
      id.includes('reveal-active-file')
    );
    if (cmdId && typeof app.commands?.executeCommandById === 'function') {
      app.commands.executeCommandById(cmdId);
      return;
    }

    const explorer = this.app.workspace.getLeavesOfType('file-explorer')[0]
      ?.view as unknown as { revealFile?: (f: unknown) => void } | undefined;
    if (typeof explorer?.revealFile === 'function') {
      explorer.revealFile(file);
      return;
    }

    new Notice('未能定位当前文件');
  }
}
