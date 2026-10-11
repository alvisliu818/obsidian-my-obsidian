/**
 * Obsidian Jupyter Notebook — 在 Obsidian 里查看、编辑并运行 Jupyter
 * 笔记本(.ipynb)。
 *
 * - 查看:代码/Markdown 单元格渲染,已保存的执行输出(文本/图片/HTML/JSON/错误)
 * - 编辑:单元格就地 CodeMirror 编辑;增删/移动/切换类型;写回 nbformat 4 JSON
 * - 运行:自带的持久 Python 内核(kernel/legacyPython + syfe-kernel.py,
 *   自 obsidian-logseq 抽出),不依赖 Jupyter 协议
 *
 * 打开入口:文件右键「用 Notebook 打开」+ 命令面板。Obsidian 对 .ipynb 这类
 * 未知扩展名不会自动交给第三方视图,所以这里是显式入口。
 */

import { Menu, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { NotebookView, VIEW_TYPE_NOTEBOOK } from './notebookView';
import { disposeAllKernels } from './kernel/registry';

export default class JupyterNotebookPlugin extends Plugin {
  settings = { wrap: true };

  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE_NOTEBOOK, (leaf: WorkspaceLeaf) => new NotebookView(leaf, this));

    // 右键 .ipynb:用 Notebook 打开
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu: Menu, file) => {
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'ipynb') return;
        menu.addItem((it) => {
          it.setTitle('用 Notebook 打开').setIcon('file-code').onClick(() => {
            void this.openNotebook(file);
          });
        });
      }),
    );

    // 命令:当前文件是 .ipynb 时可用
    this.addCommand({
      id: 'open-notebook',
      name: 'Open current notebook (.ipynb)',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'ipynb') return false;
        if (!checking) void this.openNotebook(file);
        return true;
      },
    });
  }

  async onunload(): Promise<void> {
    // 关掉所有还在跑的内核(持久 Python 进程),不留孤儿进程
    await disposeAllKernels();
  }

  /** 在新标签页打开 notebook(复用已有同文件视图则聚焦) */
  async openNotebook(file: TFile): Promise<void> {
    // 同文件去重:已打开的 Notebook 视图直接聚焦
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTEBOOK);
    for (const leaf of leaves) {
      const view = leaf.view as NotebookView;
      if (view.path === file.path) {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        return;
      }
    }
    const leaf: WorkspaceLeaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: VIEW_TYPE_NOTEBOOK,
      active: true,
      state: { path: file.path },
    });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    new Notice(`Notebook: ${file.name}`, 1500);
  }
}
