import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseVsix } from '../src/extensions/vsixLoader';

/** 构造一个最小 VSIX（内存 zip → ArrayBuffer） */
async function makeVsix(pkg: Record<string, unknown>, files: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('extension/package.json', JSON.stringify(pkg));
  for (const [p, c] of Object.entries(files)) zip.file(`extension/${p}`, c);
  zip.file('extension.vsixmanifest', '<Identity/>');
  return await zip.generateAsync({ type: 'arraybuffer' });
}

const PKG = {
  name: 'test-lang',
  publisher: 'tester',
  version: '1.2.3',
  displayName: 'Test Lang',
  description: 'A test grammar',
  contributes: {
    grammars: [{ language: 'testlang', scopeName: 'source.testlang', path: './syntaxes/test.tmLanguage.json' }],
    languages: [{ id: 'testlang', aliases: ['tl'], extensions: ['.tl'] }],
  },
};

describe('parseVsix', () => {
  it('extracts package.json, grammar file and metadata', async () => {
    const vsix = await makeVsix(PKG, {
      'syntaxes/test.tmLanguage.json': JSON.stringify({ scopeName: 'source.testlang', patterns: [] }),
    });
    const ext = await parseVsix(vsix, 'tester', 'test-lang', '1.2.3');
    expect(ext.id).toBe('tester.test-lang');
    expect(ext.version).toBe('1.2.3');
    expect(ext.displayName).toBe('Test Lang');
    expect(ext.enabled).toBe(true);
    expect(ext.contributes.grammars?.[0].scopeName).toBe('source.testlang');
    expect(ext.files['syntaxes/test.tmLanguage.json']).toContain('source.testlang');
    expect(ext.files['package.json']).toContain('test-lang');
  });

  it('uses pkg.version when no explicit version given', async () => {
    const vsix = await makeVsix(PKG, { 'syntaxes/test.tmLanguage.json': '{}' });
    const ext = await parseVsix(vsix, 'tester', 'test-lang', '');
    expect(ext.version).toBe('1.2.3');
  });

  it('extracts icon.png as data URI when present', async () => {
    const zip = new JSZip();
    zip.file('extension/package.json', JSON.stringify(PKG));
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUg=='; // not a real decode target — just bytes
    zip.file('extension/icon.png', pngB64, { base64: true });
    zip.generateAsync({ type: 'arraybuffer' });
    const vsix = await zip.generateAsync({ type: 'arraybuffer' });
    const ext = await parseVsix(vsix, 'tester', 'test-lang', '1.2.3');
    expect(ext.icon).toBe(`data:image/png;base64,${pngB64}`);
  });

  it('throws when package.json is missing', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'no manifest here');
    const vsix = await zip.generateAsync({ type: 'arraybuffer' });
    await expect(parseVsix(vsix, 'a', 'b', '1.0.0')).rejects.toThrow('package.json');
  });

  it('handles ./ prefixed contribute paths', async () => {
    const pkg = {
      ...PKG,
      contributes: {
        grammars: [{ language: 'testlang', scopeName: 'source.testlang', path: './syntaxes/test.tmLanguage.json' }],
      },
    };
    const vsix = await makeVsix(pkg, { 'syntaxes/test.tmLanguage.json': '{"scopeName":"source.testlang"}' });
    const ext = await parseVsix(vsix, 'tester', 'test-lang', '1.2.3');
    expect(ext.files['syntaxes/test.tmLanguage.json']).toContain('source.testlang');
  });

  it('parses gzip-wrapped zip bytes via magic fallback (plain zip still works)', async () => {
    // 非 gzip 输入必须原样解析（ensureDecompressed 透传分支）
    const vsix = await makeVsix(PKG, { 'syntaxes/test.tmLanguage.json': '{}' });
    const ext = await parseVsix(vsix, 'tester', 'test-lang', '1.2.3');
    expect(ext.namespace).toBe('tester');
  });

  it('extracts iconTheme JSON and its referenced SVGs (relative paths, shared dedupe)', async () => {
    // iconPath 相对主题 JSON 所在目录解析；../ 回到上级；两个定义共用同一 SVG 只存一份
    const iconThemeJson = JSON.stringify({
      iconDefinitions: {
        folder: { iconPath: './icons/folder.svg' },
        file: { iconPath: '../fileicons/file.svg' },
        dup: { iconPath: './icons/folder.svg' },
      },
      folder: 'folder',
      file: 'file',
      fileExtensions: { ts: 'file' },
    });
    const pkg = {
      ...PKG,
      contributes: {
        ...PKG.contributes,
        iconThemes: [{ id: 'test-icons', label: 'Test Icons', path: './themes/test-icon-theme.json' }],
      },
    };
    const vsix = await makeVsix(pkg, {
      'themes/test-icon-theme.json': iconThemeJson,
      'themes/icons/folder.svg': '<svg id="folder"/>',
      'fileicons/file.svg': '<svg id="file"/>',
    });
    const ext = await parseVsix(vsix, 'tester', 'test-lang', '1.2.3');
    // 主题 JSON 本体必须入库（iconThemeLoader 靠它解析贡献）
    expect(ext.files['themes/test-icon-theme.json']).toContain('iconDefinitions');
    // 相对路径归一到 extension 根：./icons/… 与 ../fileicons/…
    expect(ext.files['themes/icons/folder.svg']).toContain('folder');
    expect(ext.files['fileicons/file.svg']).toContain('file');
  });

  it('skips iconTheme JSON silently when the theme file is missing from the VSIX', async () => {
    const pkg = {
      ...PKG,
      contributes: {
        ...PKG.contributes,
        iconThemes: [{ id: 'ghost', label: 'Ghost', path: './themes/missing.json' }],
      },
    };
    const vsix = await makeVsix(pkg, { 'syntaxes/test.tmLanguage.json': '{}' });
    const ext = await parseVsix(vsix, 'tester', 'test-lang', '1.2.3');
    expect(ext.files['themes/missing.json']).toBeUndefined();
  });
});
