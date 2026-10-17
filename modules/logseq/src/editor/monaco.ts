/**
 * Monaco(开源 VS Code 的编辑器内核)接入层 —— 移植自 siyuan-virtual-tree
 * 的 src/editor/monaco.ts,按 Obsidian 环境适配:
 *   - worker:webpack 插件换成 esbuild 独立打包(monaco-workers/*.js),
 *     运行时经 adapter.getResourcePath 拿 app:// 资源 URL,再用 blob 包装
 *     importScripts(Obsidian 内嵌 Monaco 的成熟做法)。
 *   - 主题:读 Obsidian 的 CSS 变量(--background-primary/--text-normal),
 *     明暗由 body.theme-dark/theme-light 判定。
 *   - TS/JS worker 的语义/语法诊断按 SiYuan 的做法关闭(防深嵌套 minified
 *     代码栈溢出);着色由 Monarch tokenizer 提供,不依赖诊断。
 */

import * as monaco from 'monaco-editor';
import { normalizePath, type App } from 'obsidian';
import { registerTmGrammarForMonaco } from '../extensions/monacoGrammarBridge';
import { applyThemeByPreference, getActiveThemeName } from '../extensions/themeLoader';

let initialized = false;
let getResourcePath: ((rel: string) => string) | null = null;

/** 扩展名 → Monaco language id(与 basic-languages 内置 tokenizer 对齐) */
const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.json5': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.svg': 'xml',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.py': 'python',
  // .pyi 是 PEP 484 的类型存根,语法与 .py 一致,交给同一个 language id
  // 才能拿到 LSP 的补全/跳转(否则退化成纯文本)
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.sql': 'sql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.php': 'php',
  '.rb': 'ruby',
  // 下面这些扩展名在库内/库外代码视图的接管清单里(DEFAULT_CODE_EXTENSIONS),
  // 缺了它们会退成 plaintext —— 不但没高亮,连注释区都识别不出来
  // (buildCodeDoc 按这个 id 查注释标记表)。
  '.lua': 'lua',
  '.pl': 'perl',
  '.r': 'r',
  '.jl': 'julia',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.dart': 'dart',
  '.hs': 'haskell',
  '.erl': 'erlang',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.toml': 'toml',
  '.ini': 'ini',
  '.ps1': 'powershell',
  '.bat': 'bat',
  '.cmd': 'bat',
};

/** 围栏语言名(代码块 ```lang)→ Monaco language id */
const FENCE_MAP: Record<string, string> = {
  python: 'python',
  py: 'python',
  py3: 'python',
  javascript: 'javascript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  typescript: 'typescript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  json5: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  markdown: 'markdown',
  md: 'markdown',
  go: 'go',
  golang: 'go',
  rust: 'rust',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  csharp: 'csharp',
  cs: 'csharp',
  'c#': 'csharp',
  sql: 'sql',
  mysql: 'sql',
  postgresql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  shell: 'shell',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  php: 'php',
  ruby: 'ruby',
  rb: 'ruby',
  swift: 'swift',
  dart: 'dart',
  scala: 'scala',
  kotlin: 'kotlin',
  kt: 'kotlin',
  lua: 'lua',
  perl: 'perl',
  pl: 'perl',
  r: 'r',
  julia: 'julia',
  jl: 'julia',
  erlang: 'erlang',
  haskell: 'haskell',
  powershell: 'powershell',
  pwsh: 'powershell',
  ps1: 'powershell',
  diff: 'diff',
  patch: 'diff',
  ini: 'ini',
  toml: 'toml',
};

export function getLanguageByPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return LANG_MAP[ext] || 'plaintext';
}

export function getLanguageByFence(lang: string): string {
  return FENCE_MAP[lang.toLowerCase()] || 'plaintext';
}

