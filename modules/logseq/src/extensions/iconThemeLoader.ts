// 文件图标主题加载器：解析 VSCode iconTheme JSON，把 SVG 图标暴露给文件树/挂载树。
// 移植自 siyuan-virtual-tree icon-theme-loader（结构与解析规则保持一致）。
//
// VSCode iconTheme JSON 结构:
//   {
//     "iconDefinitions": {
//       "folder": { "iconPath": "./icons/folder.svg" },
//       "typescript": { "iconPath": "./icons/file_type_typescript.svg" }
//     },
//     "folder": "folder",
//     "file": "file",
//     "fileExtensions": { "ts": "typescript" },
//     "fileNames": { "package.json": "npm" },
//     "languageIds": { "typescript": "typescript" }
//   }
//
// 时机说明：扩展在插件 onload 后异步恢复，而挂载树/面板可能更早渲染，
// 那时 getFileIconFor() 恒为 null（画默认图标）。ICON_THEME_CHANGED_EVENT
// 让"图标主题就绪/切换"能被已渲染界面听到并重绘。
import type { InstalledExtension } from './types';

export const ICON_THEME_CHANGED_EVENT = 'lgp:icon-theme-changed';
const ICON_CACHE_KEY = 'lgp-icon-theme-cache-v1';

function notifyIconThemeChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(ICON_THEME_CHANGED_EVENT));
  } catch {
    // 非浏览器环境忽略
  }
}

interface LoadedIconTheme {
  extensionId: string;
  label: string;
  /** iconDefinition name → SVG data URI */
  icons: Map<string, string>;
  folderIcon?: string;
  folderExpandedIcon?: string;
  fileIcon?: string;
  fileExtensions: Map<string, string>;
  fileNames: Map<string, string>;
  languageIds: Map<string, string>;
  folderNames: Map<string, string>;
  folderNamesExpanded: Map<string, string>;
  /** 声明了图标定义却一个都没解析出来（安装数据缺 SVG，需重装扩展） */
  iconsMissing?: boolean;
}

let activeIconTheme: LoadedIconTheme | null = null;
const loadedIconThemes: LoadedIconTheme[] = [];

function mapToObj(m: Map<string, string>): Record<string, string> {
  const o: Record<string, string> = {};
  m.forEach((v, k) => {
    o[k] = v;
  });
  return o;
}

function objToMap(o: any): Map<string, string> {
  const m = new Map<string, string>();
  if (o) for (const [k, v] of Object.entries(o)) m.set(String(k).toLowerCase(), String(v));
  return m;
}

function serializeTheme(t: LoadedIconTheme): any {
  return {
    extensionId: t.extensionId,
    label: t.label,
    folderIcon: t.folderIcon || '',
    folderExpandedIcon: t.folderExpandedIcon || '',
    fileIcon: t.fileIcon || '',
    icons: mapToObj(t.icons),
    fileExtensions: mapToObj(t.fileExtensions),
    fileNames: mapToObj(t.fileNames),
    languageIds: mapToObj(t.languageIds),
    folderNames: mapToObj(t.folderNames),
    folderNamesExpanded: mapToObj(t.folderNamesExpanded),
  };
}

function deserializeTheme(o: any): LoadedIconTheme | null {
  try {
    if (!o || typeof o !== 'object' || !o.icons) return null;
    return {
      extensionId: String(o.extensionId || ''),
      label: String(o.label || ''),
      icons: objToMap(o.icons),
      folderIcon: o.folderIcon || undefined,
      folderExpandedIcon: o.folderExpandedIcon || undefined,
      fileIcon: o.fileIcon || undefined,
      fileExtensions: objToMap(o.fileExtensions),
      fileNames: objToMap(o.fileNames),
      languageIds: objToMap(o.languageIds),
      folderNames: objToMap(o.folderNames),
      folderNamesExpanded: objToMap(o.folderNamesExpanded),
    };
  } catch {
    return null;
  }
}

function persistIconThemeSnapshot(): void {
  try {
    if (!activeIconTheme) {
      window.localStorage.removeItem(ICON_CACHE_KEY);
      return;
    }
    window.localStorage.setItem(ICON_CACHE_KEY, JSON.stringify(serializeTheme(activeIconTheme)));
  } catch {
    // 配额超限等：忽略，下次启动退化为默认图标
  }
}

