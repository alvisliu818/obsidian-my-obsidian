/**
 * codeDoc 切分器/重建器的往返无损与结构用例。
 */
import { describe, expect, it } from 'vitest';
import { buildCodeDoc, escapeNoteLine, reconstructFromDoc, toOutlineDocText, toHybridRegions, unescapeNoteLine } from '../src/features/codeDoc';
import { parseCodeFence } from '../src/blocks/codeFence';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';
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

  it('混合链路:toOutlineDocText → parseDocument → 重建(代码与注释均逐字,缩进保留)', () => {
    const doc = parseDocument(toOutlineDocText(buildCodeDoc(py, 'python')));
    // 模拟 HybridCodeBlockEditorView.serializeDocCurrent:围栏剥壳,其余逐字,子块递归
    const walk = (bs: Block[]): string[] =>
      bs.flatMap((b) => {
        const fence = parseCodeFence(b.text);
        const lines = fence ? fence.content.split('\n') : b.text.split('\n');
        return b.children.length ? [...lines, ...walk(b.children)] : lines;
      });
    const out = walk(doc.blocks).join('\n');
    // 注释行的前导缩进原样保留(不再归一到列 0):代码文件里函数内的注释
    // 一保存就被拉到列 0,等于插件改了用户的源文件。
    expect(out).toBe(py);
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

/**
 * 缩进保留(v1 边界已修):代码文件里函数内的注释是缩进的,往返必须逐字无损——
 * 否则插件一保存就把用户的注释拉到列 0,等于改了源文件。
 *
 * 走的是混合视图真正的重建路径(块文本行 + 子块递归),不是 reconstructFromDoc:
 * 注释区在编辑器里是块,保存时取的是块的文本行。
 */
describe('缩进往返:混合视图保存路径逐字节无损', () => {
  const reconstructViaBlocks = (lang: string, src: string): string => {
    const vdoc = toOutlineDocText(buildCodeDoc(src, lang));
    const doc = parseDocument(vdoc);
    const walk = (bs: Block[]): string[] =>
      bs.flatMap((b) => {
        const fence = parseCodeFence(b.text);
        const lines = (fence ? fence.content : b.text).split('\n');
        return b.children.length ? [...lines, ...walk(b.children)] : lines;
      });
    return walk(doc.blocks).join('\n');
  };

  it('python:多层缩进注释与行内注释并存', () => {
    const src = [
      '# 顶部说明',
      'import os',
      '',
      'def f(x):',
      '    # 缩进注释',
      '        # 更深一层',
      '    return x + 1  # 行内注释',
      '',
      'print(f(1))',
    ].join('\n');
    expect(reconstructViaBlocks('python', src)).toBe(src);
  });

  it('typescript:块注释与行注释混排', () => {
    const src = [
      '// 顶层说明',
      'export function f() {',
      '    /*',
      '     * 块注释(缩进)',
      '     */',
      '    // 行注释',
      '    return 1;',
      '}',
    ].join('\n');
    expect(reconstructViaBlocks('typescript', src)).toBe(src);
  });

  it('Tab 缩进的注释同样逐字无损', () => {
    const src = 'def f():\n\t# tab 注释\n\treturn 1\n';
    expect(reconstructViaBlocks('python', src)).toBe(src);
  });

  it('parser:列表项标记后的多余空格属于内容(LIST_RE 只吃一个)', () => {
    const doc = parseDocument('-     # x');
    expect(doc.blocks[0].text).toBe('    # x');
    // 序列化照样原样写回,往返自洽
    expect(serializeDocument(doc)).toBe('-     # x');
  });
});

/**
 * 动态重切分布局判定(HybridCodeEditor.maybeResplit 的核心):
 * 挂载与重切分共用 toHybridRegions;引擎比对 = 区数 + 每区 kind +
 * 每区「当前行数」(code 区 = Monaco 活行数,text 区 = 提交时刷新的行数)。
 * 在代码行手敲注释标记 → kind 改变 → 重挂(编辑器切换);删标记同理。
 * 注释区内部增删行只动行数、kind 不变 → 不重挂,走行数漂移。
 */
describe('toHybridRegions:动态重切分布局', () => {
  const py = ['# 顶部说明', 'import os', 'def f():', '    return 1'].join('\n');

  /** 挂载时的布局与基准(py 的布局) */
  const base = toHybridRegions(py, 'python');
  const baseKinds = base.map((r) => r.kind);

  /** 引擎的比对函数(next 来自重切分;liveCounts 是当前活行数) */
  const layoutSame = (next: ReturnType<typeof toHybridRegions>, kinds: string[], counts: number[]) =>
    next.length === kinds.length &&
    next.every((r, k) => r.kind === kinds[k] && r.lines.length === counts[k]);

  it('挂载布局:注释区与代码区交替,startLine 为真实文件行', () => {
    // 连续代码行归并进同一个 code 区(中间无注释分隔)
    expect(base).toEqual([
      { kind: 'text', lines: ['# 顶部说明'], startLine: 1 },
      { kind: 'code', lines: ['import os', 'def f():', '    return 1'], startLine: 2 },
    ]);
  });

  it('代码行加注释标记 → kind 改变 → 重挂(编辑器切换为注释区)', () => {
    const edited = ['# 顶部说明', '# import os', 'def f():', '    return 1'].join('\n');
    const next = toHybridRegions(edited, 'python');
    expect(next[0].lines).toEqual(['# 顶部说明', '# import os']);
    expect(layoutSame(next, baseKinds, base.map((r) => r.lines.length))).toBe(false);
  });

  it('注释行删标记 → kind 改变 → 重挂(行搬回代码区)', () => {
    const edited = ['顶部说明', 'import os', 'def f():', '    return 1'].join('\n');
    const next = toHybridRegions(edited, 'python');
    expect(next.length).toBe(1);
    expect(next[0].kind).toBe('code');
    expect(next[0].lines).toEqual(['顶部说明', 'import os', 'def f():', '    return 1']);
    expect(layoutSame(next, baseKinds, base.map((r) => r.lines.length))).toBe(false);
  });

  it('常规编辑(不加/不删标记)布局不变 → 不重挂', () => {
    const edited = ['# 顶部说明', 'import os', 'def f():', '    return 2'].join('\n');
    expect(layoutSame(toHybridRegions(edited, 'python'), baseKinds, base.map((r) => r.lines.length))).toBe(true);
  });

  it('注释区内增行:kind 不变 + 提交后 textCounts 刷新 → 不重挂', () => {
    const edited = ['# 顶部说明', '# 补充一行', 'import os', 'def f():', '    return 1'].join('\n');
    const next = toHybridRegions(edited, 'python');
    // textCounts[0] 在提交回调里已刷新为 2
    const counts = [2, ...base.slice(1).map((r) => r.lines.length)];
    expect(layoutSame(next, baseKinds, counts)).toBe(true);
    expect(next[0].lines).toEqual(['# 顶部说明', '# 补充一行']);
  });

  it('行数守恒:标记增删前后总行数一致(视图状态可恢复的前提)', () => {
    const edited = ['# 顶部说明', '# import os', 'def f():', '    return 1'].join('\n');
    const total = (src: string) => toHybridRegions(src, 'python').reduce((s, r) => s + r.lines.length, 0);
    expect(total(edited)).toBe(total(py));
  });
});

/**
 * 注释区 = 段落观感 + 行号:每行一个顶层列表项(块序号即行偏移,行号才能
 * 逐行正确),行首两类危险模式用零宽空格转义,取回时剥掉。
 *
 * 取回路径模拟 HybridCodeEditor.outlineTextToLines(unescapeNoteLine +
 * marker 拼回),不是测试自己的简化 walk —— 转义 bugs 必须在真路径上现形。
 */
describe('注释区:一行一项 + 行首转义往返', () => {
  // 全文件保存路径的模拟:注释行走片段编辑器(outlineTextToLines 同款:
  // unescapeNoteLine + marker 拼回),代码段在大纲里是围栏块、剥壳取内容。
  const outlineToText = (outline: string): string => {
    const doc = parseDocument(outline);
    const out: string[] = [];
    const walk = (bs: Block[]): void => {
      for (const b of bs) {
        const fence = parseCodeFence(b.text);
        if (fence) {
          out.push(...fence.content.split('\n'));
        } else {
          const lines = unescapeNoteLine(b.text).split('\n');
          if (b.marker && lines.length > 0) lines[0] = b.marker + ' ' + lines[0];
          out.push(...lines);
        }
        if (b.children.length) walk(b.children);
      }
    };
    walk(doc.blocks);
    return out.join('\n');
  };

  it('注释块每行一个顶层列表项(块序号 = 行偏移)', () => {
    const src = ['# 第一行', '# 第二行', 'code();', '# 第三行'].join('\n');
    const vdoc = toOutlineDocText(buildCodeDoc(src, 'python'));
    const items = vdoc.split('\n').filter((l) => /^-( |$)/.test(l));
    expect(items).toEqual(['- # 第一行', '- # 第二行', '- # 第三行']);
  });

  it('行首 TODO/DOING/DONE:转义后 parser 不剥标记,往返逐字', () => {
    // docstring 里的行没有任何注释标记保护,行首就是 TODO
    const src = ['"""', 'TODO 这是文档字符串里的待办', '"""', 'print(1)'].join('\n');
    const vdoc = toOutlineDocText(buildCodeDoc(src, 'python'));
    expect(vdoc).toContain('- \u200BTODO 这是文档字符串里的待办');
    expect(parseDocument(vdoc).blocks.every((b) => !b.marker)).toBe(true);
    expect(outlineToText(vdoc)).toBe(src);
  });

  it('行首围栏(```/~~~):转义后不当 opening,后续行不被吞', () => {
    const src = ['"""', '```python', 'docstring 里的围栏示例', '"""', 'print(1)'].join('\n');
    const vdoc = toOutlineDocText(buildCodeDoc(src, 'python'));
    expect(vdoc).toContain('- \u200B```python');
    // 结构没坏:注释区是 4 个一行块,代码段 1 个;不转义时围栏会吞到 EOF
    expect(parseDocument(vdoc).blocks.length).toBe(5);
    expect(outlineToText(vdoc)).toBe(src);
  });

  it('反面对照:不转义时 TODO 被剥出块文本(往返丢字)', () => {
    const doc = parseDocument('- TODO 修一下');
    expect(doc.blocks[0].marker).toBe('TODO');
    expect(doc.blocks[0].text).toBe('修一下');
  });

  it('反面对照:不转义时行首围栏吞掉后续行(结构错位)', () => {
    const doc = parseDocument(['- ```python', '- 第二行'].join('\n'));
    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].text).toContain('第二行');
  });

  it('escapeNoteLine/unescapeNoteLine:只动行首命中模式', () => {
    expect(escapeNoteLine('TODO x')).toBe('\u200BTODO x');
    expect(escapeNoteLine('DONE x')).toBe('\u200BDONE x');
    expect(escapeNoteLine('  ~~~')).toBe('\u200B  ~~~');
    expect(escapeNoteLine('```py')).toBe('\u200B```py');
    expect(escapeNoteLine('todo x')).toBe('todo x'); // 小写不命中
    expect(escapeNoteLine('TODOX')).toBe('TODOX'); // 标记后无空白不命中
    expect(escapeNoteLine('   TODO x')).toBe('   TODO x'); // 前导空白已躲开 MARKER_RE
    expect(escapeNoteLine('# 普通注释')).toBe('# 普通注释'); // 注释标记本身即保护
    expect(unescapeNoteLine('\u200BTODO x')).toBe('TODO x');
    expect(unescapeNoteLine('TODO x')).toBe('TODO x');
    expect(unescapeNoteLine('')).toBe('');
  });

  it('真实注释文件往返:缩进 / docstring / 转义行并存', () => {
    const src = [
      '"""模块说明',
      'TODO 待办条目',
      '```python',
      '"""',
      'import os',
      '',
      'def f(x):',
      '    # 缩进注释',
      '    return x + 1',
      '',
      'print(f(1))',
    ].join('\n');
    expect(outlineToText(toOutlineDocText(buildCodeDoc(src, 'python')))).toBe(src);
  });
});
