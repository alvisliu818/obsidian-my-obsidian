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
 * 浮层(补全建议 / hover 提示 / 查找框)的外挂宿主。
 *
 * 坑:这些浮层默认渲染在 `.monaco-editor` 内部,而块内代码块上面压着三层
 * 裁剪 —— `.lgp-code-block .monaco-editor{overflow:hidden}`(圆角需要)、
 * `.block-editor-scroller{overflow:auto}`(大纲滚动容器)、
 * `.workspace-leaf{contain:strict}`。实测补全是**渲染出来了但被裁掉**:
 * 建议框一超过编辑器高度就消失,看着像"没弹出来"。
 *
 * Monaco 给的官方解法就是 `overflowWidgetsDomNode`:把会溢出的浮层挂到
 * 一个裁剪链之外的节点上(VS Code 自己就这么干)。挂 document.body 下、
 * position:absolute,Monaco 用视口坐标定位它。
 */
let overflowWidgetsHost: HTMLElement | null = null;

function getOverflowWidgetsDomNode(): HTMLElement {
  if (overflowWidgetsHost?.isConnected) return overflowWidgetsHost;
  const el = document.createElement('div');
  el.className = 'lgp-monaco-overflow';
  document.body.appendChild(el);
  overflowWidgetsHost = el;
  return el;
}

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

  // 一次性初始化。阅读态每个代码块都会建实例、都会走到这里,而 setTheme
  // 会对**所有已建编辑器**重放全部令牌色 —— 重复调用是 O(编辑器数²) 的
  // (几十个代码块的文档直接把主线程拖死),所以必须只做一次。
  // 主题后续变化走 applyTheme / applyCodeThemePreference,不经这里。
  if (initialized) return;
  initialized = true;

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

// 根据 Obsidian 配色定义并切换 Monaco 主题。
//
// token 规则复刻阅读态的配色(见 styles.css 的 `.token.* → --code-*` 映射):
// 阅读(MarkdownRenderer → Prism)与编辑(Monaco)共用同一组 --code-* 变量,
 // 两种状态的代码颜色才一致——此前内置主题 rules 为空,Monaco 落回 vs 基础色
// (字符串绿、关键字蓝),与阅读态(粉关键字/橙字符串)对不上,即用户报告的
// 「代码渲染也不一样」。变量本身随明暗模式变,所以 light/dark 用同一组规则。
// 规则形状对照 Prism 类名 → Obsidian 变量(见 app.css):
//   comment→--code-comment  string→--code-string  keyword→--code-keyword
//   number→--code-value     operator→--code-operator  delimiter→--code-punctuation
//   tag→--code-tag          type.identifier(class-name)→--code-function
//   其余(identifier 等)→--code-normal;attr-name → 正常色(Obsidian 的
//   .token.attr-name 走未定义的 --code-attribute,回退 inherit)。
export function applyTheme(mode: 0 | 1): void {
  const bgFallback = mode === 1 ? '#1e1e1e' : '#ffffff';
  const fgFallback = mode === 1 ? '#d4d4d4' : '#222222';
  const bg = normalizeColor(readCSSVar('--background-primary'), bgFallback);
  const fg = normalizeColor(readCSSVar('--text-normal'), fgFallback);
  const codeFg = normalizeColor(readCSSVar('--code-normal'), fg);
  const c = (name: string, fallback: string): string => normalizeColor(readCSSVar(name), fallback);
  const stringC = c('--code-string', mode === 1 ? '#ce9178' : '#a31515');
  const tagC = c('--code-tag', mode === 1 ? '#569cd6' : '#800000');
  const rules: monaco.editor.ITokenThemeRule[] = [
    { token: '', foreground: codeFg },
    { token: 'identifier', foreground: codeFg },
    { token: 'comment', foreground: c('--code-comment', mode === 1 ? '#6a9955' : '#237e38') },
    { token: 'string', foreground: stringC },
    { token: 'keyword', foreground: c('--code-keyword', mode === 1 ? '#c586c0' : '#0000ff') },
    { token: 'number', foreground: c('--code-value', mode === 1 ? '#b5cea8' : '#098658') },
    { token: 'regexp', foreground: c('--code-important', mode === 1 ? '#d16969' : '#811f3f') },
    { token: 'operator', foreground: c('--code-operator', mode === 1 ? '#d4d4d4' : '#333333') },
    { token: 'delimiter', foreground: c('--code-punctuation', mode === 1 ? '#808080' : '#666666') },
    { token: 'tag', foreground: tagC },
    { token: 'metatag', foreground: tagC },
    { token: 'attribute.name', foreground: codeFg },
    { token: 'attribute.value', foreground: stringC },
    { token: 'type.identifier', foreground: c('--code-function', mode === 1 ? '#dcdcaa' : '#795e26') },
  ];
  const themeName = mode === 1 ? 'logseq-dark' : 'logseq-light';
  monaco.editor.defineTheme(themeName, {
    base: mode === 1 ? 'vs-dark' : 'vs',
    inherit: true,
    rules,
    colors: {
      'editor.background': bg,
      'editor.foreground': codeFg,
    },
  });
  monaco.editor.setTheme(themeName);
}