// 模块加载即同步 seed（早于任何界面渲染）
(function seedIconThemeFromCache(): void {
  try {
    const raw = window.localStorage.getItem(ICON_CACHE_KEY);
    if (!raw) return;
    const t = deserializeTheme(JSON.parse(raw));
    if (t && t.icons.size > 0) activeIconTheme = t;
  } catch {
    // 快照损坏则忽略，等真主题加载
  }
})();

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\//, '');
}

function getBasePath(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

/** 解析相对路径（处理 . 与 ..），返回相对于 extension 根的规范化路径 */
function resolveRelativePath(baseDir: string, relPath: string): string {
  const normalized = normalizePath(relPath);
  const parts = normalized.split('/');
  const result = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const part of parts) {
    if (part === '..') result.pop();
    else if (part !== '.') result.push(part);
  }
  return result.join('/');
}

function svgToDataUri(svg: string): string {
  // encodeURIComponent 比 base64 更小；去掉 XML 声明与注释
  const cleaned = svg.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  return `data:image/svg+xml,${encodeURIComponent(cleaned)}`;
}

function mapToMap(obj: Record<string, string> | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (obj) {
    for (const [k, v] of Object.entries(obj)) m.set(k.toLowerCase(), v);
  }
  return m;
}

function parseIconTheme(themeData: any, extension: InstalledExtension, themePath: string): LoadedIconTheme {
  const icons = new Map<string, string>();
  const iconDefs = themeData.iconDefinitions || {};
  const themeDir = getBasePath(themePath); // 主题文件目录（相对 extension 根）

  for (const [name, def] of Object.entries(iconDefs) as [string, any][]) {
    if (def.iconPath) {
      // iconPath 相对主题文件目录解析，需与 vsixLoader 的存储路径一致
      const iconRelPath = resolveRelativePath(themeDir, def.iconPath);
      const svgContent = extension.files[iconRelPath];
      if (svgContent) icons.set(name, svgToDataUri(svgContent));
    }
  }

  return {
    extensionId: '',
    label: '',
    icons,
    folderIcon: themeData.folder,
    folderExpandedIcon: themeData.folderExpanded,
    fileIcon: themeData.file,
    fileExtensions: mapToMap(themeData.fileExtensions),
    fileNames: mapToMap(themeData.fileNames),
    languageIds: mapToMap(themeData.languageIds),
    folderNames: mapToMap(themeData.folderNames),
    folderNamesExpanded: mapToMap(themeData.folderNamesExpanded),
  };
}

/** 加载扩展的图标主题贡献，返回加载的主题数（重复调用先清理旧的，幂等） */
export function loadIconThemes(extension: InstalledExtension): number {
  removeExtensionIconThemes(extension.id);

  const contributes = extension.contributes;
  if (!contributes?.iconThemes || contributes.iconThemes.length === 0) return 0;

  let count = 0;
  for (const iconThemeContribution of contributes.iconThemes) {
    try {
      const themePath = normalizePath(iconThemeContribution.path);
      const content = extension.files[themePath];
      if (!content) continue;
      const themeData = JSON.parse(content);
      const theme = parseIconTheme(themeData, extension, themePath);
      theme.extensionId = extension.id;
      theme.label = iconThemeContribution.label;
      // 声明了图标定义却一个都没解析出来 → 安装数据缺 SVG（旧版安装/解包失败）
      theme.iconsMissing =
        Object.keys(themeData.iconDefinitions || {}).length > 0 && theme.icons.size === 0;
      loadedIconThemes.push(theme);
      count++;
      // 第一个加载的图标主题自动激活
      if (!activeIconTheme) activeIconTheme = theme;
    } catch {
      // 单个主题损坏不影响其余
    }
  }
  return count;
}

