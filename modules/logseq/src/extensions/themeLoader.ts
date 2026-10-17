// 颜色主题加载器：VSCode 扩展的 theme JSON → Monaco 主题（defineTheme）。
// 移植自 siyuan-virtual-tree theme-loader。
//
// 与思源侧的差异：这里只 defineTheme，不在加载时自动 setTheme —— 聚合插件自己
// 管理代码编辑器主题，自动切换会覆盖用户在设置里选的配色。应用时机交给调用方
// （设置项/市场 UI）显式触发 applyExtensionTheme / applyThemeByPreference。
import * as monaco from 'monaco-editor';
import type { InstalledExtension } from './types';

export interface LoadedTheme {
  extensionId: string;
  label: string;
  /** Monaco base 主题 */
  base: 'vs' | 'vs-dark';
  /** 注册到 Monaco 的主题名 */
  name: string;
}

const loadedThemes: LoadedTheme[] = [];
let activeThemeName: string | null = null;

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\//, '');
}

/** 加载扩展的颜色主题贡献，返回注册的主题数（重复调用先清理旧的，幂等） */
export function loadThemes(extension: InstalledExtension): number {
  removeExtensionThemes(extension.id);

  const contributes = extension.contributes;
  if (!contributes?.themes || contributes.themes.length === 0) return 0;

  let count = 0;
  for (const themeContribution of contributes.themes) {
    try {
      const content = extension.files[normalizePath(themeContribution.path)];
      if (!content) continue;
      const themeData = JSON.parse(content);
      const themeName = `ext-${extension.id}-${themeContribution.label}`.replace(/[^a-zA-Z0-9-]/g, '-');
      const base: 'vs' | 'vs-dark' =
        themeContribution.uiTheme === 'vs' || themeData.type === 'light' ? 'vs' : 'vs-dark';

      convertThemeToMonaco(themeData, themeName, base);
      loadedThemes.push({
        extensionId: extension.id,
        label: themeContribution.label,
        base,
        name: themeName,
      });
      count++;
    } catch {
      // 单个主题损坏不影响其余
    }
  }
  return count;
}

/** 应用主题（Monaco 延迟校验颜色，失败时回退内置并清空记录） */
function safeSetTheme(themeName: string): boolean {
  try {
    monaco.editor.setTheme(themeName);
    activeThemeName = themeName;
    return true;
  } catch {
    activeThemeName = null;
    try {
      monaco.editor.setTheme('vs-dark');
    } catch {
      // 忽略
    }
    return false;
  }
}

/** 将 VSCode 主题转换为 Monaco 主题 */
function convertThemeToMonaco(themeData: any, themeName: string, base: 'vs' | 'vs-dark'): void {
  const colors: Record<string, string> = {};
  const rules: monaco.editor.ITokenThemeRule[] = [];

  // 编辑器颜色：走 Monaco 的 CSS 生成路径，支持带 alpha 的 8 位 hex
  //（主题常用半透明叠加，如 lineHighlightBackground=#383A420C，截断会变纯黑）
  if (themeData.colors) {
    const setColor = (key: string, vscodeKey: string) => {
      const v = themeData.colors[vscodeKey];
      if (v) {
        const normalized = normalizeHex(v, true);
        if (normalized) colors[key] = normalized;
      }
    };
    setColor('editor.background', 'editor.background');
    setColor('editor.foreground', 'editor.foreground');
    setColor('editor.selectionBackground', 'editor.selectionBackground');
    setColor('editor.lineHighlightBackground', 'editor.lineHighlightBackground');
  }

  if (themeData.tokenColors) {
    for (const tokenColor of themeData.tokenColors) {
      const rawScopes = Array.isArray(tokenColor.scope) ? tokenColor.scope : [tokenColor.scope];
      const settings = tokenColor.settings || {};
      const foreground = settings.foreground ? normalizeHex(settings.foreground) : '';
      const fontStyle = settings.fontStyle;
      for (const rawScope of rawScopes) {
        if (!rawScope || typeof rawScope !== 'string') continue;
        // scope 可能是逗号/空格分隔的多个选择器；TextMate 里空格表示嵌套，
        // Monaco 不支持，拆成独立 scope 分别注册（近似匹配）
        for (const scope of rawScope.split(/[\s,]+/).filter(Boolean)) {
          if (foreground) {
            rules.push({ token: scope, foreground, fontStyle: fontStyle as any });
          }
        }
      }
    }
  }

  monaco.editor.defineTheme(themeName, { base, inherit: true, rules, colors });
}