// 读取 Obsidian CSS 变量
function readCSSVar(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

// 规范化颜色为 Monaco 可接受的 6 位 hex 格式(#222 → #222222)
// Monaco 的 tokenTheme 不接受 3 位 hex 缩写,会抛 "Illegal value for token color"
function normalizeColor(color: string, fallback: string): string {
  if (!color) return fallback;
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) {
    return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
  }
  if (/^#[0-9a-f]{8}$/.test(c)) return c.slice(0, 7);
  const m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) {
    const r = parseInt(m[1], 10);
    const g = parseInt(m[2], 10);
    const b = parseInt(m[3], 10);
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  return fallback;
}

// Obsidian 当前外观模式(暗色主题 → 1)
export function getCurrentMode(): 0 | 1 {
  return document.body.classList.contains('theme-dark') ? 1 : 0;
}

// worker 标签 → 文件名(Monaco 按 label 请求对应 worker)
const WORKER_FILES: Record<string, string> = {
  typescript: 'ts.worker.js',
  javascript: 'ts.worker.js',
  json: 'json.worker.js',
  css: 'css.worker.js',
  scss: 'css.worker.js',
  less: 'css.worker.js',
  html: 'html.worker.js',
  handlebars: 'html.worker.js',
  razor: 'html.worker.js',
};

/** setupMonaco 需要的插件最小面(Plugin 或其宿主视图都满足)。 */
interface MonacoPluginHost {
  app: App;
  manifest: { dir?: string };
}

let cssInjectStarted = false;

/**
 * 初始化 Monaco:worker 路径 + TS 诊断开关 + 主题 + 布局 CSS 注入。
 *
 * 两个资源路径的坑(都实测踩过):
 *  1. `adapter.getResourcePath` 是**库根相对**的——插件文件必须带
 *     `manifest.dir` 前缀,否则解析成 `<vault>/monaco.css`(404)。
 *  2. 即便路径对,`<link rel=stylesheet href="app://…">` 会被 Obsidian 的 CSP
 *     (style-src)拦下——控制台报 "violates … style-src",静默无样式。
 *     fetch 同一 URL 却 200(fetch 走 connect-src,不受 style-src 管),
 *     极具迷惑性。解法:读文件内容注入 `<style>`(内联在 'unsafe-inline' 里)。
 *     worker 的 `new Worker(blob)` 走 worker-src,不受影响,仍用 URL。
 */
export function setupMonaco(plugin: MonacoPluginHost): void {
  const dir = plugin.manifest.dir ?? '';
  const rel = (p: string) => normalizePath(dir ? `${dir}/${p}` : p);
  getResourcePath = (p: string) => plugin.app.vault.adapter.getResourcePath(rel(p));

  injectMonacoCss(plugin, rel('monaco.css'));

  (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorker(_moduleId: unknown, label: string): Worker {
      const file = WORKER_FILES[label] ?? 'editor.worker.js';
      const url = (getResourcePath as (rel: string) => string)(`monaco-workers/${file}`);
      // app:// 资源 URL 不能直接用于 new Worker(跨源),用 blob 包装 importScripts。
      const blob = new Blob([`importScripts(${JSON.stringify(url)})`], { type: 'text/javascript' });
      return new Worker(URL.createObjectURL(blob));
    },
  };

  configureTypeScriptWorker();
  applyTheme(getCurrentMode());
}

/** monaco.css 注入(只一次):读内容 → <style> 内联,绕开 CSP 的 style-src。 */
function injectMonacoCss(plugin: MonacoPluginHost, vaultRelPath: string): void {
  if (cssInjectStarted || document.getElementById('logseq-monaco-css')) {
    cssInjectStarted = true;
    return;
  }
  cssInjectStarted = true;
  void (async () => {
    try {
      const css = await plugin.app.vault.adapter.read(vaultRelPath);
      if (document.getElementById('logseq-monaco-css')) return;
      const style = document.createElement('style');
      style.id = 'logseq-monaco-css';
      style.textContent = css;
      document.head.appendChild(style);
    } catch (e) {
      console.warn('[obsidian-logseq] 注入 monaco.css 失败:', e);
      cssInjectStarted = false; // 失败允许后续重试
    }
  })();
}

// 禁用 TS/JS worker 的语义与语法诊断,避免分析深度嵌套表达式时栈溢出
// (minified 代码等);语法高亮由 Monarch tokenizer 提供,不依赖 worker 诊断
function configureTypeScriptWorker(): void {
  const ts = monaco.languages.typescript as unknown as Record<string, any>;
  const options = {
    target: 99, // ScriptTarget.ESNext
    allowNonTsExtensions: true,
    moduleResolution: 100, // ModuleResolutionKind.NodeJs
    module: 99, // ModuleKind.ESNext
    noEmit: true,
    esModuleInterop: true,
    jsx: 4, // JsxEmit.React
    allowJs: true,
    typeRoots: [] as string[],
  };
  const diag = { noSemanticValidation: true, noSyntaxValidation: true };
  if (ts?.typescriptDefaults) {
    ts.typescriptDefaults.setDiagnosticsOptions(diag);
    ts.typescriptDefaults.setCompilerOptions(options);
  }
  if (ts?.javascriptDefaults) {
    ts.javascriptDefaults.setDiagnosticsOptions(diag);
    ts.javascriptDefaults.setCompilerOptions(options);
  }
}

// 根据 Obsidian 配色定义并切换 Monaco 主题
export function applyTheme(mode: 0 | 1): void {
  const bgFallback = mode === 1 ? '#1e1e1e' : '#ffffff';
  const fgFallback = mode === 1 ? '#d4d4d4' : '#222222';
  const bg = normalizeColor(readCSSVar('--background-primary'), bgFallback);
  const fg = normalizeColor(readCSSVar('--text-normal'), fgFallback);
  const themeName = mode === 1 ? 'logseq-dark' : 'logseq-light';
  monaco.editor.defineTheme(themeName, {
    base: mode === 1 ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
    },
  });
  monaco.editor.setTheme(themeName);
}