/** 文件夹图标（先按文件夹名匹配，再回退默认；展开态可不同） */
export function getFolderIcon(name?: string, expanded?: boolean): string | null {
  if (!activeIconTheme) return null;

  if (name) {
    const lowerName = name.toLowerCase();
    const folderNameMap = expanded ? activeIconTheme.folderNamesExpanded : activeIconTheme.folderNames;
    const nameIcon = folderNameMap.get(lowerName);
    if (nameIcon) {
      const icon = activeIconTheme.icons.get(nameIcon);
      if (icon) return icon;
    }
  }

  const defaultIconKey = expanded ? activeIconTheme.folderExpandedIcon : activeIconTheme.folderIcon;
  if (defaultIconKey) {
    const icon = activeIconTheme.icons.get(defaultIconKey);
    if (icon) return icon;
  }

  // 展开态图标不存在时回退折叠态
  if (expanded && activeIconTheme.folderIcon) {
    const icon = activeIconTheme.icons.get(activeIconTheme.folderIcon);
    if (icon) return icon;
  }
  return null;
}

/** 文件图标（文件名 → 扩展名 → 默认文件图标） */
export function getFileIconFor(name: string): string | null {
  if (!activeIconTheme) return null;
  const lowerName = name.toLowerCase();

  const fileNameIcon = activeIconTheme.fileNames.get(lowerName);
  if (fileNameIcon) {
    const icon = activeIconTheme.icons.get(fileNameIcon);
    if (icon) return icon;
  }

  const dotIdx = name.lastIndexOf('.');
  if (dotIdx > 0) {
    const ext = name.slice(dotIdx + 1).toLowerCase();
    const extIcon = activeIconTheme.fileExtensions.get(ext);
    if (extIcon) {
      const icon = activeIconTheme.icons.get(extIcon);
      if (icon) return icon;
    }
  }

  if (activeIconTheme.fileIcon) {
    const icon = activeIconTheme.icons.get(activeIconTheme.fileIcon);
    if (icon) return icon;
  }
  return null;
}

export function hasActiveIconTheme(): boolean {
  return activeIconTheme !== null;
}

export function getLoadedIconThemes(): { extensionId: string; label: string }[] {
  return loadedIconThemes.map((t) => ({ extensionId: t.extensionId, label: t.label }));
}

/** 声明了图标定义但 SVG 全部缺失的主题（安装数据不完整，需重装扩展） */
export function getIconThemesWithMissingIcons(): { extensionId: string; label: string }[] {
  return loadedIconThemes.filter((t) => t.iconsMissing).map((t) => ({ extensionId: t.extensionId, label: t.label }));
}

export function activateIconTheme(extensionId: string): boolean {
  const theme = loadedIconThemes.find((t) => t.extensionId === extensionId);
  if (theme) {
    activeIconTheme = theme;
    return true;
  }
  return false;
}

/** 按用户偏好激活
 * pref: '' = 自动（第一个）；'__none__' = 不使用扩展图标主题；其他 = 扩展 id
 * 返回是否激活了扩展图标主题（调用方据此决定是否刷新文件树） */
export function activateIconThemeByPreference(pref: string): boolean {
  if (pref === '__none__') {
    activeIconTheme = null;
    persistIconThemeSnapshot();
    notifyIconThemeChanged();
    return false;
  }
  if (pref) {
    if (activateIconTheme(pref)) {
      persistIconThemeSnapshot();
      notifyIconThemeChanged();
      return true;
    }
    // 指定主题已不存在（扩展被卸载）→ 回退自动
  }
  activeIconTheme = loadedIconThemes.length > 0 ? loadedIconThemes[0] : null;
  persistIconThemeSnapshot();
  notifyIconThemeChanged();
  return activeIconTheme !== null;
}

export function getActiveIconThemeId(): string | null {
  return activeIconTheme ? activeIconTheme.extensionId : null;
}

/** 移除扩展的图标主题（禁用/卸载时调用） */
export function removeExtensionIconThemes(extensionId: string): void {
  const idx = loadedIconThemes.findIndex((t) => t.extensionId === extensionId);
  if (idx >= 0) {
    // 移除的是当前激活主题时回退到第一个
    if (activeIconTheme?.extensionId === extensionId) {
      activeIconTheme = loadedIconThemes.find((t) => t.extensionId !== extensionId) || null;
    }
    loadedIconThemes.splice(idx, 1);
    persistIconThemeSnapshot();
    notifyIconThemeChanged();
  }
}

/** 清理所有图标主题 */
export function clearAllIconThemes(): void {
  loadedIconThemes.length = 0;
  activeIconTheme = null;
  persistIconThemeSnapshot();
}
