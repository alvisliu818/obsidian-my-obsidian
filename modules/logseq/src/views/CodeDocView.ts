/**
 * 代码文件的**混合编辑视图 v2 —— 代码编辑器主导**:
 *
 *   整个视图就是一台 Monaco 代码编辑器(连续真实行号、语法高亮、代码主题),
 *   注释区以 Monaco view zone 的形态内嵌在代码流中,承载 Logseq 块片段
 *   (FragmentHost:可编辑/渲染/[[双链]])。
 *
 * 数据模型:buildCodeDoc 把文件切成 text/code 区块序列,区块铺满整个文件:
 *   - code 区:剥掉合成围栏后的代码行,按出现顺序拼进 Monaco 文档;
 *   - text 区:注释运行(含块注释/docstring),经 toOutlineDocText 变成
 *     Logseq 大纲文本喂给 FragmentHost,挂在对应行位的 view zone 里。
 *
 * 保存:任一变化(Monaco 编辑 / 片段编辑)→ 防抖 → 重建:按区块顺序
 * 「code 区取 Monaco 当前行、text 区取片段序列化的块文本行」,围栏永不落盘。
 *
 * v1 边界:注释行前导缩进在首次混合保存后归一到列 0(代码行逐字无损);
 * 行号映射按打开时布局计算,代码行增删后按增量维护,跨区大幅删改以重开为准。
 */

