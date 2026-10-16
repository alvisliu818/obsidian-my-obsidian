/**
 * 混合编辑引擎:一台 Monaco 主导,注释区以 view zone 形态内嵌 Logseq 块编辑器。
 *
 * 这套机制原本长在 CodeDocView 里(混合 md 文档)。代码文件(ExternalCodeView)
 * 要的是同一件事——注释用 Logseq 编辑器编辑/渲染/写 [[双链]],代码用 Monaco——
 * 所以抽成组件复用,避免两处各养一份 zone 反馈环。
 *
 * 数据模型(与 features/codeDoc 一致):
 *   buildCodeDoc 把源文件切成 text(注释)/code 区块序列,区块铺满整个文件;
 *   code 区全部行拼起来喂给 Monaco(行号映射回文件真实行号);
 *   text 区的原文行喂给 FragmentHost,挂在对应行位的 view zone 里。
 * 保存时按区块顺序重建:code 区取 Monaco 当前行,text 区取片段的块文本行。
 * 未编辑时重建结果与原文件字节级一致。
 *
 * 高度反馈环(照搬 CodeDocView 的血泪):
 *   Monaco 按 heightInPx 给 zone 的 domNode 设内联高度,若容器有 height:100%
 *   就会把钳制值传导到内容 → 测 domNode 永远得到钳制高度,zone 卡在最小值。
 *   所以测量源必须是 FragmentHost 的 containerEl(自然高度),且 CSS 要断开
 *   height:100%。高度/锚点变化走 layoutZone(let Monaco 重读 delegate 字段),
 *   不要 removeZone+addZone。
 */

import { Component, Menu } from 'obsidian';
import type * as monacoNS from 'monaco-editor';
import type LogseqEditorPlugin from '../main';
import { createEditor, setupMonaco } from '../editor/monaco';
import { buildCodeDoc, toOutlineDocText } from '../features/codeDoc';
import { parseCodeFence } from '../blocks/codeFence';
import { FragmentHost } from '../blocks/fragmentEditor';
import { parseDocument } from '../core/parser';

/** 文件的一个区块:code = 剥围栏后的代码行;text = 注释行原文 */
export interface HybridRegion {
  kind: 'text' | 'code';
  lines: string[];
  startLine: number;
}

interface NoteZone {
  id: string;
  dom: HTMLElement;
  ro: ResizeObserver;
  /** addZone 时传入的 zone 对象引用:改高度/锚点后靠 layoutZone 让它重读 */
  spec: { afterLineNumber: number; heightInPx: number; domNode: HTMLElement };
  /** 自然高度测量源(FragmentHost 容器);不能测 domNode 本身,见文件头说明。 */
  measure: HTMLElement;
}

/**
 * 注释区(单个 view zone)的编辑形态。
 * - doc:类思源文档编辑器(FragmentHost 承载的 Logseq 块编辑器,默认);
 * - code:代码编辑器(该区原文行的 Monaco,注释当纯文本改)。
 */
export type NoteMode = 'doc' | 'code';

export interface HybridMountOpts {
  /** 已清空的容器;引擎在里面建编辑器根元素 */
  container: HTMLElement;
  /** Monaco 语言 id(决定 buildCodeDoc 用哪套注释标记) */
  lang: string;
  /** 文件文本(已归一化为 \n) */
  value: string;
  /** 原文件是否 CRLF(落盘时还原) */
  crlf: boolean;
  wordWrap?: 'on' | 'off';
  onSave?: () => void;
  /** 代码或注释任一处发生变化(调用方据此标脏并排自动保存) */
  onChange?: () => void;
}

/**
 * Logseq 大纲文本 → 原文行序列(剥掉列表标记与软行缩进)。
 *
 * 注释区在文档编辑器里以 `- ` 列表项呈现,取回内容时要把块文本行还原成
 * 文件里的样子(注释标记本身留在块文本里,不在这里剥)。
 */
function outlineTextToLines(outline: string): string[] {
  const doc = parseDocument(outline);
  const out: string[] = [];
  const walk = (blocks: ReturnType<typeof parseDocument>['blocks']): void => {
    for (const b of blocks) {
      out.push(...b.text.split('\n'));
      if (b.children.length) walk(b.children);
    }
  };
  walk(doc.blocks);
  return out;
}

