/**
 * 「代码编辑器设置」的行内容(25 条用户可调项)。
 *
 * Obsidian 原生平铺 Setting 行,作为设置页「代码编辑器」节渲染
 * (tab.ts → renderEditorSettingsSection)。
 *
 * 存储与生效:
 *  - settings.json 是唯一存储(<configDir>/plugins/<dir>/settings.json),
 *    saveEditorSettings 写文件并更新运行态,applyEditorSettings 推给所有
 *    活着的编辑器实例即时生效;
 *  - 开关/下拉即时保存;数字/文本防抖 500ms 保存;
 *  - 「重载」从磁盘重读 settings.json(外部手改后用)。
 */

import { Notice, Setting, TextComponent } from 'obsidian';
import { getEditorSettings, type EditorSettings } from '../editor/editorSettings';
import { applyEditorSettings } from '../editor/monaco';
import {
  loadEditorSettings,
  saveEditorSettings,
  settingsJsonPath,
  type EditorSettingsHost,
} from './editorSettingsStore';
import { enumFontFamiliesViaFs } from './fontsEnum';

// electron shell 懒加载(同 openWith.ts 的理由:顶层 require 会拖 node 内建进单测)
type Requirer = (id: string) => unknown;
function nodeRequire(id: string): unknown {
  const r = (globalThis as { require?: Requirer }).require;
  if (typeof r === 'function') return r(id);
  return eval('require')(id);
}

interface RowDef {
  key: keyof EditorSettings;
  name: string;
  desc: string;
  type: 'bool' | 'enum' | 'int' | 'text';
  /** enum 可选值 */
  options?: ReadonlyArray<{ v: string; label: string }>;
  /** 当前值不在 options 里时的展示兜底(如 wordWrap 的哨兵 '' → 'on') */
  displayFallback?: string;
  /** 非零值的钳制范围(0 = 跟随/不限,恒允许) */
  min?: number;
  max?: number;
  placeholder?: string;
  /** 文本输入框尾部带"+"按钮,弹出系统字体列表选中追加(字体族专用) */
  fontPicker?: true;
}

