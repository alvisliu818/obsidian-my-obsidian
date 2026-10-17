// VSIX 解包器
// .vsix 本质是 ZIP：extension/package.json + extension.vsixmanifest + 资源文件。
// 用 JSZip 解压，提取 package.json、contributes 引用的文件（grammar/theme/
// snippet/iconTheme JSON）与扩展图标。逻辑对齐 siyuan-virtual-tree vsix-loader。
//
// Marketplace 下载端点可能返回 gzip 原始压缩流（未自动解压时）：VSIX 是 zip，
// 本地文件头是 "PK\x03\x04"，gzip 流是 0x1f 0x8b —— 按此判定后先解 gzip 再解 zip。

import JSZip from 'jszip';
import type { Contributes, InstalledExtension } from './types';

interface VsixPackageJson {
  name: string;
  publisher?: string;
  version: string;
  displayName?: string;
  description?: string;
  engines?: { vscode?: string };
  contributes?: Contributes;
}

/** gzip magic（1f 8b）判定：Marketplace vspackage 未自动解压时兜底 */
async function ensureDecompressed(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(buf.slice(0, 2));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    // 浏览器标准 DecompressionStream('gzip')（Electron/Chromium 可用）
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
  }
  return buf;
}

/** 规范化路径：去掉开头 ./ 与 / */
function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\//, '');
}

/** package.json 所在目录（VSIX 内通常为 "extension"） */
function getBasePath(packagePath: string): string {
  const parts = packagePath.split('/');
  parts.pop();
  return parts.join('/');
}

/** 文件所在目录（相对于 extension 根） */
function getDirPath(filePath: string): string {
  const parts = filePath.split('/');
  parts.pop();
  return parts.join('/');
}

/** 解析相对路径（处理 . 与 ..），返回相对于 extension 根的规范化路径。
 *  iconTheme 的 iconPath 相对主题 JSON 所在目录，须与此处存储路径一致
 *  （iconThemeLoader 用同一算法回查 ext.files）。 */
function resolveRelativePath(baseDir: string, relPath: string): string {
  const normalized = normalizePath(relPath);
  const parts = normalized.split('/');
  const result = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const part of parts) {
    if (part === '..') result.pop();
    else if (part !== '.') result.push(part);
  }
  return result.join('/');
}

/** ZIP 内模糊查找文件（过滤 __MACOSX，优先 extension/ 前缀） */
function findFile(zip: JSZip, filename: string): string | null {
  const paths: string[] = [];
  zip.forEach((relativePath) => {
    if (relativePath.endsWith(filename) && !relativePath.startsWith('__MACOSX')) {
      paths.push(relativePath);
    }
  });
  return paths.find((p) => p.startsWith('extension/')) || paths[0] || null;
}

/** ZIP 内按候选路径查找（精确 → 前缀 → 按文件名模糊） */
function findFileInZip(zip: JSZip, relPath: string, basePath: string): JSZip.JSZipObject | null {
  const candidates = [
    basePath ? `${basePath}/${relPath}` : null,
    `extension/${relPath}`,
    relPath,
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    const file = zip.file(p);
    if (file) return file;
  }
  const fileName = relPath.split('/').pop();
  if (fileName) {
    let found: string | null = null;
    zip.forEach((relativePath) => {
      if (!found && relativePath.endsWith(fileName) && !relativePath.startsWith('__MACOSX')) {
        found = relativePath;
      }
    });
    if (found) return zip.file(found);
  }
  return null;
}

