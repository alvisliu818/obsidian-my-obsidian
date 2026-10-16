// 已装扩展的 TextMate 语法 → Monaco 桥(移植自 siyuan-virtual-tree grammar-loader)。
// 复用 tmEngine 的 registry/grammarMap/fenceAlias(onig wasm 已 base64 内联),
// 把 IGrammar 注册为 Monaco 的 tokens provider —— 市场扩展覆盖内置 monarch。
import * as monaco from 'monaco-editor';
import { INITIAL } from 'vscode-textmate';
import { getGrammarForFence, hasGrammarForFence } from './tmEngine';

const registered = new Set<string>();

class TMState implements monaco.languages.IState {
  constructor(public ruleStack: unknown) {}
  clone(): monaco.languages.IState {
    return new TMState(this.ruleStack);
  }
  equals(other: monaco.languages.IState): boolean {
    return other instanceof TMState && other.ruleStack === this.ruleStack;
  }
}

/** 把某 fence 语言的已装 TM 语法注册进 Monaco(幂等;异步加载完成后实时切换 tokenizer) */
export async function registerTmGrammarForMonaco(lang: string): Promise<boolean> {
  const id = lang.toLowerCase();
  if (registered.has(id) || !hasGrammarForFence(id)) return false;
  const grammar = await getGrammarForFence(id);
  if (!grammar) return false;
  if (!monaco.languages.getLanguages().some((l) => l.id === id)) {
    monaco.languages.register({ id, aliases: [id] });
  }
  monaco.languages.setTokensProvider(id, {
    getInitialState: () => new TMState(INITIAL),
    tokenize(line: string, state: TMState) {
      const result = grammar.tokenizeLine(line, state.ruleStack as never);
      if (!result) return { tokens: [], endState: state };
      const tokens = result.tokens.map((tk) => ({
        startIndex: tk.startIndex,
        // 传最内层 scope 名,Monaco 主题按前缀匹配(vs 的 token 规则同源)
        scopes: tk.scopes[tk.scopes.length - 1],
      }));
      return { tokens, endState: new TMState(result.ruleStack) };
    },
  });
  registered.add(id);
  return true;
}
