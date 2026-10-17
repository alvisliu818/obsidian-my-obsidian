// 扩展管理器：统筹安装、卸载、重装、启停、搜索与加载。
// 对齐 siyuan-virtual-tree extension-manager，存储与网络换为 Obsidian 适配层。
// 消费端（TextMate 引擎等）经 registerLoadCallback 解耦：扩展安装/启停/
// 恢复后回调消费端，由其决定加载什么（本插件当前为 TM 语法注册）。

import type { ExtensionSource, InstalledExtension, LoadResult, SearchEntry, SearchResult } from './types';
import { downloadMarketplaceVsix, downloadOpenVsxVsix, getMarketplaceLatestVersion, getOpenVsxMetadata, searchMarketplace, searchOpenVsx } from './marketClient';
import { parseVsix } from './vsixLoader';
import { addInstalledExtension, loadInstalledExtensions, removeInstalledExtension, toggleExtensionEnabled } from './extensionStore';
import { loadIconThemes, removeExtensionIconThemes } from './iconThemeLoader';
import { loadThemes, removeExtensionThemes } from './themeLoader';
import { loadSnippets, removeExtensionSnippets } from './snippetLoader';
import type Plugin from '../main';

/** 消费端回调：扩展数据变化（安装/启用/禁用/启动恢复）后触发 */
type ConsumeFn = (ext: InstalledExtension, action: 'install' | 'enable' | 'disable' | 'restore') => void;
let consumeFn: ConsumeFn | null = null;

/** 消费端注册（tmEngine 在 onload 时调用） */
export function registerExtensionConsumer(fn: ConsumeFn | null): void {
  consumeFn = fn;
}

/** 三类贡献点计数（供 LoadResult 回填） */
interface ContributionCounts {
  themes: number;
  snippets: number;
  iconThemes: number;
}

// 语法之外的三类贡献点（图标主题 / 颜色主题 / 代码片段）由本模块直接加载：
// 语法走 consumeFn 是因为它要等 TextMate 引擎的 onig wasm 就绪，而这三类的
// loader 只操作 Monaco 与内存，无需预热。
function applyOtherContributions(
  ext: InstalledExtension,
  action: 'install' | 'enable' | 'disable' | 'restore',
): ContributionCounts {
  if (action === 'disable') {
    removeExtensionIconThemes(ext.id);
    removeExtensionThemes(ext.id);
    removeExtensionSnippets(ext.id);
    return { themes: 0, snippets: 0, iconThemes: 0 };
  }
  return {
    iconThemes: loadIconThemes(ext),
    themes: loadThemes(ext),
    snippets: loadSnippets(ext),
  };
}

// ------------------------------------------------------------------
// 搜索（按来源分发，结果标注来源）

export async function search(query: string, size = 20, source: ExtensionSource = 'openvsx'): Promise<SearchResult> {
  if (source === 'vscode-marketplace') {
    const result = await searchMarketplace(query, size);
    for (const e of result.extensions) e.source = 'vscode-marketplace';
    return result;
  }
  const result = await searchOpenVsx(query, size);
  for (const e of result.extensions) e.source = 'openvsx';
  return result;
}

// ------------------------------------------------------------------
// 安装

/** 安装扩展：按来源下载 → 解析 → 存储 →（若启用）通知消费端 */
export async function installExtension(
  plugin: Plugin,
  namespace: string,
  extensionName: string,
  source: ExtensionSource = 'openvsx',
  version?: string,
): Promise<InstalledExtension> {
  let vsixBuffer: ArrayBuffer;
  let resolvedVersion: string;

  if (source === 'vscode-marketplace') {
    resolvedVersion = version || (await getMarketplaceLatestVersion(namespace, extensionName));
    vsixBuffer = await downloadMarketplaceVsix(namespace, extensionName, resolvedVersion);
  } else {
    const metadata = await getOpenVsxMetadata(namespace, extensionName);
    resolvedVersion = version || String(metadata.version ?? '0.0.0');
    const downloadLink = metadata.files?.download;
    if (!downloadLink) throw new Error('扩展无下载链接');
    vsixBuffer = await downloadOpenVsxVsix(downloadLink);
  }

  const ext = await parseVsix(vsixBuffer, namespace, extensionName, resolvedVersion);
  ext.source = source;
  await addInstalledExtension(plugin, ext);
  if (ext.enabled) {
    // 先加载主题/图标/片段，后通知消费端：消费端可能按偏好立即应用主题，
    // 顺序反了会让刚装的贡献点对偏好应用不可见。
    applyOtherContributions(ext, 'install');
    consumeFn?.(ext, 'install');
  }
  return ext;
}