/** 行分组仅为了源码可读性,渲染时按顺序拍平。 */
const ROW_GROUPS: RowDef[][] = [
  [
    {
      key: 'fontSize',
      name: '字号',
      type: 'int',
      min: 5,
      max: 100,
      placeholder: '0 = 跟随',
      desc: '编辑器字号(px)。0 = 跟随：块内代码块与阅读态一致，文件视图用默认 13。全局生效（含块内代码块）。',
    },
    {
      key: 'fontFamily',
      name: '字体族',
      type: 'text',
      fontPicker: true,
      placeholder: '如 Cascadia Code, Consolas',
      desc: '编辑器字体。留空 = 跟随（块内代码块用等宽字体）。可填本机已安装的字体名，逗号分隔多个回退；点右侧 + 从系统字体列表选取。',
    },
    {
      key: 'lineHeight',
      name: '行高 (px)',
      type: 'int',
      min: 8,
      max: 200,
      placeholder: '0 = 跟随',
      desc: '行高像素值。0 = 跟随（默认按字号 ×1.5 折算）。',
    },
    {
      key: 'letterSpacing',
      name: '字符间距 (px)',
      type: 'int',
      min: -5,
      max: 20,
      placeholder: '0 = 关闭',
      desc: '字符之间的额外间距，负值收紧。',
    },
    {
      key: 'fontLigatures',
      name: '字体连字',
      type: 'bool',
      desc: '启用连字（如 =>、!== 合成为一个字形），需要字体本身支持。',
    },
  ],
  [
    {
      key: 'cursorBlinking',
      name: '光标闪烁',
      type: 'enum',
      options: [
        { v: 'blink', label: '闪烁' },
        { v: 'smooth', label: '平滑（渐隐渐现）' },
        { v: 'phase', label: '相位' },
        { v: 'expand', label: '扩散' },
        { v: 'solid', label: '常亮' },
      ],
      desc: '光标的闪烁动画样式。',
    },
    {
      key: 'cursorSmoothCaretAnimation',
      name: '光标平滑移动',
      type: 'enum',
      options: [
        { v: 'off', label: '关闭' },
        { v: 'explicit', label: '标准' },
        { v: 'on', label: '平滑' },
      ],
      desc: '光标移动位置时的跟随动画。',
    },
    {
      key: 'mouseWheelZoom',
      name: 'Ctrl+滚轮缩放',
      type: 'bool',
      desc: '按住 Ctrl（⌘）滚动鼠标滚轮缩放编辑器字号。',
    },
    {
      key: 'scrollBeyondLastLine',
      name: '滚动越过末行',
      type: 'bool',
      desc: '允许把最后一行滚动到视口顶部（仅文件视图；块内代码块始终贴合内容）。',
    },
  ],
  [
    {
      key: 'renderWhitespace',
      name: '空白字符',
      type: 'enum',
      options: [
        { v: 'none', label: '不显示' },
        { v: 'boundary', label: '仅边界' },
        { v: 'selection', label: '选中时' },
        { v: 'trailing', label: '仅尾随' },
        { v: 'all', label: '全部' },
      ],
      desc: '空格与制表符的显示时机。',
    },
    {
      key: 'renderLineHighlight',
      name: '当前行高亮',
      type: 'enum',
      options: [
        { v: 'none', label: '无' },
        { v: 'gutter', label: '仅行号' },
        { v: 'line', label: '仅行内容' },
        { v: 'all', label: '行号与行内容' },
      ],
      desc: '光标所在行的突出显示范围。',
    },
    {
      key: 'matchBrackets',
      name: '括号配对高亮',
      type: 'enum',
      options: [
        { v: 'always', label: '总是' },
        { v: 'near', label: '邻近时' },
        { v: 'never', label: '从不' },
      ],
      desc: '光标邻近括号时高亮配对括号。',
    },
    {
      key: 'bracketPairColorization',
      name: '括号彩色配对',
      type: 'bool',
      desc: '嵌套括号按层级着色（仅文件视图；块内代码块保持与阅读态一致的单一色）。',
    },
    {
      key: 'stickyScroll',
      name: '粘性滚动',
      type: 'bool',
      desc: '滚动时把外层作用域的行固定在编辑器顶部（仅文件视图）。',
    },
  ],
  [
    {
      key: 'wordWrap',
      name: '自动换行',
      type: 'enum',
      displayFallback: 'on',
      options: [
        { v: 'on', label: '开启（适应宽度）' },
        { v: 'off', label: '关闭（横向滚动）' },
        { v: 'wordWrapColumn', label: '按列宽换行' },
        { v: 'bounded', label: '视口与列宽取小' },
      ],
      desc: '长行自动折行（仅文件视图；块内代码块始终不折行）。此前由「代码编辑器自动换行」开关控制，该开关已并入此处。',
    },
    {
      key: 'wordWrapColumn',
      name: '换行列宽',
      type: 'int',
      min: 0,
      max: 500,
      placeholder: '0 = 不限',
      desc: '自动换行为「按列宽」时生效的列数。',
    },
    {
      key: 'tabSize',
      name: '缩进宽度',
      type: 'int',
      min: 1,
      max: 16,
      placeholder: '0 = 跟随',
      desc: '一个缩进层级的空格数。0 = 跟随（默认 4，或按自动探测结果）。',
    },
    {
      key: 'insertSpaces',
      name: '用空格缩进',
      type: 'bool',
      desc: '按 Tab 键时插入空格（关闭则插入制表符）。',
    },
    {
      key: 'detectIndentation',
      name: '自动探测缩进',
      type: 'bool',
      desc: '打开文件时按文件内容探测缩进宽度与空格/制表符（覆盖上面两项的固定值）。',
    },
  ],
  [
    {
      key: 'minimap',
      name: '缩略图',
      type: 'bool',
      desc: '编辑器右侧的代码缩略图（仅文件视图；块内代码块始终关闭）。',
    },
    {
      key: 'minimapRenderCharacters',
      name: '缩略图渲染字符',
      type: 'bool',
      desc: '缩略图绘制真实字符；关闭后改画色块，更省性能。',
    },
    {
      key: 'folding',
      name: '代码折叠',
      type: 'bool',
      desc: '行号槽的折叠箭头（块内代码块始终关闭）。',
    },
    {
      key: 'showFoldingControls',
      name: '折叠控件',
      type: 'enum',
      options: [
        { v: 'always', label: '总是显示' },
        { v: 'mouseover', label: '悬停显示' },
        { v: 'never', label: '从不显示' },
      ],
      desc: '折叠箭头的显示时机。',
    },
  ],
  [
    {
      key: 'quickSuggestions',
      name: '键入时自动弹出建议',
      type: 'bool',
      desc: '输入时自动弹出补全列表（注释与字符串中不触发，避免干扰）。',
    },
    {
      key: 'wordBasedSuggestions',
      name: '基于单词的建议',
      type: 'enum',
      options: [
        { v: 'off', label: '关闭' },
        { v: 'currentDocument', label: '当前文档' },
        { v: 'matchingDocuments', label: '同语言已打开文档' },
        { v: 'allDocuments', label: '所有打开文档' },
      ],
      desc: '没有语言服务时，从文档里的单词收集补全候选的范围。',
    },
  ],
];