/** 当前编辑器应使用的 Monaco 主题名：扩展主题优先，否则内置 Obsidian 配色 */
export function currentMonacoTheme(): string {
  return getActiveThemeName() ?? (getCurrentMode() === 1 ? 'logseq-dark' : 'logseq-light');
}

/**
 * 按设置偏好应用扩展代码主题（themeLoader 侧 setTheme 是全局的，会覆盖所有编辑器）。
 * 无可用扩展主题（未装/偏好 '__none__'/指定主题已被卸载）时回退内置 Obsidian 配色。
 */
export function applyCodeThemePreference(pref: string): boolean {
  if (applyThemeByPreference(pref, getCurrentMode() === 1)) return true;
  applyTheme(getCurrentMode());
  return false;
}

export interface CreateEditorOptions {
  value: string;
  language: string;
  fontSize?: number;
  wordWrap?: 'on' | 'off';
  /** 行号:代码文件开,块内代码块关(与块宽对齐) */
  lineNumbers?: boolean;
  minimap?: boolean;
  /** 高度:块内自适应内容(滚动关),文件视图撑满容器 */
  autoHeight?: boolean;
  /** 行号起点(1 基):混合视图的代码段显示真实文件行号 */
  lineNumbersStart?: number;
  /** 自定义行号映射(优先于 lineNumbersStart):Monaco 行号 n → 显示文本 */
  lineNumbersFn?: (n: number) => string;
  /** 代码折叠(默认开) */
  folding?: boolean;
  onSave?: () => void;
  onEscape?: () => void;
  /** 变更明细:混合视图按变更行归属代码区(维护区行数) */
  onChange?: (value: string, changes?: Array<{ range: { startLineNumber: number; endLineNumber: number }; text: string }>) => void;
}