/** 通过搜索结果项安装（自动按 entry.source 分发） */
export async function installFromSearchEntry(plugin: Plugin, entry: SearchEntry): Promise<InstalledExtension> {
  return installExtension(plugin, entry.namespace, entry.name, entry.source ?? 'openvsx', entry.version);
}

// ------------------------------------------------------------------
// 卸载 / 重装 / 启停

export async function uninstallExtension(plugin: Plugin, extensionId: string): Promise<InstalledExtension[]> {
  const list = await loadInstalledExtensions(plugin);
  const ext = list.find((e) => e.id === extensionId);
  // 通知消费端按禁用清理（若此前启用）
  if (ext?.enabled) {
    consumeFn?.(ext, 'disable');
    applyOtherContributions(ext, 'disable');
  }
  return removeInstalledExtension(plugin, extensionId);
}

/** 重装：按记录的来源与版本重新下载解包（修复历史安装文件缺失） */
export async function reinstallExtension(plugin: Plugin, extensionId: string): Promise<InstalledExtension> {
  const list = await loadInstalledExtensions(plugin);
  const ext = list.find((e) => e.id === extensionId);
  if (!ext) throw new Error(`未找到已安装扩展: ${extensionId}`);
  await removeInstalledExtension(plugin, extensionId);
  const fresh = await installExtension(plugin, ext.namespace, ext.name, ext.source ?? 'openvsx', ext.version);
  // 重装保留原启停状态
  if (!ext.enabled && fresh.enabled) await toggleExtension(plugin, extensionId);
  return fresh;
}

/** 启用/禁用切换，返回新状态 */
export async function toggleExtension(plugin: Plugin, extensionId: string): Promise<boolean> {
  const list = await loadInstalledExtensions(plugin);
  const before = list.find((e) => e.id === extensionId);
  const next = await toggleExtensionEnabled(plugin, extensionId);
  const ext = next.find((e) => e.id === extensionId);
  if (ext) {
    const action = ext.enabled ? 'enable' : 'disable';
    consumeFn?.(ext, action);
    applyOtherContributions(ext, action);
  }
  void before;
  return ext ? ext.enabled : false;
}

// ------------------------------------------------------------------
// 查询 / 启动恢复

export async function getInstalledExtensions(plugin: Plugin): Promise<InstalledExtension[]> {
  return loadInstalledExtensions(plugin);
}

/** 启动恢复：通知消费端加载全部已启用扩展（不加载内容到内存之外的副作用由消费端决定） */
export async function restoreAllExtensions(plugin: Plugin): Promise<LoadResult[]> {
  const list = await loadInstalledExtensions(plugin);
  return list
    .filter((e) => e.enabled)
    .map((ext) => {
      try {
        consumeFn?.(ext, 'restore');
        const counts = applyOtherContributions(ext, 'restore');
        return {
          extensionId: ext.id,
          status: 'loaded' as const,
          loadedGrammars: ext.contributes.grammars?.length ?? 0,
          loadedThemes: counts.themes,
          loadedSnippets: counts.snippets,
          loadedIconThemes: counts.iconThemes,
        };
      } catch (e) {
        return { extensionId: ext.id, status: 'error' as const, message: String(e), loadedGrammars: 0, loadedThemes: 0, loadedSnippets: 0, loadedIconThemes: 0 };
      }
    });
}