const EDITOR_ROWS: RowDef[] = ROW_GROUPS.flat();

/** 改一项设置:写 settings.json(唯一存储)+ 更新运行态 + 推给活着的编辑器。 */
function patch(key: keyof EditorSettings, value: boolean | number | string): void {
  const next: EditorSettings = { ...getEditorSettings() };
  (next as Record<keyof EditorSettings, boolean | number | string>)[key] = value;
  saveEditorSettings(next);
  applyEditorSettings();
}

async function openSettingsJson(plugin: EditorSettingsHost): Promise<void> {
  let path: string;
  try {
    path = settingsJsonPath(plugin);
  } catch {
    new Notice('无法解析 settings.json 路径（仅桌面端可用）。');
    return;
  }
  try {
    const shell = (nodeRequire('electron') as { shell?: { openPath(p: string): Promise<string> } }).shell;
    if (!shell) {
      new Notice('当前环境不支持打开外部文件。');
      return;
    }
    const err = await shell.openPath(path);
    if (err) new Notice(`打开失败：${err}`);
  } catch (e) {
    new Notice(`打开失败：${String(e).slice(0, 120)}`);
  }
}

// ---------- 字体族"+"选择器(自绘浮层:搜索框 + 滚动列表) ----------

// 当前打开的字体选择浮层(同一时间只有一个)
let fontPanel: HTMLElement | null = null;
let fontPanelDismiss: ((e: Event) => void) | null = null;

function closeFontPanel(): void {
  if (fontPanelDismiss) {
    document.removeEventListener('mousedown', fontPanelDismiss, true);
    document.removeEventListener('keydown', fontPanelDismiss, true);
    fontPanelDismiss = null;
  }
  fontPanel?.remove();
  fontPanel = null;
}