/** 规范化颜色为 hex（无法识别时返回 ''，调用方据此跳过） */
// allowAlpha=false（token 规则用）：输出 6 位 hex，丢弃 alpha —— Monaco token
//   前景色只接受 #RRGGBB
// allowAlpha=true（editor 颜色用）：输出 6 或 8 位 hex，保留 alpha
function normalizeHex(color: string, allowAlpha: boolean = false): string {
  if (!color) return '';
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{8}$/.test(c)) return allowAlpha ? c : c.slice(0, 7);
  if (/^#[0-9a-f]{3}$/.test(c)) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  }
  if (/^#[0-9a-f]{4}$/.test(c)) {
    const [r, g, b, a] = [c[1], c[2], c[3], c[4]];
    return allowAlpha ? `#${r}${r}${g}${g}${b}${b}${a}${a}` : `#${r}${r}${g}${g}${b}${b}`;
  }
  const named: Record<string, string> = {
    white: '#ffffff',
    black: '#000000',
    red: '#ff0000',
    green: '#008000',
    blue: '#0000ff',
    yellow: '#ffff00',
    transparent: '',
  };
  if (c in named) return named[c];
  const m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) {
    const hex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    return `#${hex(+m[1])}${hex(+m[2])}${hex(+m[3])}`;
  }
  return '';
}

export function getActiveThemeName(): string | null {
  return activeThemeName;
}

export function getLoadedThemes(): LoadedTheme[] {
  return loadedThemes;
}

export function hasExtensionThemes(): boolean {
  return loadedThemes.length > 0;
}

/** 应用指定主题（name 为 Monaco 主题名） */
export function applyExtensionTheme(themeName: string): boolean {
  const exists = loadedThemes.some((t) => t.name === themeName);
  if (exists) return safeSetTheme(themeName);
  return false;
}

/** 自动应用第一个匹配当前明暗模式的扩展主题 */
export function applyFirstExtensionTheme(isDark: boolean): boolean {
  if (loadedThemes.length === 0) return false;
  const targetBase = isDark ? 'vs-dark' : 'vs';
  const matched = loadedThemes.find((t) => t.base === targetBase) || loadedThemes[0];
  return safeSetTheme(matched.name);
}

/** 按用户偏好应用代码主题
 * pref: '' = 自动（优先扩展主题）；'__none__' = 不用扩展主题；其他 = Monaco 主题名
 * 返回 false 表示调用方需回退到自己的配色 */
export function applyThemeByPreference(pref: string, isDark: boolean): boolean {
  if (pref === '__none__') {
    activeThemeName = null;
    return false;
  }
  if (pref) {
    const matched = loadedThemes.find((t) => t.name === pref);
    if (matched) return safeSetTheme(matched.name);
    // 指定主题已不存在（扩展被卸载）→ 回退自动
  }
  return applyFirstExtensionTheme(isDark);
}

/** 移除扩展的主题（禁用/卸载时调用） */
export function removeExtensionThemes(extensionId: string): void {
  for (let i = loadedThemes.length - 1; i >= 0; i--) {
    if (loadedThemes[i].extensionId === extensionId) loadedThemes.splice(i, 1);
  }
  // 激活主题属于被移除的扩展时清空记录（调用方负责重新应用回退主题）
  if (activeThemeName && !loadedThemes.some((t) => t.name === activeThemeName)) {
    activeThemeName = null;
  }
}

/** 清理所有主题 */
export function clearAllThemes(): void {
  loadedThemes.length = 0;
  activeThemeName = null;
}
