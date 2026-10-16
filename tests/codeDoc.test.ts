/**
 * codeDoc 切分器/重建器的往返无损与结构用例。
 */
import { describe, expect, it } from 'vitest';
import { buildCodeDoc, reconstructFromDoc, toOutlineDocText } from '../src/features/codeDoc';
import { parseCodeFence } from '../src/blocks/codeFence';
import { parseDocument } from '../src/core/parser';
import type { Block } from '../src/types';

const rt = (text: string, lang: string) => reconstructFromDoc(buildCodeDoc(text, lang));

describe('python', () => {
  const py = [
    '# 顶部说明:见 [[设计笔记]]',
    'import os',
    '',
    '# 段落一',
    '#   - 要点甲',
    '#   - 要点乙',
    '',
    'def f(x):',
    '    # 缩进注释',
    '    return x + 1  # 行内注释',
    '',
    '"""',
    '模块 docstring 说明,含 [[双链]]。',
    '"""',
    '',
    'print(f(1))',
  ].join('\n');

  it('往返无损', () => {
    expect(rt(py, 'python')).toBe(py);
  });

  it('连续整行注释(含夹空行)合并为一个 text 块;缩进注释是独立块', () => {
    const blocks = buildCodeDoc(py, 'python');
    const texts = blocks.filter((b) => b.kind === 'text').map((b) => b.text);
    // 顶部说明 / 段落一块(3 行注释 + 夹 1 空行合并)/ 缩进注释(函数内,独立运行)/ docstring
    expect(texts.length).toBe(4);
    expect(texts[1]).toContain('# 段落一');
    expect(texts[1]).toContain('#   - 要点乙');
    expect(texts[1]).toContain(''); // 夹的空行也在块里
    expect(texts[2]).toBe('    # 缩进注释');
  });

  it('docstring 整段一个块,定界符保留', () => {
    const blocks = buildCodeDoc(py, 'python').filter((b) => b.kind === 'text');
    const doc = blocks.find((b) => b.text.startsWith('"""'));
    expect(doc).toBeTruthy();
    expect(doc!.text).toContain('[[双链]]');
    expect(doc!.text).toContain('"""');
  });

  it('行内注释留在代码段', () => {
    const blocks = buildCodeDoc(py, 'python').filter((b) => b.kind === 'code');
    const code = blocks.map((b) => b.text).join('\n');
    expect(code).toContain('# 行内注释');
  });

  it('编辑注释块后重建只反映该块变化', () => {
    const blocks = buildCodeDoc(py, 'python').map((b) =>
      b.kind === 'text' && b.text.includes('要点甲')
        ? { ...b, text: b.text.replace('要点甲', '要点甲(改)') }
        : b,
    );
    const out = reconstructFromDoc(blocks);
    expect(out).toContain('#   - 要点甲(改)');
    expect(out).toContain('import os');
    expect(out).toContain('print(f(1))');
  });
});

describe('javascript', () => {
  const js = [
    '/* 头部说明',
    ' * 多行 [[块注释双链]]',
    ' */',
    'const a = 1; // trailing',
    '// 分隔注释',
    'function f() {',
    '  return a;',
    '}',
  ].join('\n');

  it('往返无损', () => {
    expect(rt(js, 'javascript')).toBe(js);
  });

  it('块注释整段一个 text 块(含定界符)', () => {
    const blocks = buildCodeDoc(js, 'javascript');
    const texts = blocks.filter((b) => b.kind === 'text');
    expect(texts.length).toBe(2); // 块注释 + // 分隔注释
    expect(texts[0].text).toContain('/* 头部说明');
    expect(texts[0].text).toContain('*/');
    expect(texts[0].text).toContain('[[块注释双链]]');
  });

  it('围栏长度自适应:代码含 ``` 时不提前闭合', () => {
    const tricky = ['const md = "```js";', 'const b = 2;'].join('\n');
    const blocks = buildCodeDoc(tricky, 'javascript');
    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe('code');
    expect(rt(tricky, 'javascript')).toBe(tricky);
  });
});

describe('边界', () => {
  it('纯空行串归入代码段(不产生空 text 块)', () => {
    const t = ['# 注释', '', '', 'code();'].join('\n');
    const blocks = buildCodeDoc(t, 'python');
    expect(blocks.filter((b) => b.kind === 'text').length).toBe(1);
    expect(rt(t, 'python')).toBe(t);
  });

  it('文件以注释结尾', () => {
    const t = 'code();\n// 尾注释'.replace(/\\n/g, '\n');
    const blocks = buildCodeDoc(t, 'javascript');
    expect(blocks[blocks.length - 1].kind).toBe('text');
    expect(rt(t, 'javascript')).toBe(t);
  });

  it('空文件', () => {
    expect(rt('', 'python')).toBe('');
  });

  it('未知语言:无注释标记,整体一个 code 块', () => {
    const t = 'weird :: content\nmore';
    const blocks = buildCodeDoc(t, 'plaintext');
    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe('code');
    expect(rt(t, 'plaintext')).toBe(t);
  });
});

describe('P2 混合视图链路', () => {
  const py = [
    '# 顶部说明:见 [[设计笔记]]',
    'import os',
    '',
    'def f(x):',
    '    # 缩进注释',
    '    return x + 1  # 行内注释',
    '',
    'print(f(1))',
  ].join('\n');

  it('toOutlineDocText:注释块序列化为列表项(非标题),代码段为围栏', () => {
    const vdoc = toOutlineDocText(buildCodeDoc(py, 'python'));
    expect(vdoc.split('\n')[0]).toBe('- # 顶部说明:见 [[设计笔记]]');
    expect(vdoc).toContain('```python');
    expect(vdoc.split('\n').filter((l) => l.startsWith('# ') && !l.startsWith('# 顶部')).length).toBe(0);
  });

  it('startLine:代码段携带真实起始行(1 基)', () => {
    const starts = buildCodeDoc(py, 'python').filter((b) => b.kind === 'code').map((b) => b.startLine);
    expect(starts).toEqual([2, 6]);
  });

  it('混合链路:toOutlineDocText → parseDocument → 重建(代码逐字,注释缩进归一)', () => {
    const doc = parseDocument(toOutlineDocText(buildCodeDoc(py, 'python')));
    // 模拟 HybridCodeBlockEditorView.serializeDocCurrent:围栏剥壳,其余逐字,子块递归
    const walk = (bs: Block[]): string[] =>
      bs.flatMap((b) => {
        const fence = parseCodeFence(b.text);
        const lines = fence ? fence.content.split('\n') : b.text.split('\n');
        return b.children.length ? [...lines, ...walk(b.children)] : lines;
      });
    const out = walk(doc.blocks).join('\n');
    expect(out).toBe([
      '# 顶部说明:见 [[设计笔记]]',
      'import os',
      '',
      'def f(x):',
      '# 缩进注释',
      '    return x + 1  # 行内注释',
      '',
      'print(f(1))',
    ].join('\n'));
    expect(out).not.toContain('```');
  });

  it('混合链路:纯代码文件(无注释)往返逐字无损', () => {
    const code = ['import os', '', 'print(os.getcwd())'].join('\n');
    const doc = parseDocument(toOutlineDocText(buildCodeDoc(code, 'python')));
    const lines = doc.blocks.flatMap((b) => {
      const fence = parseCodeFence(b.text);
      return (fence ? fence.content.split('\n') : b.text.split('\n'));
    });
    expect(lines.join('\n')).toBe(code);
  });
});