/** 把选中的字体名追加到字体族输入框:带空格的名字自动加引号,已存在(不区分引号)不重复 */
function appendFontFamily(input: HTMLInputElement, font: string): void {
  const token = /\s/.test(font) ? `'${font}'` : font;
  const cur = input.value.trim();
  const exists = cur.split(',').some((part) => part.trim().replace(/^['"]|['"]$/g, '') === font);
  if (exists) {
    new Notice(`字体族里已有 ${font}`);
    return;
  }
  input.value = cur ? `${cur.replace(/,\s*$/, '')}, ${token}` : token;
  // 派发 input+change,命中 TextComponent onChange 的防抖保存路径(注册哪个都命中)
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function showFontPanel(input: HTMLInputElement, btn: HTMLElement, families: string[]): void {
  closeFontPanel();
  const panel = document.createElement('div');
  panel.className = 'lgp-font-panel';
  const filter = document.createElement('input');
  filter.type = 'text';
  filter.placeholder = `搜索字体(${families.length})…`;
  const listEl = document.createElement('div');
  listEl.className = 'lgp-font-list';
  const render = () => {
    const kw = filter.value.trim().toLowerCase();
    listEl.empty();
    const hit = families.filter((f) => !kw || f.toLowerCase().includes(kw));
    for (const fam of hit.slice(0, 500)) {
      const item = document.createElement('div');
      item.className = 'lgp-font-item';
      item.textContent = fam;
      // 用该字体自身渲染,所见即所得
      item.style.fontFamily = `"${fam}", monospace`;
      item.addEventListener('click', () => {
        appendFontFamily(input, fam);
        closeFontPanel();
      });
      listEl.appendChild(item);
    }
    if (!hit.length) {
      const empty = document.createElement('div');
      empty.className = 'lgp-font-empty';
      empty.textContent = '无匹配字体';
      listEl.appendChild(empty);
    }
  };
  filter.addEventListener('input', render);
  render();
  panel.appendChild(filter);
  panel.appendChild(listEl);
  document.body.appendChild(panel);

  // 定位:按钮下方,右缘对齐按钮(窄屏时左移防溢出)
  const rect = btn.getBoundingClientRect();
  const width = 300;
  panel.style.top = `${rect.bottom + 4}px`;
  panel.style.left = `${Math.max(8, rect.right - width)}px`;

  fontPanel = panel;
  // Esc 关闭;点击浮层外(非按钮)关闭
  const handler = (e: Event) => {
    if (e instanceof KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeFontPanel();
      }
      return;
    }
    if (panel.contains(e.target as Node)) return;
    if (e.target === btn) return;
    closeFontPanel();
  };
  fontPanelDismiss = handler;
  // 延迟到当前点击事件派发完再挂监听,否则本次点击会立即关掉面板
  setTimeout(() => {
    document.addEventListener('mousedown', handler, true);
    document.addEventListener('keydown', handler, true);
  }, 0);
  filter.focus();
}

/** 点击"+":Node 枚举系统字体(扫字体目录解析 name 表)后弹浮层 */
async function openFontPicker(input: HTMLInputElement, btn: HTMLElement): Promise<void> {
  if (fontPanel) {
    closeFontPanel();
    return;
  }
  let families: string[] = [];
  try {
    families = await enumFontFamiliesViaFs();
  } catch {
    families = [];
  }
  if (!families.length) {
    new Notice('无法枚举系统字体（仅桌面端可用）。');
    return;
  }
  showFontPanel(input, btn, families);
}

/** 渲染一条设置行。返回 Setting 以便上层(壳)收集行名/描述做树与搜索。 */
function renderRow(container: HTMLElement, def: RowDef): Setting {
  const s = getEditorSettings();
  const setting = new Setting(container).setName(def.name).setDesc(def.desc);
  setting.settingEl.dataset.settingKey = def.key;
  if (def.type === 'bool') {
    setting.addToggle((t) => t.setValue(s[def.key] === true).onChange((v) => patch(def.key, v)));
  } else if (def.type === 'enum') {
    setting.addDropdown((d) => {
      const opts: Record<string, string> = {};
      for (const o of def.options ?? []) opts[o.v] = o.label;
      d.addOptions(opts);
      const cur = String(s[def.key]);
      d.setValue(cur in opts ? cur : (def.displayFallback ?? ''));
      d.onChange((v) => patch(def.key, v));
    });
  } else if (def.type === 'int') {
    setting.addText((t) => {
      t.inputEl.type = 'number';
      if (def.placeholder) t.setPlaceholder(def.placeholder);
      t.setValue(String(s[def.key]));
      let timer: number | null = null;
      t.onChange((raw) => {
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = null;
          const n = Number.parseInt(raw, 10);
          if (!Number.isFinite(n)) {
            t.setValue(String(getEditorSettings()[def.key]));
            return;
          }
          let v = n;
          if (v !== 0) {
            if (def.min !== undefined) v = Math.max(def.min, v);
            if (def.max !== undefined) v = Math.min(def.max, v);
          }
          patch(def.key, v);
          t.setValue(String(v));
        }, 500);
      });
    });
  } else {
    let text: TextComponent | null = null;
    setting.addText((t) => {
      text = t;
      if (def.placeholder) t.setPlaceholder(def.placeholder);
      t.setValue(String(s[def.key]));
      let timer: number | null = null;
      t.onChange((raw) => {
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = null;
          patch(def.key, raw.trim().slice(0, 300));
        }, 500);
      });
    });
    if (def.fontPicker) {
      setting.addExtraButton((cb) => {
        cb.setIcon('plus').setTooltip('从系统字体列表添加');
        cb.onClick(() => {
          if (text) void openFontPicker(text.inputEl, cb.extraSettingsEl);
        });
      });
    }
  }
  return setting;
}

/**
 * 在 `el`(settingsPane 分类的行容器)里铺全部设置行。
 * 首行是 settings.json 操作行(打开文件 / 从磁盘重载)。
 */
export function renderEditorSettingsRows(el: HTMLElement, plugin: EditorSettingsHost): void {
  new Setting(el)
    .setName('settings.json')
    .setDesc('以上全部设置的唯一存储。手改文件后点「重载」生效；保存任意一项都会写回完整对象。')
    .addButton((b) => b.setButtonText('打开 settings.json').onClick(() => void openSettingsJson(plugin)))
    .addButton((b) =>
      b.setButtonText('重载').onClick(() => {
        const res = loadEditorSettings(plugin);
        applyEditorSettings();
        if (res.unknownKeys > 0) {
          new Notice(`settings.json 里有 ${res.unknownKeys} 个未识别的键，已忽略。`);
        }
        // 就地重建行(运行态已更新),不整页 display —— 免得丢滚动位置
        const rowsHost = el.querySelector<HTMLElement>('.lgp-editor-settings-rows');
        if (rowsHost) renderRowsInto(rowsHost);
      }),
    );
  const rows = el.createDiv({ cls: 'lgp-editor-settings-rows' });
  renderRowsInto(rows);
}

function renderRowsInto(host: HTMLElement): void {
  host.empty();
  for (const def of EDITOR_ROWS) renderRow(host, def);
}
