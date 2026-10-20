import { App, Notice, setIcon, WorkspaceLeaf } from 'obsidian';

/**
 * 在 Obsidian **自带文件浏览器**（核心的 file-explorer 边栏）顶部工具栏——
 * 也就是「新建文件」那一排按钮——的最后面注入一个「定位当前文件」按钮。
 *
 * 与挂载面板那个定位按钮的区别：挂载面板只认 externalMounts 里的路径，库内
 * 文件不在任何挂载目录下就定位不了；这个按钮走 Obsidian 自己的揭示逻辑，对
 * 库内文件总是有效。
 *
 * 揭示优先用内置命令 `…:reveal-active-file`（内部实现随版本变，命令 id 前缀
 * 不保证稳定，故按包含匹配查找）；找不到再回退 FileExplorerView 的
 * revealFile()。两条路都没有才提示失败——绝不静默。
 *
 * 耐久：Obsidian 会在布局/排序变化时整排重建 nav buttons，注入的按钮会被抹
 * 掉，所以每个工具栏挂一个 MutationObserver，发现按钮没了就补回去（位置仍
 * 是末尾）。卸载时观察者一并断开。
 */
export class FileExplorerLocateButton {
  private readonly observers = new Map<HTMLElement, MutationObserver>();
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

  /** 卸载：移除所有注入的按钮与观察者。 */
  public uninstall(): void {
    for (const obs of this.observers.values()) obs.disconnect();
    this.observers.clear();
    // 按钮可能挂在已经重建过的工具栏上，按 class 全量清理。
    for (const btn of Array.from(
      document.querySelectorAll('.logseq-locate-active-file'),
    )) {
      btn.remove();
    }
  }

  private install(leaf: WorkspaceLeaf): void {
    const container = (
      leaf.view as unknown as { containerEl?: HTMLElement } | undefined
    )?.containerEl;
    if (!container) return;
    // 不同版本/主题下按钮排的容器类不完全一致，按顺序兜底。
    const bar =
      container.querySelector('.nav-buttons-container') ??
      container.querySelector('.nav-header');
    if (!(bar instanceof HTMLElement)) return;

    this.inject(bar);
    if (this.observers.has(bar)) return;
    const obs = new MutationObserver(() => this.inject(bar));
    obs.observe(bar, { childList: true });
    this.observers.set(bar, obs);
  }

  /** 幂等地把按钮补到工具栏末尾。 */
  private inject(bar: HTMLElement): void {
    if (bar.querySelector('.logseq-locate-active-file')) return;
    const btn = document.createElement('button');
    btn.className = 'nav-action-button logseq-locate-active-file';
    btn.setAttribute('aria-label', '定位当前文件');
    btn.title = '定位当前文件';
    setIcon(btn, 'crosshair');
    btn.addEventListener('click', this.onClick);
    // 末尾：排在「新建文件」那一排最后一个。
    bar.appendChild(btn);
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