/** 解压 VSIX 并提取扩展信息 */
export async function parseVsix(
  vsixBuffer: ArrayBuffer,
  namespace: string,
  extensionName: string,
  version: string,
): Promise<InstalledExtension> {
  const raw = await ensureDecompressed(vsixBuffer);
  const zip = await JSZip.loadAsync(raw);

  const packagePath = findFile(zip, 'package.json');
  if (!packagePath) throw new Error('VSIX 中未找到 package.json');
  const pkgContent = await zip.file(packagePath)!.async('string');
  let pkg: VsixPackageJson;
  try {
    pkg = JSON.parse(pkgContent);
  } catch (e) {
    throw new Error(`package.json 解析失败: ${String(e)}`);
  }

  const basePath = getBasePath(packagePath);
  const files: Record<string, string> = { 'package.json': pkgContent };
  const contributes = pkg.contributes ?? {};

  // 收集 contributes 引用的文件路径（grammar/theme/snippet）
  const filePaths = new Set<string>();
  for (const g of contributes.grammars ?? []) if (g.path) filePaths.add(normalizePath(g.path));
  for (const t of contributes.themes ?? []) if (t.path) filePaths.add(normalizePath(t.path));
  for (const s of contributes.snippets ?? []) if (s.path) filePaths.add(normalizePath(s.path));
  for (const fp of filePaths) {
    const file = findFileInZip(zip, fp, basePath);
    if (file) {
      try {
        files[fp] = await file.async('string');
      } catch {
        // 跳过无法按文本读取的文件
      }
    }
  }

  // 图标主题：iconTheme JSON 本体 + iconDefinitions 引用的 SVG 文件。
  // iconPath 相对主题 JSON 所在目录，可能带 ./ 与 ../，需归一到 extension 根
  // （iconThemeLoader 用同一算法回查，两处必须一致）。
  if (contributes.iconThemes) {
    for (const it of contributes.iconThemes) {
      if (!it.path) continue;
      const themePath = normalizePath(it.path);
      const themeFile = findFileInZip(zip, themePath, basePath);
      if (!themeFile) {
        console.warn(`[lgp-ext] VSIX 中未找到图标主题文件: ${it.path}`);
        continue;
      }

      let themeData: any;
      try {
        const themeContent = await themeFile.async('string');
        files[themePath] = themeContent;
        themeData = JSON.parse(themeContent);
      } catch (e) {
        console.error(`[lgp-ext] 解析图标主题失败 ${themePath}:`, e);
        continue;
      }

      const themeDir = getDirPath(themePath);
      const iconDefs = themeData.iconDefinitions || {};
      const defEntries = Object.entries(iconDefs) as [string, any][];
      let extracted = 0;
      let failed = 0;
      for (const [, def] of defEntries) {
        if (!def?.iconPath) continue;
        const iconRelPath = resolveRelativePath(themeDir, def.iconPath);
        if (files[iconRelPath] !== undefined) {
          extracted++; // 多个定义可引用同一 SVG
          continue;
        }
        const iconFile = findFileInZip(zip, iconRelPath, basePath);
        if (!iconFile) {
          failed++;
          continue;
        }
        try {
          files[iconRelPath] = await iconFile.async('string');
          extracted++;
        } catch {
          failed++;
        }
      }
      if (defEntries.length > 0 && extracted === 0) {
        // 一个 SVG 都没提取到 → 图标必然无法显示，显式暴露而非静默
        console.error(
          `[lgp-ext] 图标主题 ${themePath} 声明了 ${defEntries.length} 个图标定义，` +
            `但一个 SVG 都没提取到（未找到 ${failed} 个），请检查 VSIX 结构`,
        );
      } else if (failed > 0) {
        console.warn(`[lgp-ext] 图标主题 ${themePath}: 提取 ${extracted} 个，缺失 ${failed} 个`);
      }
    }
  }

  // 图标：优先常见路径，再从 vsixmanifest 提取
  let icon: string | undefined;
  const iconPaths = ['icon.png', 'images/icon.png', 'resources/icon.png', 'media/icon.png'];
  for (const ip of iconPaths) {
    const file = findFileInZip(zip, ip, basePath);
    if (file) {
      try {
        icon = `data:image/png;base64,${await file.async('base64')}`;
        break;
      } catch {
        // 跳过
      }
    }
  }
  if (!icon) {
    const manifestPath = findFile(zip, 'extension.vsixmanifest');
    if (manifestPath) {
      const manifestContent = await zip.file(manifestPath)!.async('string');
      // es6 target 不支持 dotAll，用 [\s\S]*?
      const iconMatch = manifestContent.match(/<Property\s+Id="Assets">[\s\S]*?Asset[\s\S]*?Path="([^"]+)"/);
      if (iconMatch) {
        const iconPath = normalizePath(iconMatch[1]);
        const file = findFileInZip(zip, iconPath, basePath);
        if (file) {
          try {
            const ext = iconPath.split('.').pop()?.toLowerCase() || 'png';
            icon = `data:image/${ext};base64,${await file.async('base64')}`;
          } catch {
            // 跳过
          }
        }
      }
    }
  }

  return {
    id: `${namespace}.${extensionName}`,
    namespace,
    name: extensionName,
    version: version || pkg.version || '0.0.0',
    displayName: pkg.displayName || pkg.name || extensionName,
    description: pkg.description || '',
    icon,
    enabled: true,
    installedAt: Date.now(),
    files,
    contributes,
  };
}
