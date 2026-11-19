/**
 * BRAT/裸装 bootstrap(2026-11-20):Obsidian 市场与 BRAT 都只安装
 * main.js/manifest.json/styles.css 三件套,而本插件的代码编辑器(Monaco
 * lazy 包 + workers + css)、统一搜索内核(MyKernel.cjs)、LSP(basedpyright)
 * 等是 deploy 时才落位的**运行附属**——裸装后这些能力缺失(代码文件打开
 * 空白,且 require 被吞、无报错,用户无从得知)。
 *
 * 方案 = Obsidian Terminal(polyipseity)同款先例:GitHub Release assets
 * 放 extras.zip(核心附属)/lsp.zip(basedpyright),onload 检测缺失后
 * 自动下载解压到插件目录,完成后提示重载。Bare-install 实测:启动/模块/
 * 块编辑器/HOME/虚拟树全部可用,仅附属相关能力缺——所以检测到附属齐了
 * 就完全不联网,零开销。
 *
 * 解压用 fflate(纯 JS,~30KB min):渲染进程无 shell/unzip 依赖,全平台
 * 一致。写盘走 vault.adapter.writeBinary(路径经 normalizePath)。
 */
import { Notice, normalizePath, requestUrl, type Plugin } from 'obsidian';
import { unzipSync } from 'fflate';

/** 附属完整性的探针文件(任一缺失 = 需要 bootstrap)。 */
const REQUIRED_FILES = ['lazy/monaco.js', 'monaco.css', 'monaco-workers/editor.worker.js'];

const REPO = 'alvisliu818/obsidian-my-obsidian';

/** 一个 release asset 的下载解压规格。 */
interface ZipAsset {
	/** release asset 名(= zip 内文件按原路径解到插件目录) */
	file: string;
	/** 必需(缺失即自动下载)/ 可选(下载失败仅提示) */
	required: boolean;
	/** 解压时跳过(zip 内路径前缀) */
	strip?: string;
}

const ASSETS: ZipAsset[] = [
	{ file: 'extras.zip', required: true },
	{ file: 'lsp.zip', required: false },
];

function assetUrl(version: string, file: string): string {
	return `https://github.com/${REPO}/releases/download/${version}/${file}`;
}

export function runtimeExtrasMissing(plugin: Plugin): string[] {
	const base = plugin.manifest.dir ?? '';
	return REQUIRED_FILES.filter((f) => !existsSync(base, f));
}

/** fs 直读插件目录相对路径(adapter.exists 是异步,检测要同步判定)。 */
function existsSync(base: string, rel: string): boolean {
	try {
		const adapter = pluginAdapterOf();
		const root = adapter?.full ?? adapter?.base ?? '';
		return require('node:fs').existsSync(`${root}/${base}/${rel.replace(/\//g, '\\')}`);
	} catch {
		return false;
	}
}

function pluginAdapterOf(): { full?: string; base?: string } | null {
	try {
		const app = (window as unknown as { app?: { vault?: { adapter?: { getFullPath?: (rel: string) => string; basePath?: string } } } }).app;
		const a = app?.vault?.adapter;
		if (!a) return null;
		return { full: a.getFullPath?.(''), base: a.basePath };
	} catch {
		return null;
	}
}

/**
 * 首启自动检测 + 下载(有缺失才联网;全齐立即返回 false 表示无事可做)。
 * 返回 true 表示执行了修复流程(无论成败,成败另有 Notice)。
 */
export async function bootstrapRuntimeExtras(plugin: Plugin, opts: { manual?: boolean } = {}): Promise<boolean> {
	const missing = runtimeExtrasMissing(plugin);
	if (missing.length === 0 && !opts.manual) return false;
	const adapter = plugin.app.vault.adapter as unknown as {
		writeBinary?: (p: string, data: ArrayBuffer) => Promise<void>;
		mkdir?: (p: string) => Promise<void>;
	};
	const base = plugin.manifest.dir ?? '';
	const version = plugin.manifest.version;
	let repaired = 0;
	const notice = new Notice('检测到运行组件不完整,正在下载…(首次安装,约 20MB)', 0);
	try {
		for (const asset of ASSETS) {
			const url = assetUrl(version, asset.file);
			// requestUrl 走 Electron 网络栈:渲染进程 fetch 会撞 CORS(app:// origin,
			// github.com 无 ACAO——实测),Obsidian 内置请求通道不受限,插件标准做法。
			const res = await requestUrl({ url, method: 'GET', throw: false });
			if (res.status !== 200) {
				if (asset.required) throw new Error(`${asset.file} HTTP ${res.status}`);
				continue;
			}
			const bytes = new Uint8Array(res.arrayBuffer);
			const files = unzipSync(bytes);
			for (const [name, data] of Object.entries(files)) {
				if (name.endsWith('/')) continue;
				const rel = asset.strip ? name.slice(asset.strip.length) : name;
				if (!rel || rel.startsWith('/')) continue;
				const target = normalizePath(`${base}/${rel}`);
				const parent = target.slice(0, target.lastIndexOf('/'));
				if (parent) await adapter.mkdir?.(parent);
				await adapter.writeBinary?.(target, data.buffer as ArrayBuffer);
				repaired++;
			}
			notice.setMessage(`组件下载完成(${asset.file}:${repaired} 个文件)…`);
		}
		notice.hide();
		new Notice('运行组件就绪。请重载插件以启用全部功能(Ctrl+R 或重启 Obsidian)。', 8000);
		return true;
	} catch (e) {
		notice.hide();
		new Notice(
			`运行组件下载失败:${String(e).slice(0, 120)}\n可用命令「My Obsidian: 下载运行组件」重试(GitHub 需可达)。`,
			10000,
		);
		return true;
	}
}

/** 宿主挂载入口:onload 末尾调用(自动)+ 命令(手动)。 */
export function registerRuntimeBootstrap(plugin: Plugin): void {
	// 命令:手动触发(重跑/修复)
	plugin.addCommand({
		id: 'download-runtime-extras',
		name: '下载运行组件(修复代码编辑器/LSP/搜索内核)',
		callback: () => void bootstrapRuntimeExtras(plugin, { manual: true }),
	});
	// 首启自动:布局就绪后延迟检测(避免与启动竞速),缺失才联网
	plugin.app.workspace.onLayoutReady(() => {
		if (runtimeExtrasMissing(plugin).length === 0) return;
		window.setTimeout(() => void bootstrapRuntimeExtras(plugin), 3000);
	});
}