/** 当前编辑器应使用的 Monaco 主题名：扩展主题优先，否则内置 Obsidian 配色 */
export function currentMonacoTheme(): string {
  return getActiveThemeName() ?? (getCurrentMode() === 1 ? 'logseq-dark' : 'logseq-light');
}

/**
 * 阅读态静态着色:与编辑器**同一个** Monarch 分词器 + 同一套主题规则
 * (colorize 产出带 mtk 类的 HTML,颜色由主题服务注入的 CSS 决定,明暗切换
 * 自动跟着变)。零编辑器实例 —— 文档里有再多代码块也不驻留 Monaco,
 * 只在聚焦编辑时才建实例(见 codeBlockEdit.mountCodeEditor)。
 *
 * tabSize 与编辑器的默认值对齐(4);返回值末尾会多一个 <br/>(Monaco 逐行
 * 都加),调用方按需剥掉, otherwise 盒子比编辑态高一行。
 */
export function colorizeCode(text: string, languageId: string): Promise<string> {
  return monaco.editor.colorize(text, languageId, { tabSize: 4 });
}

/**
 * 块内代码块关闭括号配对着色(model 级)。编辑器级选项到不了 model ——
 * modelService 按**全局** config 计算 bracketPairColorizationOptions(默认
 * 开着),create 时传的编辑器级选项被忽略,括号一直是 VS Code 的 #0431FA 蓝,
 * 与阅读态(colorize)的 punctuation 灰不一致。样式表里另有按装饰类名的兜底
 * (.lgp-code-block 段的 bracket-highlighting)。
 */
