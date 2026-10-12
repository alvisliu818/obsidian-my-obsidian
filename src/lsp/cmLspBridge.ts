// LSP ↔ CodeMirror6 桥（代码文件编辑态）
// 补全（autocompletion override，pyright 源质量高于默认源）+
// 悬停提示（hoverTooltip）+ 诊断下划线装饰（StateField）。
// 挂载点：ExternalCodeView 的 extensions（python 文件启用）。

import { StateEffect, StateField, type Extension, type StateEffectType } from 'cm-bundle:@codemirror/state';
import { autocompletion, type CompletionContext, type CompletionResult, type Completion } from 'cm-bundle:@codemirror/autocomplete';
import {
  Decoration,
  EditorView,
  hoverTooltip,
  ViewPlugin,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from 'cm-bundle:@codemirror/view';
import {
  openLspDocument,
  closeLspDocument,
  lspCompletion,
  lspHover,
  onLspDiagnostics,
} from './lspHost';
import { resolveLspSpec } from './serverSpecs';
import type LogseqEditorPlugin from '../main';

interface DiagRange {
  from: number;
  to: number;
  sev: number;
}

const setDiagsEffect: StateEffectType<DiagRange[]> = StateEffect.define();

function diagMark(sev: number): Decoration {
  return Decoration.mark({
    class: sev === 1 ? 'lgp-lsp-diag-err' : sev === 2 ? 'lgp-lsp-diag-warn' : 'lgp-lsp-diag-info',
  });
}

function posOf(state: { doc: { line: (n: number) => { from: number; length: number } } }, line: number, ch: number): number {
  try {
    const l = state.doc.line(line + 1);
    return Math.min(l.from + Math.max(0, ch), l.from + l.length);
  } catch {
    return 0;
  }
}

const diagField = StateField.define<DecorationSet>({
  create: () => Decoration.set([]),
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setDiagsEffect)) {
        const ranges: ReturnType<Decoration['range']>[] = [];
        for (const d of e.value) {
          if (d.to > d.from) ranges.push(diagMark(d.sev).range(d.from, d.to));
        }
        return Decoration.set(ranges, true);
      }
    }
    if (tr.docChanged && deco.size) {
      // 文档变了旧诊断位置失准：清空等 server 推送新诊断
      return Decoration.set([], true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function lspKindToCm(kind?: number): string | undefined {
  const map: Record<number, string> = {
    1: 'text', 2: 'method', 3: 'function', 4: 'function', 5: 'class', 6: 'variable',
    7: 'variable', 8: 'keyword', 9: 'keyword', 10: 'namespace', 11: 'class',
    12: 'keyword', 13: 'keyword', 14: 'keyword', 15: 'keyword', 17: 'variable',
    18: 'constant', 21: 'function',
  };
  return kind ? map[kind] : undefined;
}

function markdownDom(md: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'lgp-lsp-hover';
  el.textContent = md;
  return el;
}

export interface LspBridgeOptions {
  plugin: LogseqEditorPlugin;
  absPath: string;
  languageId: string; // 'python'
}

/** 构建 LSP 桥扩展（无匹配 server / 设置关闭时返回空数组） */
export function lspBridgeExtensions(opts: LspBridgeOptions): Extension[] {
  if (!resolveLspSpec(opts.languageId, opts.plugin.settings.lspServers)) return [];
  if (opts.plugin.settings.lspEnabled === false) return [];

  const { absPath, plugin, languageId } = opts;

  const uriTail = absPath.toLowerCase().replace(/\\/g, '/');

  const completionSource = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const items = await lspCompletion(plugin, languageId, absPath, line.number - 1, ctx.pos - line.from);
    if (!items.length) return null;
    const word = ctx.matchBefore(/[A-Za-z0-9_]+/);
    const from = word ? word.from : ctx.pos;
    // pyright 把模块 dunder 成员排最前（__name__ 等），打 "np." 先看到一屏下划线；
    // 下划线成员降权排后，普通成员保持 pyright 原序（稳定排序）。
    const rank = (label: string) => (label.startsWith('__') ? 2 : label.startsWith('_') ? 1 : 0);
    const options: Completion[] = [...items]
      .sort((a, b) => rank(a.label) - rank(b.label))
      .slice(0, 200)
      .map((it) => ({
      label: it.label,
      type: lspKindToCm(it.kind),
      detail: it.detail,
      info: it.documentation ?? undefined,
      apply: it.insertText && /^[A-Za-z0-9_.()[\]= ]+$/.test(it.insertText) ? it.insertText : it.label,
    }));
    return { from, options, validFor: /^[A-Za-z0-9_.]*$/ };
  };

  const hover = hoverTooltip(
    async (view: EditorView, pos: number, side: -1 | 1) => {
      void side;
      const line = view.state.doc.lineAt(pos);
      const md = await lspHover(plugin, languageId, absPath, line.number - 1, pos - line.from);
      if (!md) return null;
      return { pos, create: () => ({ dom: markdownDom(md) }) };
    },
    { hoverTime: 350 },
  );

  const sync = ViewPlugin.fromClass(
    class implements PluginValue {
      private unregDiag: (() => void) | null = null;
      constructor(view: EditorView) {
        void openLspDocument(plugin, absPath, opts.languageId, view.state.doc.toString());
        this.unregDiag = onLspDiagnostics((ds) => {
          // pyright 回传的 uri 是 vscode-uri 规范化形态（盘符小写 + 冒号 percent-encode，
          // 如 file:///e%3A/HOME/...），与客户端发送形态（file:///E:/...）不同；
          // 过滤前先 decode 归一化，否则 endsWith 永远失配。
          const kept = ds.filter((d) => {
            let u = d.uri;
            try {
              u = decodeURIComponent(u);
            } catch {
              // 非法编码时保持原样
            }
            return u.toLowerCase().replace(/\\/g, '/').endsWith(uriTail);
          });
          const ranges: DiagRange[] = kept
            .map((d) => ({ from: posOf(view.state, d.line, d.ch), to: posOf(view.state, d.line, d.ch) + d.length, sev: d.severity }));
          view.dispatch({ effects: setDiagsEffect.of(ranges) });
        });
      }
      update(u: ViewUpdate) {
        if (u.docChanged) {
          void openLspDocument(plugin, absPath, opts.languageId, u.state.doc.toString());
        }
      }
      destroy() {
        this.unregDiag?.();
        this.unregDiag = null;
        closeLspDocument(absPath);
      }
    },
  );

  return [
    autocompletion({ override: [completionSource] }),
    hover,
    diagField,
    sync,
  ];
}