export class HybridCodeEditor extends Component {
  private plugin: LogseqEditorPlugin;
  private opts: HybridMountOpts | null = null;
  private editor: monacoNS.editor.IStandaloneCodeEditor | null = null;
  private regions: HybridRegion[] = [];
  /** 每个 code 区当前行数(随 Monaco 编辑增量维护,用于算 text 区锚点) */
  private codeCounts: number[] = [];
  private fragments: Array<FragmentHost | null> = [];
  private zones: Array<NoteZone | null> = [];
  private zoneTimer = 0;
  /** 每个 text 区当前的编辑形态(右键切换);code 区该位无意义 */
  private noteModes: NoteMode[] = [];
  /** code 形态下该区的 Monaco 实例(doc 形态下为 null) */
  private noteEditors: Array<monacoNS.editor.IStandaloneCodeEditor | null> = [];

  constructor(plugin: LogseqEditorPlugin) {
    super();
    this.plugin = plugin;
  }

  // ------------------------------------------------------------------
  // 挂载
  // ------------------------------------------------------------------

  mount(opts: HybridMountOpts): void {
    this.opts = opts;
    const { container, lang, value } = opts;

    // worker 路径 + 主题 + monaco.css 注入。漏了这一步 .view-line 没有
    // position:absolute,行按普通流堆叠,view zone 会盖在代码行上,
    // 注释区的点击全被 Monaco 行吃掉。
    setupMonaco(this.plugin);

    // 切分:code 区剥围栏取内部行;text 区保留原行
    this.regions = buildCodeDoc(value, lang).map((b) => {
      if (b.kind === 'code') {
        const fence = parseCodeFence(b.text);
        return { kind: 'code' as const, lines: (fence ? fence.content : b.text).split('\n'), startLine: b.startLine };
      }
      return { kind: 'text' as const, lines: b.text.split('\n'), startLine: b.startLine };
    });
    this.codeCounts = this.regions.map((r) => (r.kind === 'code' ? r.lines.length : 0));
    this.fragments = this.regions.map(() => null);
    this.zones = this.regions.map(() => null);
    // 注释区默认类思源文档编辑器(用户要的默认形态);右键可逐个区切成代码编辑器。
    this.noteModes = this.regions.map(() => 'doc');
    this.noteEditors = this.regions.map(() => null);

    const host = container.createDiv({ cls: 'lgp-hybrid-editor' });

    const codeLines: string[] = [];
    for (const r of this.regions) {
      if (r.kind === 'code') codeLines.push(...r.lines);
    }

    // 真实行号映射:Monaco 第 n 行 ↔ 文件行(按打开时布局)
    const fileLineByMonaco: number[] = [];
    for (const r of this.regions) {
      if (r.kind !== 'code') continue;
      for (let i = 0; i < r.lines.length; i++) fileLineByMonaco.push(r.startLine + i);
    }

    this.editor = createEditor(host, {
      value: codeLines.join('\n'),
      language: lang,
      autoHeight: false,
      lineNumbersFn: (n: number) => String(fileLineByMonaco[n - 1] ?? n),
      minimap: false,
      folding: true,
      wordWrap: opts.wordWrap ?? 'on',
      onSave: () => opts.onSave?.(),
      onChange: (_v, changes) => this.onCodeChanged(changes),
    });

    // 注释区:view zone + Logseq 块片段
    for (let k = 0; k < this.regions.length; k++) {
      if (this.regions[k].kind === 'text') this.addNoteZone(k);
    }
  }

  // ------------------------------------------------------------------
  // 注释区(view zone + FragmentHost)
  // ------------------------------------------------------------------

  /** text 区在 Monaco 中的锚点行(其前所有 code 区行数之和;0 = 文件顶) */
  private anchorOf(regionIdx: number): number {
    let sum = 0;
    for (let k = 0; k < regionIdx; k++) {
      if (this.regions[k].kind === 'code') sum += this.codeCounts[k];
    }
    return sum;
  }

  private addNoteZone(regionIdx: number): void {
    this.buildNote(regionIdx, 'doc');
  }

  /** 右键菜单:在「类思源文档编辑器 ⇄ 代码编辑器」之间切换当前注释区 */
  private showNoteMenu(regionIdx: number, evt: MouseEvent): void {
    const menu = new Menu();
    const cur = this.noteModes[regionIdx] ?? 'doc';
    const pick = (mode: NoteMode) => () => this.switchNoteMode(regionIdx, mode);
    menu.addItem((item) =>
      item
        .setTitle('类思源文档编辑器')
        .setChecked(cur === 'doc')
        .onClick(pick('doc')),
    );
    menu.addItem((item) =>
      item
        .setTitle('代码编辑器')
        .setChecked(cur === 'code')
        .onClick(pick('code')),
    );
    menu.showAtMouseEvent(evt);
  }