export function disableBlockBracketColorization(
  editor: monaco.editor.IStandaloneCodeEditor,
): void {
  try {
    editor.getModel()?.updateOptions({
      bracketColorizationOptions: {
        enabled: false,
        independentColorPoolPerBracketType: false,
      },
    });
  } catch {
    /* 老版本 monaco 没有该 model 选项时忽略 */
  }
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
  /** 字体(块内代码块传 var(--font-monospace),与阅读态 pre 同字体) */
  fontFamily?: string;
  /** 行高(px);不传走 Monaco 默认(1.35×fontSize) */
  lineHeight?: number;
  /** 覆盖默认的上下内边距(px);不传 8 / autoHeight?8:24 */
  vPadding?: number;
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
  // 块内模式(lineNumbers:false):折叠槽(lineDecorationsWidth 默认 ~20px)会把
  // 代码整体往右推一格——阅读态没有这条槽,这就是「编辑态比阅读态多一层缩进」
  // 的来源。块内把槽清零,折叠也一并关掉(阅读态同样没有折叠箭头)。
  const blockMode = opts.lineNumbers === false;
  const padTop = opts.vPadding ?? 8;
  const padBottom = opts.vPadding ?? (opts.autoHeight ? 8 : 24);
  const editor = monaco.editor.create(container, {
    value: opts.value,
    language: opts.language,
    theme: currentMonacoTheme(),
    fontSize: opts.fontSize ?? 13,
    fontFamily: opts.fontFamily,
    lineHeight: opts.lineHeight,
    wordWrap: opts.wordWrap ?? 'off',
    lineNumbers:
      opts.lineNumbers === false
        ? 'off'
        : opts.lineNumbersFn
          ? opts.lineNumbersFn
          : opts.lineNumbersStart
            ? (n: number) => String(opts.lineNumbersStart! + n - 1)
            : 'on',
    lineDecorationsWidth: blockMode ? 0 : undefined,
    // 括号对着色是 Monaco 特有的,阅读态(colorize)只有一种 punctuation 色。
    // 注意:create 的这个选项**到不了 model**——model 的
    // bracketPairColorizationOptions 在 modelService.createModel 时按**全局**
    // config.editor 计算(默认 enabled:true),编辑器级选项被忽略。曾经块内
    // 传 enabled:false 完全无效,括号一直是 VS Code 的 #0431FA 蓝。真正生效
    // 的是创建后对 model updateOptions(见下)。
    bracketPairColorization: { enabled: !blockMode },
    folding: opts.folding ?? !blockMode,
    minimap: { enabled: opts.minimap === true },
    // 补全 / hover / 查找浮层挂到裁剪链之外(见 getOverflowWidgetsDomNode)。
    // fixedOverflowWidgets 必须一起开:浮层默认按**编辑器相对**坐标 + absolute
    // 定位(contentWidgets.js:setPosition 只在 _fixedOverflowWidgets &&
    // allowEditorOverflow 时才用 fixed + 视口坐标),外挂宿主却在 body 下、
    // 原点不同 —— 不开就整体偏移到左上角(实测建议框落在 28,30 而编辑器在 413)。
    overflowWidgetsDomNode: getOverflowWidgetsDomNode(),
    fixedOverflowWidgets: true,
    automaticLayout: true,
    scrollBeyondLastLine: !opts.autoHeight,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    renderWhitespace: 'selection',
    padding: { top: padTop, bottom: padBottom },
  });
  // 块内模式在 MODEL 级关掉括号配对着色(编辑器级选项无效,见上)。
  // 颜色回落到主题规则的 delimiter → --code-punctuation,与阅读态一致。
  // 注意 updateOptions 的入参键名是 bracketColorizationOptions(历史拼写),
  // 只读侧才是 bracketPairColorizationOptions。
  if (blockMode) disableBlockBracketColorization(editor);

  if (opts.autoHeight) {
    const updateHeight = () => {
      const lineCount = editor.getModel()?.getLineCount() ?? 1;
      const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
      const pad = padTop + padBottom;
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

  installClipboardBridge(container, editor);

  return editor;
}

/**
 * Obsidian/外层会拦截 Ctrl+V/C/X:编辑器持焦时在 capture 阶段接管剪贴板
 * (SiYuan 侧同款修复:拦 keydown 后走 navigator.clipboard + executeEdits)。
 *
 * 抽出来是因为块内代码块的单例也要用同一套逻辑;单例永不 dispose,所以它的
 * listener 只在插件卸载时随 disposeMonaco 一起摘掉,这里统一登记。
 */
const clipboardBridges: Array<{
  editor: monaco.editor.IStandaloneCodeEditor;
  handler: (e: KeyboardEvent) => void;
  detach: () => void;
}> = [];

function installClipboardBridge(
  container: HTMLElement,
  editor: monaco.editor.IStandaloneCodeEditor,
): void {
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
  // 外部代码文件 / CodeDoc 的编辑器会随视图关闭而 dispose,监听必须跟着摘,
  // 否则每次开关一个代码页签就多一个指向已死实例的 keydown(它还会去调
  // editor.hasTextFocus())。单例永不 dispose,只有它靠这里的 detach 兜底。
  const detach = (): void => {
    window.removeEventListener('keydown', keydownHandler, true);
    const i = clipboardBridges.findIndex((b) => b.handler === keydownHandler);
    if (i >= 0) clipboardBridges.splice(i, 1);
  };
  editor.onDidDispose(detach);
  clipboardBridges.push({ editor, handler: keydownHandler, detach });
}


// ---------------------------------------------------------------------
// 块内代码块:全局单例(聚焦搬进来,提交搬回池,不销毁)
// ---------------------------------------------------------------------
/**
 * 原来是「聚焦 → createEditor,提交 → dispose」。建一个 Monaco 实例是整个
 * 插件里最贵的一步(初始化 + 布局 + 字体测量),点进每个代码块都要付一遍,
 * 退出还要销毁 —— 反复编辑代码块时这些开销全是白付的。
 *
 * 现在块内代码块共用一个全局实例:
 * - 实例只建一次,停放在 body 下的隐藏「池」里(.lgp-monaco-pool);
 * - 聚焦时把它的容器(root)搬进该块的 .lgp-code-editor-host,提交后搬回池里,
 *   **不销毁** —— 之后点进任何代码块都只是搬 DOM + setValue + layout;
 * - 单例只能服务一个块。分栏里两个视图同时聚焦代码块时,后挂载的一方**抢占**:
 *   先回调上一个占用者的 onPreempt(让它提交并还原 DOM),再搬走容器。
 *   抢占发生在新内容 setValue **之前**,所以上一个块读到的仍是自己的文本。
 *
 * 外部代码文件 / CodeDoc / 混合视图仍是各自独立的实例(它们同时存在且长驻),
 * 只有块内这一条路径走单例。
 */
interface SharedBlockEditor {
  editor: monaco.editor.IStandaloneCodeEditor;
  /** Monaco 的容器:在池与目标 host 之间搬移(Monaco 只认这一个节点) */
  root: HTMLElement;
  /** 当前占用者被抢占时的处理;null = 空闲 */
  lease: { onPreempt: (() => void) | null; lease: SharedBlockLease } | null;
  /** Esc 命令只能 addCommand 一次,回调经这个 ctx 每次挂载换 */
  esc: { onEscape?: () => void };
  /** autoHeight 的上下内边距:每次挂载按宿主字号重算 */
  pad: { top: number; bottom: number };
  /**
   * 写入当前块内容并按需切换 model。
   * `uri` 给了就换成带该 uri 的 model(语言服务按路径定位文档,所以块内代码块
   * 用"宿主笔记同目录的虚拟文件"当身份,见 codeBlockEdit);没给就原地 setValue
   * (语言不可能有 LSP,或 LSP 关闭时)。
   */
  applyDoc(value: string, language: string, uri?: string): void;
  /** dispose 当前 model(带 uri 的虚拟文档不可复用,归还时清掉) */
  disposeModel(): void;
  /** 卸载时摘掉滚动监听(单例常驻,只在 disposeMonaco 时调) */
  detachScroll: () => void;
}

let sharedBlock: SharedBlockEditor | null = null;
let sharedPool: HTMLElement | null = null;

/**
 * 停放容器:在屏幕外保持真实尺寸(600×200)。
 * 不用 display:none —— 尺寸为 0 时 Monaco 的内部布局算不出来,搬出后需要更多
 * 次 layout 才稳定;visibility:hidden 既不可见也保留盒模型。
 */
function getSharedPool(): HTMLElement {
  if (sharedPool?.isConnected) return sharedPool;
  const el = document.createElement('div');
  el.className = 'lgp-monaco-pool';
  document.body.appendChild(el);
  sharedPool = el;
  return el;
}

function ensureSharedBlockEditor(): SharedBlockEditor {
  if (sharedBlock) return sharedBlock;
  const root = document.createElement('div');
  root.className = 'lgp-monaco-root';
  getSharedPool().appendChild(root);
  const esc: { onEscape?: () => void } = {};
  const pad = { top: 8, bottom: 8 };
  const editor = monaco.editor.create(root, {
    value: '',
    language: 'plaintext',
    theme: currentMonacoTheme(),
    // 块内形态(与 createEditor 的 blockMode 同套参数):无行号、折叠槽清零、
    // 无 minimap、关括号彩虹 —— 都要和阅读态 colorize 的输出对齐。
    lineNumbers: 'off',
    lineDecorationsWidth: 0,
    folding: false,
    minimap: { enabled: false },
    wordWrap: 'off',
    bracketPairColorization: { enabled: false },
    overflowWidgetsDomNode: getOverflowWidgetsDomNode(),
    fixedOverflowWidgets: true,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    renderWhitespace: 'selection',
    padding: { top: pad.top, bottom: pad.bottom },
  });
  disableBlockBracketColorization(editor);
  editor.addCommand(monaco.KeyCode.Escape, () => esc.onEscape?.());
  // 高度自适应容器(块内永远 autoHeight):root 就是被搬来搬去的那个节点,
  // 高度写在它身上,搬进 host 后盒子自然跟着内容长高。
  const updateHeight = (): void => {
    const lineCount = editor.getModel()?.getLineCount() ?? 1;
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    root.style.height = `${lineCount * lineHeight + pad.top + pad.bottom}px`;
  };
  updateHeight();
  editor.onDidChangeModelContent(updateHeight);
  editor.onDidChangeConfiguration(updateHeight);
  installClipboardBridge(root, editor);
  // 滚动即收起补全。块内编辑器的高度贴着内容、自身从不滚动 —— 滚的是外层
  // 大纲容器(.block-editor-scroller),而 fixedOverflowWidgets 让浮层按
  // **视口坐标**定位,Monaco 只在编辑器自己滚动时才重算,外层滚动它感知不到:
  // 实测滚动 240px 后浮层仍停在 687,而代码块底边已到 553,补全框脱锚悬在
  // 半空、与代码脱节(看着就是"跑位/被遮挡")。补全面板里的滚轮被它自己
  // 吃掉,不会误触发这里的收起。
  const onScroll = (): void => {
    try {
      editor.trigger('lgp-scroll', 'hideSuggestWidget', null);
    } catch {
      /* 无补全时命令不存在,忽略 */
    }
    // hover 走同一个外挂宿主,一样会僵住;Monaco 没有对应的公开命令,直接把
    // 元素收起来(下次显示时它会自己设回 visible,不会永久隐藏)。
    const host = getOverflowWidgetsDomNode();
    if (!host.childElementCount) return;
    for (const el of host.querySelectorAll<HTMLElement>('.monaco-hover')) {
      if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
    }
  };
  // scroll 不冒泡,capture 阶段才能在 window 上收到后代容器的滚动。
  window.addEventListener('scroll', onScroll, true);
  sharedBlock = {
    editor,
    root,
    lease: null,
    esc,
    pad,
    applyDoc: (value, language, uri) => {
      const prev = editor.getModel();
      if (!uri) {
        if (prev && prev.isDisposed() === false) {
          // 同一个默认 model 反复用:撤销栈按块独立,每次挂载是新的编辑会话
          editor.setValue(value);
          monaco.editor.setModelLanguage(prev, language);
        } else {
          const m = editor.getModel() ?? monaco.editor.createModel(value, language);
          editor.setModel(m);
        }
        return;
      }
      const target = monaco.Uri.parse(uri);
      const existing = monaco.editor.getModel(target);
      const next = existing && !existing.isDisposed() ? existing : monaco.editor.createModel(value, language, target);
      if (next.getValue() !== value) next.setValue(value);
      editor.setModel(next);
    },
    disposeModel: () => {
      const m = editor.getModel();
      if (!m) return;
      editor.setModel(monaco.editor.createModel('', 'plaintext'));
      try {
        m.dispose();
      } catch {
        /* 已销毁 */
      }
    },
    detachScroll: () => window.removeEventListener('scroll', onScroll, true),
  };
  return sharedBlock;
}

export interface SharedMountOpts {
  value: string;
  language: string;
  /** 带身份标识的虚拟文档路径(file:/// 形式);给了就切到该 model,不给原地 setValue */
  uri?: string;
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number;
  vPadding?: number;
  onEscape?: () => void;
  /** 被另一个块抢占时的处理(通常是让当前宿主提交编辑) */
  onPreempt?: () => void;
}

/**
 * 一次挂载的租约。只有持有者 `release()` 才真的归还 —— 视图 A 的重渲染路径
 * 清自己的 stale handle 时,不会把已经属于视图 B 的实例搬回池里。
 */
export interface SharedBlockLease {
  editor: monaco.editor.IStandaloneCodeEditor;
  release(): void;
}

/** 把单例搬进 `container` 并按块配置。 */
export function mountSharedBlockEditor(
  container: HTMLElement,
  opts: SharedMountOpts,
): SharedBlockLease {
  const s = ensureSharedBlockEditor();
  // 抢占:先让上一个占用者落地(它自己会走 releaseSharedBlockEditor,不会
  // 递归回到这里 —— lease 已经摘掉了)。
  if (s.lease) {
    const prev = s.lease;
    s.lease = null;
    try {
      prev.onPreempt?.();
    } catch (e) {
      console.warn('[obsidian-logseq] 代码块编辑器抢占失败:', e);
    }
  }
  void registerTmGrammarForMonaco(opts.language).catch(() => {});
  container.appendChild(s.root); // 池 → 目标 host
  s.pad.top = opts.vPadding ?? 8;
  s.pad.bottom = opts.vPadding ?? 8;
  s.esc.onEscape = opts.onEscape;
  s.editor.updateOptions({
    fontSize: opts.fontSize ?? 13,
    ...(opts.fontFamily ? { fontFamily: opts.fontFamily } : {}),
    ...(opts.lineHeight ? { lineHeight: opts.lineHeight } : {}),
    padding: { top: s.pad.top, bottom: s.pad.bottom },
  });
  s.applyDoc(opts.value, opts.language, opts.uri);
  const lease: SharedBlockLease = {
    editor: s.editor,
    release: () => {
      // 已被抢占(别的块拿到了租约)→ 这次归还作废,不能把人家的编辑器搬走
      if (sharedBlock?.lease !== s.lease) return;
      s.lease = null; // 归还路径不触发 onPreempt
      s.esc.onEscape = undefined;
      // 归还时把这块的 model dispose 掉:换了 uri 的 model 不可复用,留着只会
      // 在 monaco.editor.getModel(uri) 里堆积(每个块一个,没人回收)。
      s.disposeModel();
      const pool = getSharedPool();
      if (s.root.parentElement !== pool) pool.appendChild(s.root);
    },
  };
  s.lease = { onPreempt: opts.onPreempt ?? null, lease };
  // 容器换了父节点,尺寸可能变:显式 layout 一次(automaticLayout 的
  // ResizeObserver 也会触发,但那一帧是异步的,首屏会闪一下旧宽度)。
  s.editor.layout();
  return lease;
}

/** 单例是否已被某个块占用(e2e/诊断用)。 */
export function sharedBlockEditorBusy(): boolean {
  return !!sharedBlock?.lease;
}

/**
 * 启动预热:提前把单例建好,省掉「第一次点进代码块」那一下创建成本。
 * 由设置项控制(默认关 —— 启动时多建一个编辑器是有代价的,交给用户决定)。
 */
export function warmUpSharedBlockEditor(plugin: MonacoPluginHost): void {
  setupMonaco(plugin);
  try {
    ensureSharedBlockEditor();
  } catch (e) {
    console.warn('[obsidian-logseq] 预建代码块编辑器失败:', e);
  }
}

// 全局清理(onunload 时调用)
export function disposeMonaco(): void {
  initialized = false;
  // 浮层宿主是挂在 body 上的全局节点:插件重载会再建一个,旧的必须摘掉
  // (空 div 本身无害,但热重载多了就是一堆尸体)。
  overflowWidgetsHost?.remove();
  overflowWidgetsHost = null;
  for (const b of [...clipboardBridges]) b.detach();
  if (sharedBlock) {
    sharedBlock.detachScroll();
    try {
      sharedBlock.editor.getModel()?.dispose();
    } catch {
      /* ignore */
    }
    try {
      sharedBlock.editor.dispose();
    } catch {
      /* ignore */
    }
    sharedBlock.root.remove();
    sharedBlock = null;
  }
  sharedPool?.remove();
  sharedPool = null;
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
