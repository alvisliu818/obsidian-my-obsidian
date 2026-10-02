/**
 * Raw-block Enter (Logseq parity): Enter creates outline blocks from raw
 * (verbatim) content; Shift+Enter stays the soft newline. The tail of the
 * split becomes an outline list block with the common indent stripped.
 */
import { describe, expect, it } from 'vitest';
import { dedentCommon } from '../src/core/treeOps';
import { parseCodeFence } from '../src/blocks/codeBlockEdit';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';

describe('dedentCommon', () => {
  it('strips the common leading indent, keeping deeper indentation as code indent', () => {
    expect(dedentCommon('        ```python\n        import torch\n            deep()\n        ```')).toBe(
      '```python\nimport torch\n    deep()\n```',
    );
  });

  it('leaves unindented text unchanged', () => {
    expect(dedentCommon('# Title\nbody')).toBe('# Title\nbody');
  });

  it('blank lines stay blank and do not raise the minimum', () => {
    expect(dedentCommon('  a\n\n  b')).toBe('a\n\nb');
  });

  it('a partially-typed first line (caret mid-line) blocks dedenting', () => {
    expect(dedentCommon('def\n        import torch')).toBe('def\n        import torch');
  });
});

describe('parseCodeFence: pure code fences', () => {
  it('a single fenced block parses with content and language', () => {
    const info = parseCodeFence('```python\nx = 1\n```');
    expect(info?.lang).toBe('python');
    expect(info?.content).toBe('x = 1');
    expect(info?.prefix).toBe('');
    expect(info?.closed).toBe(true);
  });

  it('content after the closing fence → null (generic editor keeps everything)', () => {
    expect(parseCodeFence('```python\nx = 1\n```\ntail prose')).toBeNull();
    // Two fences in one block: mounting the code editor would commit only up
    // to the first closing fence and silently drop the second block.
    expect(parseCodeFence('```python\nx = 1\n```\n```js\ny = 2\n```')).toBeNull();
  });

  it('trailing blank lines after the closing fence still parse', () => {
    expect(parseCodeFence('```\ncode\n```\n')?.content).toBe('code');
  });

  it('an unterminated fence parses to EOF', () => {
    const info = parseCodeFence('```python\nx = 1');
    expect(info?.closed).toBe(false);
    expect(info?.content).toBe('x = 1');
  });
});

describe('parseCodeFence: mixed blocks (prefix + fence)', () => {
  it('an image line above the fence becomes the static prefix', () => {
    const info = parseCodeFence('![图](assets/image83.png)\n```\n# 搭建模型\n```');
    expect(info?.prefix).toBe('![图](assets/image83.png)');
    expect(info?.lang).toBe('');
    expect(info?.content).toBe('# 搭建模型');
    expect(info?.closed).toBe(true);
  });

  it('multi-line prefixes are preserved verbatim', () => {
    const info = parseCodeFence('para one\npara two\n```python\nx = 1\n```');
    expect(info?.prefix).toBe('para one\npara two');
    expect(info?.content).toBe('x = 1');
  });

  it('prose after the closing fence → null (data guard)', () => {
    expect(parseCodeFence('![图](a.png)\n```\ncode\n```\ntail')).toBeNull();
  });

  it('an unterminated mixed fence parses to EOF', () => {
    const info = parseCodeFence('![图](a.png)\n```\ncode');
    expect(info?.prefix).toBe('![图](a.png)');
    expect(info?.closed).toBe(false);
    expect(info?.content).toBe('code');
  });

  it('no fence line at all → null (generic editor)', () => {
    expect(parseCodeFence('just prose\nand more prose')).toBeNull();
  });

  it('prefix + fence reassembly round-trips through the serializer', () => {
    const src = '- ![图](a.png)\n\t```\n\tcode line\n\t```';
    const doc = parseDocument(src);
    const b = doc.blocks[0];
    expect(b.kind).toBe('list');
    const info = parseCodeFence(b.text);
    expect(info?.prefix).toBe('![图](a.png)');
    expect(info?.content).toBe('code line');
    // Commit reassembly: prefix + openLine + content + fence.
    const reassembled = info
      ? `${info.prefix ? info.prefix + '\n' : ''}${info.openLine}\n${info.content}\n${info.fence}`
      : '';
    expect(reassembled).toBe(b.text);
    expect(parseDocument(serializeDocument(doc)).blocks[0].text).toBe(b.text);
  });
});

describe('source-mode fence doc round-trips (mixed blocks)', () => {
  it('prefix + source doc (markers included) reassembles the original text', () => {
    for (const text of [
      '![图](a.png)\n```\n# 搭建模型\n```',
      '![图](a.png)\n```python\nx = 1\n```',
      'prose line\n```js\ny = 2',
      '```python\nx = 1\n```',
    ]) {
      const info = parseCodeFence(text);
      expect(info).not.toBeNull();
      const sourceDoc = info!.closed
        ? `${info!.openLine}\n${info!.content}\n${info!.fence}`
        : `${info!.openLine}\n${info!.content}`;
      expect((info!.prefix ? info!.prefix + '\n' : '') + sourceDoc).toBe(text);
    }
  });
});

describe('raw Enter round-trip: carved-out fence block re-parses as in-block fence', () => {
  it('a dedented tail serialized as a list block keeps its fence structure', () => {
    // Simulate the Enter carve: tail of the raw blob → new list block.
    const raw =
      '        ```python\n        import torch\n        print(torch.__version__)\n        ```';
    const tail = dedentCommon(raw);
    expect(tail).toBe('```python\nimport torch\nprint(torch.__version__)\n```');

    // The new block is a list block whose text is the pure fence.
    const doc = parseDocument('- ```python\n\timport torch\n\tprint(torch.__version__)\n```');
    const b = doc.blocks[0];
    expect(b.kind).toBe('list');
    expect(b.text).toBe('```python\nimport torch\nprint(torch.__version__)\n```');

    // Round-trip stability.
    expect(parseDocument(serializeDocument(doc)).blocks[0].text).toBe(b.text);
  });
});