// 创建编辑器实例(两个代码面共用:外部代码文件 / 块内代码块)
export function createEditor(
  container: HTMLElement,
  opts: CreateEditorOptions,
): monaco.editor.IStandaloneCodeEditor {
  // 市场扩展的 TM 语法优先:异步注册完成后实时覆盖内置 monarch tokenizer
  void registerTmGrammarForMonaco(opts.language).catch(() => {});
  const editor = monaco.editor.create(container, {
    value: opts.value,
    language: opts.language,
    theme: currentMonacoTheme(),
    fontSize: opts.fontSize ?? 13,
    wordWrap: opts.wordWrap ?? 'off',
    lineNumbers:
      opts.lineNumbers === false
        ? 'off'
        : opts.lineNumbersFn
          ? opts.lineNumbersFn
          : opts.lineNumbersStart
            ? (n: number) => String(opts.lineNumbersStart! + n - 1)
            : 'on',
    folding: opts.folding ?? true,
    minimap: { enabled: opts.minimap === true },
    automaticLayout: true,
    scrollBeyondLastLine: !opts.autoHeight,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    renderWhitespace: 'selection',
    bracketPairColorization: { enabled: true },
    padding: { top: 8, bottom: opts.autoHeight ? 8 : 24 },
  });

  if (opts.autoHeight) {
    const updateHeight = () => {
      const lineCount = editor.getModel()?.getLineCount() ?? 1;
      const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
      const pad = 16;
      container.style.height = `${lineCount * lineHeight + pad}px`;
    };
    updateHeight();
    editor.onDidChangeModelContent(updateHeight);
    editor.onDidChangeConfiguration(updateHeight);
  }

  if (opts.onSave) {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => opts.onSave?.());
  }
  if (opts.onEscape) {
    editor.addCommand(monaco.KeyCode.Escape, () => opts.onEscape?.());
  }
  if (opts.onChange) {
    const cb = opts.onChange;
    editor.onDidChangeModelContent((e) => {
      const changes = e.changes.map((c) => ({
        range: { startLineNumber: c.range.startLineNumber, endLineNumber: c.range.endLineNumber },
        text: c.text,
      }));
      cb(editor.getValue(), changes);
    });
  }

  // Obsidian/外层会拦截 Ctrl+V/C/X:编辑器持焦时在 capture 阶段接管剪贴板
  // (SiYuan 侧同款修复:拦 keydown 后走 navigator.clipboard + executeEdits)
  const isEditorFocused = (): boolean => {
    if (editor.hasTextFocus()) return true;
    const active = document.activeElement;
    return !!(active && container.contains(active));
  };
  const doPaste = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const selection = editor.getSelection();
        if (selection) {
          editor.executeEdits('paste', [{ range: selection, text, forceMoveMarkers: true }]);
          editor.pushUndoStop();
        }
      }
    } catch {
      try { document.execCommand('paste'); } catch { /* 忽略 */ }
    }
  };
  const doCopy = async (cut: boolean): Promise<void> => {
    const selection = editor.getSelection();
    if (!selection || selection.isEmpty()) return;
    const text = editor.getModel()?.getValueInRange(selection) || '';
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      console.warn('[obsidian-logseq] 剪贴板写入失败:', e);
    }
    if (cut) {
      editor.executeEdits('cut', [{ range: selection, text: '', forceMoveMarkers: true }]);
      editor.pushUndoStop();
    }
  };
  const keydownHandler = (e: KeyboardEvent): void => {
    if (!isEditorFocused()) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key === 'v') {
      e.preventDefault();
      e.stopImmediatePropagation();
      void doPaste();
    } else if (key === 'c') {
      e.preventDefault();
      e.stopImmediatePropagation();
      void doCopy(false);
    } else if (key === 'x') {
      e.preventDefault();
      e.stopImmediatePropagation();
      void doCopy(true);
    }
  };
  window.addEventListener('keydown', keydownHandler, true);
  editor.onDidDispose(() => {
    window.removeEventListener('keydown', keydownHandler, true);
  });

  return editor;
}

// 全局清理(onunload 时调用)
export function disposeMonaco(): void {
  initialized = false;
}

// 把 minimap 开关即时应用到所有已打开的编辑器(设置保存后调用)
export function applyMinimapSetting(enabled: boolean): void {
  try {
    monaco.editor.getEditors().forEach(ed => {
      ed.updateOptions({ minimap: { enabled } });
    });
  } catch (e) {
    console.warn('[obsidian-logseq] 应用 minimap 设置失败:', e);
  }
}

export { initialized };
