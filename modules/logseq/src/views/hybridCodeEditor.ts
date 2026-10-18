/**
 * 混合编辑引擎:一台 Monaco 主导,注释区以 view zone 形态内嵌 Logseq 块编辑器。
 *
 * 这套机制原本长在 CodeDocView 里(混合 md 文档)。代码文件(ExternalCodeView)
 * 要的是同一件事——注释用 Logseq 编辑器编辑/渲染/写 [[双链]],代码用 Monaco——
 * 所以抽成组件复用,避免两处各养一份 zone 反馈环。
 *
 * 数据模型(与 features/codeDoc 一致):
 *   toHybridRegions 把源文件切成 text(注释)/code 区块序列,区块铺满整个文件;
 *   code 区全部行拼起来喂给 Monaco;text 区的原文行喂给 FragmentHost,
 *   挂在对应行位的 view zone 里。
 * 保存时按区块顺序重建:code 区取 Monaco 当前行,text 区取片段的块文本行。
 * 未编辑时重建结果与原文件字节级一致。
 *
 * 动态重切分(注释标记 ⇄ 编辑形态联动):
 *   在 Monaco 里给一行加上注释标记(# // -- …),失焦/保存后该行重分类为注释,
 *   自动搬进类思源文档编辑器;反过来在注释区删掉标记,行搬回代码编辑器。
 *   实现 = reconstruct() → toHybridRegions 重切分 → 与当前布局比对
 *   (sameRegionLayout),不同则整体重挂(行数守恒,滚动位置可精确恢复)。
 *   只在失焦/提交时触发,绝不打断正在敲字的编辑器。
 *
 * 行号(动态,与"保存后文件"一致):
 *   行号映射不再是打开时的静态表 —— 区行数随编辑漂移,行号跟着漂移:
 *     fileLine(n) = 区起始行 + Σ_{前面的区}(当前行数 − 基准行数) + 区内偏移
 *   基准行数 = 上次(重)切分时的行数。区内插入天然被区内偏移吸收,与
 *   buildCodeDoc 的 startLine 语义吻合,无需逐行差分。
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
import { toHybridRegions, toOutlineDocText, unescapeNoteLine, type HybridRegion } from '../features/codeDoc';
import { FragmentHost } from '../blocks/fragmentEditor';
import { parseDocument } from '../core/parser';

export type { HybridRegion } from '../features/codeDoc';

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
  /** Monaco 语言 id(决定注释标记用哪套) */
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
 * 注释区在大纲里是**一行一个列表项**(toOutlineDocText),取回内容时要把
 * 块文本行还原成文件里的样子:
 *   - 任务标记(TODO/DOING/DONE)被 parser 剥出块文本存在 b.marker 里,
 *     拼回行首(仅防御性路径:进大纲时已转义,正常不会有 marker);
 *   - 行首零宽空格是 toOutlineDocText 的转义前缀,剥掉。
 * 注释标记本身(`#` / `//`)留在块文本里,不在这里剥。
 */
