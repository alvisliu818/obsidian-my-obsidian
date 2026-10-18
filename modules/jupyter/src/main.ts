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

import { Menu, Notice, Plugin, PluginSettingTab, App, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import { NotebookView, VIEW_TYPE_NOTEBOOK } from './notebookView';
import { disposeAllKernels } from './kernel/registry';
import { setPythonInterpreterOverride } from './pythonInterpreter';
import { discoverPythonEnvs, setActiveEnv, type PythonEnv } from './pythonEnvs';
import { registerFreeExtensions } from '../../../src/extensionRegistry';

export interface JupyterSettings {
	/** 代码/Markdown 编辑器自动换行 */
	wrap: boolean;
	/** 自定义 Python 解释器路径;留空 = 自动探测(PATH → py.exe → Program Files) */
	pythonPath: string;
	/** 选中的 Python 环境(id = 解释器路径);'' = 自动探测 */
	pythonEnvId: string;
	/** 点击 .ipynb 文件直接用 Notebook 视图打开(需重载插件生效) */
	openIpynbWithPlugin: boolean;
}

const DEFAULT_SETTINGS: JupyterSettings = {
	wrap: true,
	pythonPath: '',
		pythonEnvId: '',
	openIpynbWithPlugin: true,
};

export default class JupyterNotebookPlugin extends Plugin {
	settings: JupyterSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new JupyterNotebookSettingTab(this.app, this));
		this.registerView(VIEW_TYPE_NOTEBOOK, (leaf: WorkspaceLeaf) => new NotebookView(leaf, this));

		// 点击 .ipynb 直接进 Notebook 视图。Obsidian 默认把未知扩展名当二进制，
		// 不 registerExtensions 时只能靠右键菜单/命令打开。开关切换需重载插件。
		// registerFreeExtensions:registerExtensions 整批原子,别的插件(或本插件
		// 别处)已占用 ipynb 时会抛异常打死 onload,这里跳过并记录,详见
		// extensionRegistry.ts。
		if (this.settings.openIpynbWithPlugin) {
			registerFreeExtensions(this, ['ipynb'], VIEW_TYPE_NOTEBOOK, "notebook");
		}

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

	/** 环境清单缓存(设置面板展开时用) */
	private pyEnvs: PythonEnv[] | null = null;

	discoveredPythonEnvs(force = false): PythonEnv[] {
		if (!force && this.pyEnvs) return this.pyEnvs;
		this.pyEnvs = discoverPythonEnvs();
		return this.pyEnvs;
	}

	/**
	 * 按设置决定当前生效环境:下拉选择 > 自定义路径 > 自动探测。
	 * 切换后必须销毁已运行的内核 —— 内核是有状态的,不重启就换解释器会让
	 * 「内存里的变量」凭空消失而用户不知情(registry 的注释也这么说)。
	 */
	applyPythonEnv(): void {
		const id = this.settings.pythonEnvId;
		const hit = id ? this.discoveredPythonEnvs().find((e) => e.id === id) : null;
		if (hit) {
			setActiveEnv(hit);
			setPythonInterpreterOverride(hit.cmd);
		} else {
			setActiveEnv(null);
			setPythonInterpreterOverride(this.settings.pythonPath || '');
		}
		void disposeAllKernels();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		setPythonInterpreterOverride(this.settings.pythonPath);
		this.applyPythonEnv();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** 在新标签页打开 notebook(复用已有同文件视图则聚焦) */
	/**
	 * 库外(虚拟文档树挂载)notebook:绝对路径，vault 里没有 TFile。
	 * 路径统一正斜杠（与 vault path 形态一致，view 内 cwd 提取按 '/' 切分）；
	 * 读/写走 fs（notebookView 内按 isAbsoluteFsPath 分流）。
	 */
	async openExternalNotebook(absPath: string): Promise<void> {
		const path = absPath.replace(/\\/g, '/');
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTEBOOK);
		for (const leaf of leaves) {
			const view = leaf.view as NotebookView;
			if (view.path === path) {
				this.app.workspace.setActiveLeaf(leaf, { focus: true });
				return;
			}
		}
		const leaf: WorkspaceLeaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_NOTEBOOK,
			active: true,
			state: { path },
		});
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		new Notice(`Notebook: ${path.split('/').pop() ?? path}`, 1500);
	}

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

class JupyterNotebookSettingTab extends PluginSettingTab {
	plugin: JupyterNotebookPlugin;

	constructor(app: App, plugin: JupyterNotebookPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Jupyter Notebook 设置' });

		new Setting(containerEl)
			.setName('代码编辑器自动换行')
			.setDesc('关闭后源码超出宽度时横向滚动(新单元格生效)')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.wrap).onChange(async (v) => {
					this.plugin.settings.wrap = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('点击 .ipynb 文件用 Notebook 打开')
			.setDesc('开启后文件浏览器中点击 .ipynb 直接进入 Notebook 视图(默认开)。切换后需重载本插件生效;若文件不显示,请打开设置里「检测所有文件扩展名」')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.openIpynbWithPlugin).onChange(async (v) => {
					this.plugin.settings.openIpynbWithPlugin = v;
					await this.plugin.saveSettings();
					new Notice('已保存。重载 Jupyter Notebook 插件后生效(Ctrl+P → 重载插件)');
				}),
			);

		new Setting(containerEl)
			.setName('Python 环境')
			.setDesc(
				'选择运行 notebook 的环境(conda / venv / 系统)。切换会重启已运行的内核。' +
					(this.plugin.settings.pythonEnvId ? ` 当前:${this.plugin.settings.pythonEnvId}` : ' 当前:自动探测'),
			)
			.addDropdown((dd) => {
				dd.addOption('', '自动探测(PATH → py.exe → Program Files)');
				for (const e of this.plugin.discoveredPythonEnvs()) dd.addOption(e.id, e.name);
				dd.setValue(this.plugin.settings.pythonEnvId);
				dd.onChange(async (v) => {
					this.plugin.settings.pythonEnvId = v;
					await this.plugin.saveSettings();
					this.plugin.applyPythonEnv();
					this.display();
					new Notice(v ? '已切换 Python 环境,内核将重启' : '已回到自动探测');
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon('refresh-cw')
					.setTooltip('重新扫描环境')
					.onClick(() => {
						this.plugin.discoveredPythonEnvs(true);
						this.display();
						new Notice(`已扫描到 ${this.plugin.discoveredPythonEnvs().length} 个 Python 环境`);
					}),
			);

		new Setting(containerEl)
			.setName('Python 解释器路径')
			.setDesc('留空自动探测(PATH → py.exe → Program Files)。修改后对下次启动的内核生效(已运行的内核先重启再生效)')
			.addText((text) =>
				text
					.setPlaceholder('例如 C:\\Python312\\python.exe')
					.setValue(this.plugin.settings.pythonPath)
					.onChange(async (v) => {
						this.plugin.settings.pythonPath = v;
						setPythonInterpreterOverride(v);
						await this.plugin.saveSettings();
						this.plugin.applyPythonEnv();
					}),
			);
	}
}