  /** 切换形态:先提交当前内容,再销毁重建(内容按原样带到新形态)。 */
  private switchNoteMode(regionIdx: number, mode: NoteMode): void {
    if (this.noteModes[regionIdx] === mode) return;
    // 旧形态的内容先落到 regions,新形态从它读起——不这么做切换会丢改动。
    this.regions[regionIdx].lines = this.currentNoteLines(regionIdx);
    this.removeNote(regionIdx);
    this.buildNote(regionIdx, mode);
    this.opts?.onChange?.();
  }

  /** 该 text 区当前形态下的原文行(切换/保存都用它取内容) */
  private currentNoteLines(regionIdx: number): string[] {
    const ed = this.noteEditors[regionIdx];
    if (ed) return ed.getValue().split('\n');
    const frag = this.fragments[regionIdx];
    if (frag) {
      frag.flush();
      return outlineTextToLines(frag.getContent());
    }
    return this.regions[regionIdx].lines;
  }

  /** 销毁一个注释区(zone + 片段/编辑器 + 尺寸观察),供切换与卸载复用 */
  private removeNote(regionIdx: number): void {
    const z = this.zones[regionIdx];
    if (z) {
      z.ro.disconnect();
      const id = z.id;
      if (id && this.editor) {
        this.editor.changeViewZones((accessor) => {
          try {
            accessor.removeZone(id);
          } catch {
            /* zone 已被回收 */
          }
        });
      }
      this.zones[regionIdx] = null;
    }
    // 片段与注释编辑器都由本引擎显式管理(不用 Component.register),
    // 避免切换时 unload 与卸载时再 unload 一次。
    const frag = this.fragments[regionIdx];
    if (frag) {
      frag.unload();
      this.fragments[regionIdx] = null;
    }
    const ed = this.noteEditors[regionIdx];
    if (ed) {
      const model = ed.getModel();
      ed.dispose();
      model?.dispose();
      this.noteEditors[regionIdx] = null;
    }
  }