function outlineTextToLines(outline: string): string[] {
  const doc = parseDocument(outline);
  const out: string[] = [];
  const walk = (blocks: ReturnType<typeof parseDocument>['blocks']): void => {
    for (const b of blocks) {
      const lines = unescapeNoteLine(b.text).split('\n');
      if (b.marker && lines.length > 0) lines[0] = b.marker + ' ' + lines[0];
      out.push(...lines);
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
  /** 每个 text 区当前已提交行数(片段/注释编辑器提交时刷新,行号漂移用) */
  private textCounts: number[] = [];
  /** 上次(重)切分时每区的行数基准(行号漂移的分母) */
  private baseCounts: number[] = [];
  private fragments: Array<FragmentHost | null> = [];
  private zones: Array<NoteZone | null> = [];
  private zoneTimer = 0;
  /** 每个 text 区当前的编辑形态(右键切换);code 区该位无意义 */
  private noteModes: NoteMode[] = [];
  /** code 形态下该区的 Monaco 实例(doc 形态下为 null) */
  private noteEditors: Array<monacoNS.editor.IStandaloneCodeEditor | null> = [];
  /** 动态重切分:防抖定时器 / 执行中标记(抑制 commit 回调再入) */
  private resplitTimer = 0;
  private resplitActive = false;
  /** 重挂期间的 Monaco setValue 不进 onCodeChanged 的行数记账 */
  private suppressChange = false;
  /** 行号刷新防抖(setValue/updateOptions 触发 gutter 重绘) */
  private gutterTimer = 0;

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
    this.regions = toHybridRegions(value, lang);
    this.codeCounts = this.regions.map((r) => (r.kind === 'code' ? r.lines.length : 0));
    this.textCounts = this.regions.map((r) => (r.kind === 'text' ? r.lines.length : 0));
    this.baseCounts = this.regions.map((r) => r.lines.length);
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

    this.editor = createEditor(host, {
      value: codeLines.join('\n'),
      language: lang,
      autoHeight: false,
      lineNumbersFn: (n: number) => String(this.fileLineOf(n)),
      minimap: false,
      folding: true,
      wordWrap: opts.wordWrap ?? 'on',
      onSave: () => {
        // Ctrl+S 保存前同样做一次重切分检查(用户可能没失焦直接保存)。
        this.scheduleResplit();
        opts.onSave?.();
      },
      onChange: (_v, changes) => this.onCodeChanged(changes),
    });

    // 动态重切分触发器(一):Monaco 失焦 —— 在代码里手敲注释标记后离开,
    // 该行搬进注释区文档编辑器。
    this.editor.onDidBlurEditorText(() => this.scheduleResplit());

    // 注释区:view zone + Logseq 块片段
    for (let k = 0; k < this.regions.length; k++) {
      if (this.regions[k].kind === 'text') this.addNoteZone(k);
    }
  }

  // ------------------------------------------------------------------
  // 动态行号(与保存后的文件行号一致)
  // ------------------------------------------------------------------

  /**
   * Monaco 行 n ↔ 文件行。公式见文件头「行号」:
   * 区起始行 + 前面所有区的行数漂移 + 区内偏移。区内插入被区内偏移天然吸收。
   */
  private fileLineOf(n: number): number {
    let anchor = 0; // n 之前所有 code 区的行数和
    let drift = 0; // n 之前所有区(含 text 区)的行数漂移
    const model = this.editor?.getModel();
    const total = model ? model.getLineCount() : 0;
    for (let k = 0; k < this.regions.length; k++) {
      const r = this.regions[k];
      if (r.kind === 'code') {
        const count = this.codeCounts[k] ?? 0;
        if (n > anchor && n <= anchor + count) {
          return r.startLine + drift + (n - anchor - 1);
        }
        anchor += count;
      }
      drift += (r.kind === 'code' ? this.codeCounts[k] : this.textCounts[k]) - (this.baseCounts[k] ?? 0);
    }
    // 越界(极端竞态):按末 code 区顺延
    return Math.min(Math.max(n, 1), Math.max(total, 1));
  }

  /** 注释区提交/编辑后行数变了:刷新 text 区计数 + 让 gutter 重绘 */
  private refreshTextCountAndGutter(regionIdx: number, lines: string[]): void {
    if (this.regions[regionIdx]?.kind !== 'text') return;
    this.textCounts[regionIdx] = lines.length;
    this.scheduleGutterRefresh();
  }

  /** gutter 重绘:换一个函数身份触发 Monaco 重算行号(轻,只在提交时发生) */
  private scheduleGutterRefresh(): void {
    if (this.gutterTimer) window.clearTimeout(this.gutterTimer);
    this.gutterTimer = window.setTimeout(() => {
      this.gutterTimer = 0;
      try {
          this.editor?.updateOptions({ lineNumbers: (n: number) => String(this.fileLineOf(n)) });
        } catch {
        /* 编辑器已销毁 */
      }
      // doc 形态注释区的行号 span 不在 Monaco 里,同样跟着漂移刷新
      this.syncNoteLineNumbers();
    }, 250);
  }

  /**
   * 把各注释区(doc 形态)的行号基准与 span 刷新到当前漂移。
   * 基准 = noteFileLine(区, 1) = 区起始行 + 区前所有区的行数漂移;
   * 块序号 k ↔ 文件行 基准 + k(FragmentHost.noteLineNumberOf)。
   * 区自己的行数变化不进基准(被块序号天然吸收),只影响 gutter 宽度。
   */
  private syncNoteLineNumbers(): void {
    for (let k = 0; k < this.regions.length; k++) {
      const frag = this.fragments[k];
      if (!frag || (this.noteModes[k] ?? 'doc') !== 'doc') continue;
      const dom = this.zones[k]?.dom;
      if (dom) dom.style.setProperty('--lgp-note-gutter-w', this.noteGutterWidth(k));
      frag.lineNumberBase = this.noteFileLine(k, 1);
      frag.refreshLineNumbers();
    }
  }

  /** 注释区行号 gutter 宽度:按本区最大文件行号的位数给(数字右对齐,文字列才能对齐) */
  private noteGutterWidth(regionIdx: number): string {
    const last = this.noteFileLine(regionIdx, Math.max(1, this.textCounts[regionIdx] ?? 1));
    return `${Math.max(24, String(last).length * 8 + 10)}px`;
  }

  // ------------------------------------------------------------------
  // 注释区(view zone + FragmentHost)
  // ------------------------------------------------------------------

  /** 注释区(代码形态)第 n 行的文件行号 = 区起始行 + 区前总漂移 + 区内偏移。 */
  private noteFileLine(regionIdx: number, n: number): number {
    const r = this.regions[regionIdx];
    let drift = 0;
    for (let k = 0; k < regionIdx; k++) {
      const rk = this.regions[k];
      drift += (rk.kind === 'code' ? this.codeCounts[k] : this.textCounts[k]) - (this.baseCounts[k] ?? 0);
    }
    return r.startLine + drift + (n - 1);
  }

  /** text 区在 Monaco 中的锚点行(其前所有 code 区行数之和;0 = 文件顶) */
  private anchorOf(regionIdx: number): number {
    let sum = 0;
    for (let k = 0; k < regionIdx; k++) {
      if (this.regions[k].kind === 'code') sum += this.codeCounts[k];
    }
    return sum;
  }

  private addNoteZone(regionIdx: number): void {
    this.buildNote(regionIdx, this.noteModes[regionIdx] ?? 'doc');
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
    this.textCounts[regionIdx] = this.regions[regionIdx].lines.length;
    this.removeNote(regionIdx);
    this.buildNote(regionIdx, mode);
    this.opts?.onChange?.();
  }

  /** 该 text 区当前形态下的原文行(切换/保存/重切分都用它取内容) */
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
        // 代码注释区:块文本行首 `#` 是注释标记,编辑态不渲染成标题。
        codeComment: true,
        // 注释区行号:每个块(一行)在 controls 列显示真实文件行号。
        noteLineNumbers: true,
        onContentChange: () => {
          if (this.resplitActive) return;
          // 提交即刷新行数(行号漂移),并检查标记增删是否改变了区分类。
          this.refreshTextCountAndGutter(regionIdx, this.currentNoteLines(regionIdx));
          this.opts?.onChange?.();
          this.scheduleResplit();
        },
      });
      // 行号基准要先于首渲染设好(renderBlock 当场读)
      frag.lineNumberBase = this.noteFileLine(regionIdx, 1);
      dom.style.setProperty('--lgp-note-gutter-w', this.noteGutterWidth(regionIdx));
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
        // 注释行号 = 文件真实行号(区起始行 + 区前漂移 + 区内偏移,每次现算,
        // 不闭包 —— 上方区域增删行后漂移会平移)。
        lineNumbersFn: (n: number) => String(this.noteFileLine(regionIdx, n)),
        minimap: false,
        wordWrap: this.opts?.wordWrap ?? 'on',
        onSave: () => this.opts?.onSave?.(),
        onChange: (v) => {
          this.refreshTextCountAndGutter(regionIdx, v.split('\n'));
          this.opts?.onChange?.();
        },
      });
      // 注释标记删掉后离开 → 该行搬回主代码编辑器。
      ed.onDidBlurEditorText(() => this.scheduleResplit());
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
  // 动态重切分:注释标记的增删 ⇄ 编辑形态联动
  // ------------------------------------------------------------------

  /**
   * 排一次重切分检查(防抖 150ms)。触发点:
   *   - 主 Monaco 失焦/保存:代码行被加上注释标记 → 搬进注释区;
   *   - 注释片段提交:标记被删 → 整区(或部分行)搬回代码区;
   *   - 注释区代码形态失焦:同上。
   * 只在「提交时机」触发,绝不打断正在敲字的编辑器。
   */
  private scheduleResplit(): void {
    if (this.resplitActive) return;
    if (this.resplitTimer) window.clearTimeout(this.resplitTimer);
    this.resplitTimer = window.setTimeout(() => {
      this.resplitTimer = 0;
      this.maybeResplit();
    }, 150);
  }

  private maybeResplit(): void {
    const opts = this.opts;
    const editor = this.editor;
    if (!opts || !editor || this.resplitActive) return;
    // 有片段正处在编辑态:此刻重切分会把它正在敲的内容提交并销毁编辑器。
    // 等它自己失焦(提交必经 onContentChange → 重新排检查)再查。
    for (const f of this.fragments) {
      if (f?.focusedView) return;
    }
    // 当前逻辑文件(reconstruct 内部会 flush 片段;resplitActive 挡住
    // flush 引发的 onContentChange 再入)。
    this.resplitActive = true;
    try {
      const next = toHybridRegions(this.reconstructLF(), opts.lang);
      // 布局比对必须用「当前」行数(codeCounts = Monaco 活行数,
      // textCounts = 提交时刷新的注释区行数),不能用挂起的 regions.lines。
      const layoutSame =
        next.length === this.regions.length &&
        next.every(
          (r, k) =>
            r.kind === this.regions[k].kind &&
            r.lines.length === (r.kind === 'code' ? this.codeCounts[k] : this.textCounts[k]),
        );
      if (layoutSame) return;
      this.remount(next);
    } finally {
      this.resplitActive = false;
    }
  }

  /** 布局变了:整体重挂(行数守恒 —— 标记增删不改行数,视图状态可恢复)。 */
  private remount(next: HybridRegion[]): void {
    const editor = this.editor;
    if (!editor) return;
    const viewState = editor.saveViewState();

    // 旧区的形态按文件位置继承:新区起点落在某个旧区的文件行范围内就沿用
    // 它的 doc/code 形态(用户手动切过的选择不因重挂而丢)。
    const prevModes: Array<{ from: number; to: number; mode: NoteMode }> = [];
    this.regions.forEach((r, k) => {
      if (r.kind !== 'text') return;
      prevModes.push({ from: r.startLine, to: r.startLine + (this.baseCounts[k] ?? r.lines.length) - 1, mode: this.noteModes[k] ?? 'doc' });
    });
    const inheritMode = (startLine: number): NoteMode => {
      const hit = prevModes.find((m) => startLine >= m.from && startLine <= m.to);
      return hit?.mode ?? 'doc';
    };

    // 全部注释区下线(内容已在 reconstructLF 里落袋)
    for (let k = 0; k < this.zones.length; k++) this.removeNote(k);

    this.regions = next;
    this.codeCounts = next.map((r) => (r.kind === 'code' ? r.lines.length : 0));
    this.textCounts = next.map((r) => (r.kind === 'text' ? r.lines.length : 0));
    this.baseCounts = next.map((r) => r.lines.length);
    this.fragments = next.map(() => null);
    this.zones = next.map(() => null);
    this.noteEditors = next.map(() => null);
    this.noteModes = next.map((r) => (r.kind === 'text' ? inheritMode(r.startLine) : 'doc'));

    // Monaco 换血:setValue 走 suppressChange,不进行区行数记账
    const codeLines: string[] = [];
    for (const r of next) {
      if (r.kind === 'code') codeLines.push(...r.lines);
    }
    const model = editor.getModel();
    if (model) {
      this.suppressChange = true;
      try {
        model.setValue(codeLines.join('\n'));
      } finally {
        this.suppressChange = false;
      }
    }

    // 注释区重建
    for (let k = 0; k < next.length; k++) {
      if (next[k].kind === 'text') this.buildNote(k, this.noteModes[k]);
    }

    // 行数守恒:恢复滚动 + 光标(Monaco 行号可能有平移,位置按行号就近恢复)
    if (viewState) editor.restoreViewState(viewState);
    this.scheduleZoneRelayout();
  }

  // ------------------------------------------------------------------
  // Monaco 变更:行数增量归属到所在 code 区(锚点随之平移)
  // ------------------------------------------------------------------

  private onCodeChanged(
    changes?: Array<{ range: { startLineNumber: number; endLineNumber: number }; text: string }>,
  ): void {
    if (this.suppressChange) return;
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
    // 代码区行数变了 → 下游注释区的文件行号漂移,gutter 与行号 span 一起刷新
    // (防抖 250ms;doc 形态注释区的 span 在 scheduleGutterRefresh 里同步)
    this.scheduleGutterRefresh();
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

  /** 按区块顺序重建(LF):code 区取 Monaco 当前行;text 区取片段的块文本行 */
  private reconstructLF(): string {
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
    return out.join('\n');
  }

  reconstruct(): string {
    const text = this.reconstructLF();
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
    if (this.resplitTimer) window.clearTimeout(this.resplitTimer);
    if (this.gutterTimer) window.clearTimeout(this.gutterTimer);
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
