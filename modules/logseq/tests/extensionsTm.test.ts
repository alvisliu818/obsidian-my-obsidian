import { describe, it, expect, beforeEach } from 'vitest';
import { scopesToPrismType } from '../src/extensions/tmHighlight';
import {
  registerGrammarFromExtension,
  unregisterGrammarFromExtension,
  hasGrammarForFence,
} from '../src/extensions/tmEngine';
import type { InstalledExtension } from '../src/extensions/types';

describe('scopesToPrismType', () => {
  it('maps the innermost meaningful scope (priority scan)', () => {
    expect(scopesToPrismType(['source.python', 'meta.function.python', 'entity.name.function.python'])).toBe('function');
expect(scopesToPrismType(['source.js', 'string.quoted.double.js'])).toBe('string');
  });

  it('respects priority: string beats punctuation.definition', () => {
    // 字符串引号是 punctuation.definition.string.* —— string 优先命中
    expect(scopesToPrismType(['source.py', 'punctuation.definition.string.begin.py', 'string.quoted.single.py'])).toBe('string');
  });

  it('falls through meta containers to meaningful scopes', () => {
    expect(scopesToPrismType(['source.rust', 'meta.expr.rust', 'keyword.control.rust'])).toBe('keyword');
  });

  it('unknown scopes yield no class', () => {
    expect(scopesToPrismType(['source.weird', 'totally.unknown.scope'])).toBe('');
  });

  it('maps numbers, comments, operators and tags', () => {
    expect(scopesToPrismType(['source.c', 'constant.numeric.c'])).toBe('number');
    expect(scopesToPrismType(['source.md', 'comment.line.hash'])).toBe('comment');
    expect(scopesToPrismType(['source.go', 'keyword.operator.go'])).toBe('operator');
    expect(scopesToPrismType(['text.html.basic', 'meta.tag', 'entity.name.tag'])).toBe('tag');
  });
});

function fakeGrammarExt(id: string, aliases: string[]): InstalledExtension {
  return {
    id,
    namespace: 'ns',
    name: id,
    version: '1.0.0',
    displayName: id,
    description: '',
    enabled: true,
    installedAt: 0,
    files: {
      'syntaxes/x.tmLanguage.json': JSON.stringify({ scopeName: `source.${id}`, patterns: [] }),
    },
    contributes: {
      grammars: [{ language: id, scopeName: `source.${id}`, path: './syntaxes/x.tmLanguage.json' }],
      languages: [{ id, aliases, extensions: [`.${id}`] }],
    },
  };
}

describe('tmEngine alias registry', () => {
  beforeEach(() => {
    // 先注销可能残留的（模块级状态在用例间共享）
    unregisterGrammarFromExtension(fakeGrammarExt('ruby', ['rb']));
  });

  it('registers fence aliases incl. aliases and extensions', () => {
    registerGrammarFromExtension(fakeGrammarExt('ruby', ['rb']));
    expect(hasGrammarForFence('ruby')).toBe(true);
    expect(hasGrammarForFence('Ruby')).toBe(true); // 大小写不敏感
    expect(hasGrammarForFence('rb')).toBe(true);
    expect(hasGrammarForFence('txt')).toBe(false);
  });

  it('unregister removes all aliases of that extension', () => {
    registerGrammarFromExtension(fakeGrammarExt('ruby', ['rb']));
    unregisterGrammarFromExtension(fakeGrammarExt('ruby', ['rb']));
    expect(hasGrammarForFence('ruby')).toBe(false);
    expect(hasGrammarForFence('rb')).toBe(false);
  });

  it('registering is idempotent', () => {
    registerGrammarFromExtension(fakeGrammarExt('ruby', ['rb']));
    registerGrammarFromExtension(fakeGrammarExt('ruby', ['rb']));
    unregisterGrammarFromExtension(fakeGrammarExt('ruby', ['rb']));
    expect(hasGrammarForFence('ruby')).toBe(false);
  });

  it('extension without grammar files contributes no aliases', () => {
    const ext = fakeGrammarExt('ghost', []);
    (ext.files as Record<string, string>) = {}; // 语法文件缺失
    registerGrammarFromExtension(ext);
    expect(hasGrammarForFence('ghost')).toBe(false);
  });
});