  private buildNote(regionIdx: number, mode: NoteMode): void {
    const editor = this.editor;
    if (!editor) return;
    this.noteModes[regionIdx] = mode;

    const dom = document.createElement('div');
    dom.className = 'lgp-code-doc-note';
    // 事件不外泄给 Monaco(防编辑器抢焦点/抢快捷键)。contextmenu 同样拦住,
    // 换成自己的形态切换菜单(否则弹的是 Monaco 的右键菜单)。
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'contextmenu'] as const) {
      dom.addEventListener(type, (e) => e.stopPropagation());
    }
    dom.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showNoteMenu(regionIdx, e);
    });

    const r = this.regions[regionIdx];
    let measure: HTMLElement;
    if (mode === 'doc') {
      const frag = new FragmentHost(this.plugin, dom, {
        editable: true,
        onContentChange: () => this.opts?.onChange?.(),
      });
      frag.setMarkdown(
        toOutlineDocText([{ kind: 'text', text: r.lines.join('\n'), startLine: r.startLine }]),
      );
      this.fragments[regionIdx] = frag;
      measure = frag.containerEl;
    } else {
      // 代码形态:该区原文行直接进一台小 Monaco。autoHeight 会按行数把容器
      // 高度写进 container.style.height,所以它天然就是 zone 的高度测量源。
      const wrap = document.createElement('div');
      wrap.className = 'lgp-hybrid-note-code';
      dom.appendChild(wrap);
      const ed = createEditor(wrap, {
        value: r.lines.join('\n'),
        // 注释原文(含 `# ` / `//` 前缀)当纯文本改,不要让它按宿主语言上色。
        language: 'plaintext',
        autoHeight: true,
        lineNumbers: true,
        minimap: false,
        wordWrap: this.opts?.wordWrap ?? 'on',
        onSave: () => this.opts?.onSave?.(),
        onChange: () => this.opts?.onChange?.(),
      });
      this.noteEditors[regionIdx] = ed;
      measure = wrap;
    }

    const ro = new ResizeObserver(() => this.scheduleZoneRelayout());
    ro.observe(measure);
    this.zones[regionIdx] = {
      id: '',
      dom,
      ro,
      spec: { afterLineNumber: this.anchorOf(regionIdx), heightInPx: 28, domNode: dom },
      measure,
    };
    this.relayoutZone(regionIdx);
  }

  /** 建立/重排单个 zone:首次 addZone;之后改 spec 再 layoutZone。 */
  private relayoutZone(regionIdx: number): void {
    const editor = this.editor;
    const z = this.zones[regionIdx];
    if (!editor || !z) return;
    const after = this.anchorOf(regionIdx);
    // 测量源脱离文档(zone 未渲染/display:none)时 offsetHeight 为 0,兜底最小高度。
    const h = Math.max(28, z.measure.offsetHeight || 28);
    if (!z.id) {
      z.spec.afterLineNumber = after;
      z.spec.heightInPx = h;
      editor.changeViewZones((accessor) => {
        z.id = accessor.addZone(z.spec);
      });
      return;
    }
    if (z.spec.heightInPx === h && z.spec.afterLineNumber === after) return;
    z.spec.heightInPx = h;
    z.spec.afterLineNumber = after;
    editor.changeViewZones((accessor) => {
      try {
        accessor.layoutZone(z.id);
      } catch {
        /* zone 被编辑器回收(极端布局竞态):下轮 RO 会重建 */
      }
    });
  }

  private scheduleZoneRelayout(): void {
    if (this.zoneTimer) return;
    this.zoneTimer = window.requestAnimationFrame(() => {
      this.zoneTimer = 0;
      for (let k = 0; k < this.regions.length; k++) {
        if (this.zones[k]) this.relayoutZone(k);
      }
    });
  }

  // ------------------------------------------------------------------
  // Monaco 变更:行数增量归属到所在 code 区(锚点随之平移)
  // ------------------------------------------------------------------

  private onCodeChanged(
    changes?: Array<{ range: { startLineNumber: number; endLineNumber: number }; text: string }>,
  ): void {
    if (changes && changes.length > 0) {
      let shift = 0;
      for (const c of changes) {
        const added = c.text.match(/\n/g)?.length ?? 0;
        const removed = c.range.endLineNumber - c.range.startLineNumber;
        const delta = added - removed;
        if (delta === 0) continue;
        const at = c.range.startLineNumber + shift;
        const k = this.codeRegionAtLine(at);
        if (k >= 0) this.codeCounts[k] = Math.max(0, this.codeCounts[k] + delta);
        shift += delta;
      }
    }
    this.scheduleZoneRelayout();
    this.opts?.onChange?.();
  }

  /** Monaco 行号(变更前坐标)→ 所属 code 区下标;找不到时回退最后一个 code 区 */
  private codeRegionAtLine(line: number): number {
    let base = 0;
    let lastCode = -1;
    for (let k = 0; k < this.regions.length; k++) {
      if (this.regions[k].kind !== 'code') continue;
      const count = this.codeCounts[k];
      if (line > base && line <= base + count) return k;
      base += count;
      lastCode = k;
    }
    return lastCode;
  }

  // ------------------------------------------------------------------
  // 重建文件文本
  // ------------------------------------------------------------------

  /** 按区块顺序重建:code 区取 Monaco 当前行;text 区取片段的块文本行 */
  reconstruct(): string {
    const out: string[] = [];
    const model = this.editor?.getModel();
    const total = model ? model.getLineCount() : 0;
    let m = 1; // 1 基 Monaco 行游标
    this.regions.forEach((r, k) => {
      if (r.kind === 'code') {
        const count = Math.min(this.codeCounts[k] ?? 0, Math.max(0, total - m + 1));
        for (let i = 0; i < count && model; i++) out.push(model.getLineContent(m++));
      } else {
        // doc 形态:片段大纲 → 块文本行;code 形态:该区 Monaco 的原文行。
        out.push(...this.currentNoteLines(k));
      }
    });
    const text = out.join('\n');
    return this.opts?.crlf ? text.replace(/\n/g, '\r\n') : text;
  }

  // ------------------------------------------------------------------
  // 对外
  // ------------------------------------------------------------------

  getEditor(): monacoNS.editor.IStandaloneCodeEditor | null {
    return this.editor;
  }

  focus(): void {
    this.editor?.focus();
  }

  onunload(): void {
    // 走 removeNote 统一销毁:zone、片段、注释区的 Monaco、各自的 ResizeObserver。
    for (let k = 0; k < this.zones.length; k++) {
      this.removeNote(k);
    }
    const model = this.editor?.getModel();
    this.editor?.dispose();
    model?.dispose();
    this.editor = null;
  }
}
