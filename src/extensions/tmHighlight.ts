// TextMate 语法高亮 → CM6 decorations。
//
// 结构对齐 prismHighlight.ts 的 ViewPlugin（全文档 tokenize + mark decorations），
// 引擎换成 vscode-textmate（见 tmEngine.ts）。token 的 scope 链按映射表归并到
// 现有 Prism token class（`.token <type>`），阅读/编辑两态继续共用 styles.css 的
// 同一套配色——TM 引擎负责"切得准"，Prism 配色负责"上色一致"。
//
// grammar 解析是异步的（Registry.loadGrammar），而 CM extension 必须同步构建：
// 用模块级缓存 lang → IGrammar|'pending'。插件构造时缓存未热则 fire-and-forget
// 预加载，完成后 requestMeasure 刷新装饰；缓存未热的首次渲染无装饰（随后补上）。

import { ViewPlugin, Decoration, type DecorationSet, type EditorView, type ViewUpdate } from 'cm-bundle:@codemirror/view';
import type { Extension } from 'cm-bundle:@codemirror/state';
import type { IGrammar, IToken, StateStack } from 'vscode-textmate';
import { getGrammarForFence, hasGrammarForFence } from './tmEngine';

// scope 片段 → Prism token type（按优先级；自内向外扫描 scope 链，命中即返回）
const SCOPE_TO_PRISM: readonly [string, string][] = [
  ['comment', 'comment'],
  ['string', 'string'],
  ['keyword.operator', 'operator'], // 更细的组合先于 keyword 命中
  ['keyword', 'keyword'],
  ['storage', 'keyword'],
  ['entity.name.function', 'function'],
  ['support.function', 'function'],
  ['meta.function-call', 'function'],
  ['variable.function', 'function'],
  ['entity.name.type', 'class-name'],
  ['entity.name.class', 'class-name'],
  ['support.class', 'class-name'],
  ['entity.name.struct', 'class-name'],
  ['entity.name.enum', 'class-name'],
  ['constant.numeric', 'number'],
  ['constant.language', 'constant'],
  ['constant.character', 'char'],
  ['constant', 'constant'],
  ['variable', 'variable'],
  ['operator', 'operator'],
  ['entity.name.tag', 'tag'],
  ['entity.other.attribute-name', 'attr-name'],
  ['markup.heading', 'header'],
  ['markup.bold', 'bold'],
  ['markup.italic', 'italic'],
  ['invalid', 'important'],
  // punctuation 放最后（string 引号等 punctuation.definition.* 由 string 先命中）
  ['punctuation', 'punctuation'],
];

/** TM scope 链 → Prism token type（未命中返回 ''，即不装饰） */
export function scopesToPrismType(scopes: string[]): string {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    for (const [frag, type] of SCOPE_TO_PRISM) {
      if (scope.includes(frag)) return type;
    }
  }
  return '';
}

// lang(小写) → IGrammar | 'pending'
const grammarCache = new Map<string, IGrammar | 'pending'>();

function ensureGrammar(lang: string): IGrammar | 'pending' | null {
  const key = lang.toLowerCase();
  if (!hasGrammarForFence(key)) return null;
  const hit = grammarCache.get(key);
  if (hit) return hit;
  grammarCache.set(key, 'pending');
  void getGrammarForFence(key).then((g) => {
    grammarCache.set(key, g ?? 'pending');
  });
  return 'pending';
}

/** TM tokenize 全文档 → Prism class decorations（与 prismHighlight 的产出同形） */
function tmDecorations(view: EditorView, grammar: IGrammar): DecorationSet {
  const deco: ReturnType<Decoration['range']>[] = [];
  let lineStart = 0;
  let ruleStack: StateStack | null = null;
  for (const line of view.state.doc.iterLines()) {
    if (line.length > 0) {
      try {
        const result = grammar.tokenizeLine(line, ruleStack);
        ruleStack = result.ruleStack;
        const tokens: IToken[] = result.tokens;
        for (let i = 0; i < tokens.length; i++) {
          const from = lineStart + tokens[i].startIndex;
          const to = lineStart + (i + 1 < tokens.length ? tokens[i + 1].startIndex : tokens[i].endIndex);
          const type = scopesToPrismType(tokens[i].scopes);
          if (type && to > from) deco.push(Decoration.mark({ class: `token ${type}` }).range(from, to));
        }
      } catch {
        // 单行 tokenize 失败跳过（如 wasm 未就绪/语法异常），不影响其余行
        ruleStack = null;
      }
    }
    lineStart += line.length + 1; // +1: line separator
  }
  return Decoration.set(deco, true);
}

interface TmPluginHost {
  decorations: DecorationSet;
}

/** CM6 extension：fence 语言命中已装 TM 语法时的编辑态高亮 */
export function tmHighlightExtension(lang: string): Extension {
  return ViewPlugin.fromClass(
    class implements TmPluginHost {
      decorations: DecorationSet = Decoration.none;
      private view: EditorView;

      constructor(view: EditorView) {
        this.view = view;
        this.refresh();
      }

      private refresh(): void {
        const hit = ensureGrammar(lang);
        if (hit && hit !== 'pending') {
          this.decorations = tmDecorations(this.view, hit);
        } else if (hit === 'pending') {
          this.decorations = Decoration.none;
          // 语法解析完成后刷新：先更 decorations 再空 dispatch 触发一次 update，
          // 让 decorations getter 的新值被 CM 应用（requestMeasure 不会触发 update）
          void getGrammarForFence(lang).then((g) => {
            if (!g || this.view.composing) return;
            this.decorations = tmDecorations(this.view, g);
            this.view.dispatch({});
          });
        }
      }

      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) {
          const hit = ensureGrammar(lang);
          if (hit && hit !== 'pending') this.decorations = tmDecorations(u.view, hit);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
