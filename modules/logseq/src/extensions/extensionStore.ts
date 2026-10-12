// 扩展存储层
//
// 分层存储（与参考实现"全塞插件数据"不同）：
//   - data.json 的 ext-index 字段：仅存 extensionId 列表（轻量索引，随设置读写）
//   - 每个扩展的完整数据（files + contributes + 元数据）：插件目录下
//     ext-store/<id>.json 单文件（vault adapter 读写）
// 理由：TM 语法单文件可达 1MB，全量进 data.json 会让每次 saveData 与启动
// loadData 都拖着几 MB 的 JSON；文件方案下扩展数据只在消费/管理时按需读取。

import type Plugin from '../main';
import { normalizePath } from 'obsidian';
import type { InstalledExtension } from './types';

/** data.json 里的索引字段名（与插件 settings 并存，互不干扰） */
const INDEX_KEY = 'ext-index';

/** 插件目录下扩展数据的 vault 相对路径 */
function storeDir(plugin: Plugin): string {
  return normalizePath(`.obsidian/plugins/${plugin.manifest.id}/ext-store`);
}

function storeFile(plugin: Plugin, id: string): string {
  return `${storeDir(plugin)}/${id}.json`;
}

async function readIndex(plugin: Plugin): Promise<string[]> {
  try {
    const data = (await plugin.loadData()) as Record<string, unknown> | null;
    const idx = data?.[INDEX_KEY] as { ids?: unknown } | undefined;
    if (idx && Array.isArray(idx.ids)) return idx.ids.filter((x): x is string => typeof x === 'string');
  } catch {
    // data.json 不可读时视为空索引
  }
  return [];
}

async function writeIndex(plugin: Plugin, ids: string[]): Promise<void> {
  const data = ((await plugin.loadData()) as Record<string, unknown> | null) ?? {};
  data[INDEX_KEY] = { ids };
  await plugin.saveData(data);
}

/** 读取全部已安装扩展（按索引取文件；缺失文件自动剔除索引） */
export async function loadInstalledExtensions(plugin: Plugin): Promise<InstalledExtension[]> {
  const ids = await readIndex(plugin);
  const list: InstalledExtension[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    try {
      const raw = await plugin.app.vault.adapter.read(storeFile(plugin, id));
      list.push(JSON.parse(raw) as InstalledExtension);
    } catch {
      missing.push(id);
    }
  }
  if (missing.length) await writeIndex(plugin, ids.filter((id) => !missing.includes(id)));
  return list;
}

/** 添加或更新扩展（同 id 替换旧版本），并同步索引 */
export async function addInstalledExtension(plugin: Plugin, ext: InstalledExtension): Promise<InstalledExtension[]> {
  const ids = await readIndex(plugin);
  if (!ids.includes(ext.id)) ids.push(ext.id);
  await plugin.app.vault.adapter.mkdir(storeDir(plugin));
  await plugin.app.vault.adapter.write(storeFile(plugin, ext.id), JSON.stringify(ext));
  await writeIndex(plugin, ids);
  return loadInstalledExtensions(plugin);
}

/** 移除扩展（删除数据文件 + 索引） */
export async function removeInstalledExtension(plugin: Plugin, extensionId: string): Promise<InstalledExtension[]> {
  const ids = (await readIndex(plugin)).filter((id) => id !== extensionId);
  try {
    await plugin.app.vault.adapter.remove(storeFile(plugin, extensionId));
  } catch {
    // 文件本就不存在
  }
  await writeIndex(plugin, ids);
  return loadInstalledExtensions(plugin);
}

/** 切换扩展启用/禁用 */
export async function toggleExtensionEnabled(plugin: Plugin, extensionId: string): Promise<InstalledExtension[]> {
  const ids = await readIndex(plugin);
  if (!ids.includes(extensionId)) return loadInstalledExtensions(plugin);
  const file = storeFile(plugin, extensionId);
  try {
    const ext = JSON.parse(await plugin.app.vault.adapter.read(file)) as InstalledExtension;
    ext.enabled = !ext.enabled;
    await plugin.app.vault.adapter.write(file, JSON.stringify(ext));
  } catch {
    // 数据文件损坏时不动
  }
  return loadInstalledExtensions(plugin);
}

export async function isExtensionInstalled(plugin: Plugin, extensionId: string): Promise<boolean> {
  return (await readIndex(plugin)).includes(extensionId);
}

/** 读取单个已安装扩展（供消费端按需取，避免整表读盘） */
export async function getInstalledExtension(plugin: Plugin, extensionId: string): Promise<InstalledExtension | null> {
  try {
    const raw = await plugin.app.vault.adapter.read(storeFile(plugin, extensionId));
    return JSON.parse(raw) as InstalledExtension;
  } catch {
    return null;
  }
}
