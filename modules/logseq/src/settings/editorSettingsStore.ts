/**
 * 「VS Code 编辑器设置」的 settings.json 存取层。
 *
 * 用户拍板:settings.json 是编辑器设置的**唯一存储** —— 设置页 UI 与这份文件
 * 是同一数据的两个视图(同 VS Code 的设置 UI ⇄ settings.json),不进 data.json。
 * 路径:<configDir>/plugins/obsidian-my-obsidian/settings.json,即插件自己的
 * 目录(与 main.js/data.json 同层),文件可同步、可手动编辑。
 *
 * 容错:
 *  - 文件缺失 → 写入完整默认对象(用户能看到全部可用键);
 *  - JSON 损坏 → **不改写文件**(保住用户手改的内容),返回默认并带 corrupt 标记,
 *    调用方负责 Notice;下次 UI 保存时会覆盖它;
 *  - 未知键/非法值 → editorSettingsFrom 逐键清洗,非法项回退默认。
 */

import { Notice, type FileSystemAdapter, type App } from 'obsidian';
import {
  EDITOR_SETTINGS_DEFAULTS,
  editorSettingsFrom,
  setEditorSettings,
  type EditorSettings,
} from '../editor/editorSettings';
import { exists, ensureDir, readExternalText, writeExternalText } from '../features/extFs';

/** 存取层需要的宿主最小面(Plugin 满足)。 */
export interface EditorSettingsHost {
  app: App;
  manifest: { dir?: string };
}

export interface LoadEditorSettingsResult {
  settings: EditorSettings;
  /** 本次读取新建了默认文件 */
  created: boolean;
  /** 文件存在但 JSON 无法解析(已临时回退默认,原文件保留) */
  corrupt: boolean;
  /** settings.json 里未被识别的键数量 */
  unknownKeys: number;
}

let cachedHost: EditorSettingsHost | null = null;

/** null = 清除(测试用:模拟非桌面端/未初始化)。 */
export function initEditorSettingsStore(host: EditorSettingsHost | null): void {
  cachedHost = host;
}

function basePath(): string {
  const adapter = cachedHost?.app.vault.adapter as Partial<FileSystemAdapter> | undefined;
  const base = typeof adapter?.getBasePath === 'function' ? adapter.getBasePath() : '';
  if (!base) throw new Error('无法解析库根目录(仅桌面端可用)。');
  return base;
}

/** settings.json 的绝对路径;<configDir>/plugins/<插件目录>/settings.json。 */
export function settingsJsonPath(host?: EditorSettingsHost): string {
  const h = host ?? cachedHost;
  if (!h) throw new Error('编辑器设置存取层未初始化。');
  const raw = (h.manifest.dir || '').replace(/[\\/]+$/, '').replace(/\\/g, '/');
  // Obsidian 运行时的 manifest.dir 是**库根相对**的完整安装路径
  // (.obsidian/plugins/<目录名>,monaco.css 等资源路径依赖这一点);
  // 裸目录名形态(手工构造的 manifest/测试)走传统拼接兜底。
  const dir = raw.includes('.obsidian/plugins')
    ? raw
    : `${h.app.vault.configDir}/plugins/${raw || 'obsidian-my-obsidian'}`;
  return `${basePath()}/${dir}/settings.json`;
}

/** 读 settings.json(缺失即创建默认文件),并把结果写进运行态。 */
export function loadEditorSettings(host?: EditorSettingsHost): LoadEditorSettingsResult {
  const h = host ?? cachedHost;
  const fallback: LoadEditorSettingsResult = {
    settings: { ...EDITOR_SETTINGS_DEFAULTS },
    created: false,
    corrupt: false,
    unknownKeys: 0,
  };
  if (!h) return fallback;
  let path: string;
  try {
    path = settingsJsonPath(h);
  } catch {
    return fallback; // 非桌面端等:静默用默认
  }
  let created = false;
  let corrupt = false;
  let parsed: unknown = EDITOR_SETTINGS_DEFAULTS;
  if (!exists(path)) {
    try {
      writeExternalText(path, JSON.stringify(EDITOR_SETTINGS_DEFAULTS, null, 2) + '\n');
      created = true;
    } catch {
      /* 只读环境等:留在默认,不打断启动 */
    }
  } else {
    try {
      parsed = JSON.parse(readExternalText(path));
    } catch {
      corrupt = true;
      parsed = null;
    }
  }
  const { settings, unknownKeys } = editorSettingsFrom(parsed);
  setEditorSettings(settings);
  if (corrupt) new Notice('settings.json 无法解析，编辑器设置已临时回退默认。修复或保存后原文件会被覆盖。');
  if (created) ensureDir(path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))));
  return { settings, created, corrupt, unknownKeys };
}

/** 把设置写回 settings.json 并更新运行态。UI 保存与重载共用。 */
export function saveEditorSettings(settings: EditorSettings, host?: EditorSettingsHost): void {
  const h = host ?? cachedHost;
  setEditorSettings(settings);
  if (!h) return;
  try {
    const path = settingsJsonPath(h);
    ensureDir(path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))));
    writeExternalText(path, JSON.stringify(settings, null, 2) + '\n');
  } catch (e) {
    new Notice(`settings.json 写入失败：${String(e).slice(0, 120)}`);
  }
}