import { ItemView, Notice, WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { createEditor, setupMonaco, getLanguageByPath } from '../editor/monaco';
import { buildCodeDoc, toOutlineDocText } from '../features/codeDoc';
import { parseCodeFence } from '../blocks/codeFence';
import { FragmentHost } from '../blocks/fragmentEditor';
import { readExternalText, writeExternalText } from '../features/extFs';
import { parseDocument } from '../core/parser';
import { applyHeaderPath, headerPathSegments } from './headerPath';
import type { MountNode } from '../features/mountFilter';

export const VIEW_TYPE_CODE_DOC = 'logseq-code-doc';

export interface CodeDocViewState {
  abs: string;
  name: string;
  rel?: string;
  mountLabel?: string;
  mountPath?: string;
}

/** 文件的一个区块:code = 剥围栏后的代码行;text = 注释运行原文行 */
interface CodeRegion {
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
  /** 自然高度测量源:FragmentHost 的容器(内容变高 → RO → relayout)。
   *  不能测 zone domNode 本身:Monaco 按 heightInPx 给它设内联高度,
   *  .block-editor-container 的 height:100% 又会把钳制值传导到内容,
   *  测哪里都是钳制高度 —— 反馈环失效,zone 永远卡在初始最小高度。 */
  measure: HTMLElement;
}

export class CodeDocView extends ItemView {
  plugin: LogseqEditorPlugin;
  abs = '';
  fileName = '';
  rel = '';
  mountLabel = '';
  mountPath = '';

  private editor: ReturnType<typeof createEditor> | null = null;
  private regions: CodeRegion[] = [];
  /** 每个 code 区在 Monaco 文档中的行数(按变更增量维护) */
  private codeCounts: number[] = [];
  /** 每个 text 区当前已提交行数(片段提交时刷新;行号漂移用) */
  private textCounts: number[] = [];
  /** 上次切分时每区的行数基准(fileLineOf 的漂移分母) */
  private baseCounts: number[] = [];
  /** 每个 text 区一个片段(挂进 view zone) */
  private fragments: Array<FragmentHost | null> = [];
  private zones: Array<NoteZone | null> = [];
  private lang = 'plaintext';
  private crlf = false;
  private dirty = false;
  private diskData = '';
  private saveTimer: number | null = null;
  private zoneTimer = 0;
  private gutterTimer = 0;
  private mounted = false;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CODE_DOC;
  }

  getDisplayText(): string {
    return this.fileName || '代码文档';
  }

  getIcon(): string {
    return 'file-code';
  }

  getState(): Record<string, unknown> {
    return {
      abs: this.abs,
      name: this.fileName,
      rel: this.rel,
      mountLabel: this.mountLabel,
      mountPath: this.mountPath,
    };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as Partial<CodeDocViewState>;
    if (typeof s.abs === 'string') this.abs = s.abs;
    if (typeof s.name === 'string') this.fileName = s.name;
    if (typeof s.rel === 'string') this.rel = s.rel;
    if (typeof s.mountLabel === 'string') this.mountLabel = s.mountLabel;
    if (typeof s.mountPath === 'string') this.mountPath = s.mountPath;
    await super.setState(state, result);
    if (this.abs && !this.mounted) this.mountEditor();
    this.syncHeaderPath();
  }

  async onOpen(): Promise<void> {
    if (this.abs && !this.mounted) this.mountEditor();
    this.syncHeaderPath();
  }

  syncHeaderPath(): void {
    if (!this.abs) return;
    const rel = this.rel || this.relFromMount();
    const label = this.mountLabel || this.mountLabelFromSettings();
    const segments = headerPathSegments(this.abs, rel, label);
    if (segments.length) segments[0].isMount = true;
    applyHeaderPath(this.containerEl, segments, this.plugin, this.abs);
  }

  private relFromMount(): string {
    const root = (this.mountPath || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
    const full = this.abs.replace(/\\/g, '/');
    if (root && full.toLowerCase().startsWith(root + '/')) return full.slice(root.length + 1);
    return this.fileName;
  }

  private mountLabelFromSettings(): string {
    const mounts = this.plugin.settings.externalMounts ?? [];
    const full = this.abs.replace(/\\/g, '/').toLowerCase();
    let best = '';
    let bestLen = -1;
    for (const m of mounts) {
      const root = String(m.path ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
      if (!root || !full.startsWith(root + '/')) continue;
      if (root.length > bestLen) {
        bestLen = root.length;
        best = m.label || '';
      }
    }
    return best;
  }

  async onClose(): Promise<void> {
    await this.flushSave();
    this.mounted = false;
    this.editor?.dispose();
    this.editor = null;
    for (const f of this.fragments) {
      if (f) this.removeChild(f);
    }
    this.fragments = [];
    for (const z of this.zones) z?.ro.disconnect();
    this.zones = [];
    if (this.gutterTimer) window.clearTimeout(this.gutterTimer);
    this.gutterTimer = 0;
  }

  // ------------------------------------------------------------------
  // 挂载
  // ------------------------------------------------------------------

  private mountEditor(): void {
    let raw = '';
    try {
      raw = readExternalText(this.abs);
    } catch (e) {
      new Notice(`无法读取 ${this.fileName}：${String(e).slice(0, 120)}`);
      return;
    }
    this.diskData = raw;
    this.crlf = raw.includes('\r\n');
    const data = this.crlf ? raw.replace(/\r\n/g, '\n') : raw;
    this.lang = getLanguageByPath(this.abs);

    // Monaco 全局初始化(worker 路径 + 主题 + monaco.css 注入)。混合视图可能
    // 是库里第一个用 Monaco 的视图,不能依赖 ExternalCodeView 先开过——
    // 漏了这一步 .view-line 没有 position:absolute,行按普通流堆叠,
    // view zone 盖在代码行上,注释区的点击全被 Monaco 行吃掉。
    setupMonaco(this.plugin);

    // 切分:code 区剥围栏取内部行;text 区保留原行
    this.regions = buildCodeDoc(data, this.lang).map((b) => {
      if (b.kind === 'code') {
        const fence = parseCodeFence(b.text);
        const lines = (fence ? fence.content : b.text).split('\n');
        return { kind: 'code' as const, lines, startLine: b.startLine };
      }
      return { kind: 'text' as const, lines: b.text.split('\n'), startLine: b.startLine };
    });
    this.codeCounts = this.regions.map((r) => (r.kind === 'code' ? r.lines.length : 0));
    this.textCounts = this.regions.map((r) => (r.kind === 'text' ? r.lines.length : 0));
    this.baseCounts = this.regions.map((r) => r.lines.length);
    this.fragments = this.regions.map(() => null);
    this.zones = this.regions.map(() => null);

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('logseq-code-doc-view');
    contentEl.createDiv({ cls: 'logseq-code-doc-editor' });

    const codeLines: string[] = [];
    for (const r of this.regions) {
      if (r.kind === 'code') codeLines.push(...r.lines);
    }

    this.editor = createEditor(contentEl.querySelector<HTMLElement>('.logseq-code-doc-editor')!, {
      value: codeLines.join('\n'),
      language: this.lang,
      autoHeight: false,
      // 动态行号:区行数漂移(注释区增删行、代码增删行)后仍与保存后的文件一致
      lineNumbersFn: (n: number) => String(this.fileLineOf(n)),
      minimap: false,
      folding: true,
      onSave: () => void this.flushSave(),
      onChange: (_value, changes) => this.onCodeChanged(changes),
    });
    this.mounted = true;

    // 注释区:view zone + Logseq 块片段
    for (let k = 0; k < this.regions.length; k++) {
      if (this.regions[k].kind === 'text') this.addNoteZone(k);
    }
  }

  /** text 区在 Monaco 中的锚点行(其前所有 code 区行数之和;0 = 文件顶) */
  private anchorOf(regionIdx: number): number {
    let sum = 0;
    for (let k = 0; k < regionIdx; k++) {
      if (this.regions[k].kind === 'code') sum += this.codeCounts[k];
    }
    return sum;
  }

  /**
   * Monaco 行 n ↔ 文件行(动态,与保存后的文件一致):
   * 区起始行 + 前面所有区的行数漂移(当前行数 − 切分基准) + 区内偏移。
   * 区内插入被区内偏移天然吸收,与 buildCodeDoc 的 startLine 语义吻合。
   */
  private fileLineOf(n: number): number {
    let anchor = 0;
    let drift = 0;
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
    return Math.min(Math.max(n, 1), Math.max(total, 1));
  }

  /** 注释区提交后行数变了:刷新 text 区计数 + 让 gutter 重绘新行号 */
  private refreshTextCountAndGutter(regionIdx: number, lineCount: number): void {
    if (this.regions[regionIdx]?.kind !== 'text') return;
    this.textCounts[regionIdx] = lineCount;
    if (this.gutterTimer) window.clearTimeout(this.gutterTimer);
    this.gutterTimer = window.setTimeout(() => {
      this.gutterTimer = 0;
      try {
        this.editor?.updateOptions({ lineNumbers: (n: number) => String(this.fileLineOf(n)) });
      } catch {
        /* 编辑器已销毁 */
      }
    }, 250);
  }

  /** text 区的大纲文本(优先取片段已提交内容;重建兜底用初始切分) */
  private outlineOf(regionIdx: number): string {
    const frag = this.fragments[regionIdx];
    if (frag) {
      frag.flush();
      return frag.getContent();
    }
    const r = this.regions[regionIdx];
    return toOutlineDocText([{ kind: 'text', text: r.lines.join('\n'), startLine: r.startLine }]);
  }

  private addNoteZone(regionIdx: number): void {
    const anchorEl = contentElQuery(this);
    if (!anchorEl) return;
    const dom = document.createElement('div');
    dom.className = 'lgp-code-doc-note';
    // 事件不外泄给 Monaco(防编辑器抢焦点/抢快捷键)
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'contextmenu'] as const) {
      dom.addEventListener(type, (e) => e.stopPropagation());
    }

    const frag = new FragmentHost(this.plugin, dom, {
      editable: true,
      // 代码注释区:块文本行首 `#` 是注释标记,编辑态不渲染成标题。
      codeComment: true,
      onContentChange: () => {
        // 提交即刷新该区行数(行号漂移),再走保存链路。
        const doc = parseDocument(this.outlineOf(regionIdx));
        let count = 0;
        const walk = (blocks: ReturnType<typeof parseDocument>['blocks']): void => {
          for (const b of blocks) {
            count += b.text.split('\n').length;
            if (b.children.length) walk(b.children);
          }
        };
        walk(doc.blocks);
        this.refreshTextCountAndGutter(regionIdx, count);
        this.markDirty();
        this.scheduleSave();
      },
    });
    this.register(() => frag.unload());
    const r = this.regions[regionIdx];
    frag.setMarkdown(toOutlineDocText([{ kind: 'text', text: r.lines.join('\n'), startLine: r.startLine }]));
    this.fragments[regionIdx] = frag;

    // 观察 FragmentHost 容器(自然高度):块编辑、增删行、进入/退出编辑态
    // 都会改变它的高度,RO 触发后 relayout 把 zone 撑到内容真实高度。
    const ro = new ResizeObserver(() => this.scheduleZoneRelayout());
    ro.observe(frag.containerEl);
    this.zones[regionIdx] = {
      id: '',
      dom,
      ro,
      spec: { afterLineNumber: this.anchorOf(regionIdx), heightInPx: 28, domNode: dom },
      measure: frag.containerEl,
    };
    this.relayoutZone(regionIdx);
  }

  /** 建立/重排单个 zone:首次 addZone;之后改 spec 的 heightInPx/afterLineNumber
   *  再 layoutZone(Monaco 会重读 delegate 的两个字段,不必 remove+add)。 */
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
  // Monaco 变更:行数增量归属到所在 code 区
  // ------------------------------------------------------------------

  private onCodeChanged(changes?: Array<{ range: { startLineNumber: number; endLineNumber: number }; text: string }>): void {
    if (changes && changes.length > 0) {
      let shift = 0; // 同一事件里先前变更造成的行号平移
      for (const c of changes) {
        const added = (c.text.match(/\n/g)?.length ?? 0);
        const removed = c.range.endLineNumber - c.range.startLineNumber;
        const delta = added - removed;
        if (delta === 0) continue;
        const at = c.range.startLineNumber + shift;
        const k = this.codeRegionAtLine(at);
        if (k >= 0) this.codeCounts[k] = Math.max(0, this.codeCounts[k] + delta);
        shift += delta;
      }
    }
    this.markDirty();
    this.scheduleZoneRelayout();
    this.scheduleSave();
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
  // 保存
  // ------------------------------------------------------------------

  private markDirty(): void {
    this.dirty = true;
  }

  private scheduleSave(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    const delay = Math.max(300, Number(this.plugin.settings.saveDebounceMs) || 800);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushSave();
    }, delay);
  }

  /** 立即重建并落盘(未变化不写) */
  async flushSave(): Promise<void> {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.abs) return;
    const data = this.reconstruct();
    if (data === this.diskData) {
      this.dirty = false;
      return;
    }
    try {
      writeExternalText(this.abs, data);
      this.diskData = data;
      this.dirty = false;
    } catch (e) {
      new Notice(`保存失败：${String(e).slice(0, 120)}`);
    }
  }

  /** 按区块顺序重建文件文本:code 区取 Monaco 当前行;text 区取片段块行 */
  private reconstruct(): string {
    const out: string[] = [];
    const model = this.editor?.getModel();
    const total = model ? model.getLineCount() : 0;
    let m = 1; // 1 基 Monaco 行游标
    this.regions.forEach((r, k) => {
      if (r.kind === 'code') {
        const count = Math.min(this.codeCounts[k] ?? 0, Math.max(0, total - m + 1));
        for (let i = 0; i < count && model; i++) {
          out.push(model.getLineContent(m++));
        }
      } else {
        const outline = this.outlineOf(k);
        const doc = parseDocument(outline);
        const walk = (blocks: ReturnType<typeof parseDocument>['blocks']): void => {
          for (const b of blocks) {
            out.push(...b.text.split('\n'));
            if (b.children.length) walk(b.children);
          }
        };
        walk(doc.blocks);
      }
    });
    const text = out.join('\n');
    return this.crlf ? text.replace(/\n/g, '\r\n') : text;
  }

  // ------------------------------------------------------------------
  // 面板/探针用
  // ------------------------------------------------------------------

  matches(node: MountNode): boolean {
    return this.abs === node.abs;
  }

  get externalAbs(): string {
    return this.abs;
  }

  get displayPath(): string {
    return this.rel || this.fileName;
  }

  /** 探针/面板:Monaco 编辑器实例 */
  get codeEditor(): ReturnType<typeof createEditor> | null {
    return this.editor;
  }

  /** 探针/面板:注释片段(按 text 区序) */
  get noteFragments(): Array<FragmentHost | null> {
    return this.fragments;
  }

  /** 重渲染(外部变化刷新时由面板调用;v1 忽略) */
  rerender(): void {
    /* v1:外部变化不自动重载 */
  }
}

/** 取视图内容容器(mount 阶段还没存字段,这里从 DOM 拿) */
function contentElQuery(view: CodeDocView): HTMLElement | null {
  return view.containerEl.querySelector<HTMLElement>('.logseq-code-doc-editor');
}
