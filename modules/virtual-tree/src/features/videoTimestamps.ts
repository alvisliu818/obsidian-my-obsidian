/**
 * 视频时间戳标记(2026-10-30 用户需求):播放器里打标记 → 写进 markdown →
 * 点时间戳跳回视频该时刻;伴随笔记即「视频 → 笔记」方向的标记列表。
 *
 * 链接格式两条:
 *   - 库内视频走 generateMarkdownLink(file, notePath, '#t=秒', label)——尊重
 *     用户的 wikilink/markdown 偏好,原生 `#t=` 路由 + setEphemeralState 回跳。
 *   - 库外视频写 wikilink `[[ext:<绝对路径>#t=秒|label]]`(ext: 伪路径与
 *     omnisearch/unified-search 的惯例一致)。为什么用 wikilink 而不是
 *     `[label](ext:...)`:Live Preview 里 md 链接不是 <a>、点击不经过任何
 *     可拦截的 DOM 入口,而 wikilink 的点击(阅读/LP/块编辑器)统一汇到
 *     Workspace.openLinkText —— main.ts 里 patch 一处即可全视图拦截;
 *     且 BlockIndex 的 LINK_RE 抓得到 wikilink,反向「哪些笔记引用了这部
 *     视频」天然可查。
 *
 * 本文件保持纯函数 + vault API,不 import VideoView(避免循环)。
 */

import { Notice, TFile, normalizePath, parseLinktext, type App } from 'obsidian';

// ------------------------------------------------------------------
// 时间码解析 / 格式化
// ------------------------------------------------------------------

/** `t=` 后面的时间码 → 秒。支持 `83` / `83.5` / `1:23` / `01:23:45`;解析失败为 null。 */
export function parseTimecodeSeconds(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':');
  if (parts.length > 3 || parts.some((p) => p === '' || !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  let sec = 0;
  for (const n of nums) sec = sec * 60 + n;
  return sec;
}

/** 从 view subpath(`#t=…` 或裸 `t=…`)解析秒数;没有/非法返回 null。 */
export function parseTimecodeSubpath(subpath: string | undefined | null): number | null {
  if (!subpath) return null;
  const m = /(?:^#|^|&)t=([^&]+)/.exec(subpath);
  return m ? parseTimecodeSeconds(m[1]) : null;
}

/** 秒 → `MM:SS`(< 1h)或 `HH:MM:SS`;小数截断到整秒。 */
export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ------------------------------------------------------------------
// ext: 伪路径(与 my-omnisearch externalDocs 同一格式,此处不反向依赖)
// ------------------------------------------------------------------

/** 库外文件 → `ext:<绝对路径正斜杠>`(omnisearch/unified-search 同款前缀)。 */
export function toExtPath(abs: string): string {
  return `ext:${abs.replace(/\\/g, '/')}`;
}

/** `ext:` 前缀的路径还原绝对路径;非 ext: 返回 null。 */
export function absFromExtPath(target: string): string | null {
  return target.startsWith('ext:') ? target.slice(4) : null;
}

/**
 * 从一个链接目标串(`ext:E:/a/b.mp4#t=83`,可带 %20 编码)解析出
 * 绝对路径与秒数;不是 ext: 或没有有效时间码返回 null。视频扩展名校验交给调用方。
 */
export function parseExtVideoTarget(target: string): { abs: string; seconds: number | null } | null {
  if (!target.startsWith('ext:')) return null;
  const { path, subpath } = parseLinktext(target);
  const abs = path.slice(4);
  if (!abs) return null;
  let decoded = abs;
  try {
    decoded = decodeURIComponent(abs);
  } catch {
    /* 保留原样(路径里有裸 % 等罕见字符) */
  }
  return { abs: decoded.replace(/\//g, '\\').replace(/^\\/, ''), seconds: parseTimecodeSubpath(subpath) };
}

// ------------------------------------------------------------------
// 链接生成
// ------------------------------------------------------------------

/**
 * 生成写入 markdown 的时间戳链接。
 * 库内视频传 `videoFile`(generateMarkdownLink 尊重用户的链接风格设置);
 * 库外视频传 `videoAbs`(wikilink + ext: 伪路径,理由见文件头)。
 * `notePath` 是落笔的笔记(库内 generateMarkdownLink 需要它算相对路径)。
 */
export function buildTimestampLink(
  app: App,
  opts: { videoFile?: TFile; videoAbs?: string; notePath: string; seconds: number },
): string {
  const label = formatTimecode(opts.seconds);
  const t = String(Math.floor(opts.seconds));
  if (opts.videoFile instanceof TFile) {
    return app.fileManager.generateMarkdownLink(opts.videoFile, opts.notePath, `#t=${t}`, label);
  }
  if (opts.videoAbs) {
    return `[[${toExtPath(opts.videoAbs)}#t=${t}|${label}]]`;
  }
  return label;
}

// ------------------------------------------------------------------
// 插入:活动笔记光标优先,块编辑器追加顶级块,其余返回 false(调用方落伴随笔记)
// ------------------------------------------------------------------

/**
 * 尝试把文本写进「当前活动的笔记」:
 *   原生 MarkdownView(activeEditor)→ 光标处 replaceSelection;
 *   块编辑器视图(鸭子类型 insertTopLevelBlock,virtual-tree 不反向依赖 logseq 模块)
 *   → 追加顶级块。
 * 返回 true 表示已写入任一笔记;false = 没有可写的活动笔记。
 *
 * activeEditor 有坑:它可能仍指向**已 detach 的视图**(关掉笔记后残留)——
 * 对死编辑器 replaceSelection 是静默写空气,还让本函数误报成功、标记永远
 * 落不到伴随笔记。所以必须先验叶还挂在 workspace 上(实测踩过:探针 detach
 * 后 activeEditor 依旧非空)。
 */
export function insertIntoActiveNote(app: App, text: string): boolean {
  const mdView = app.workspace.activeEditor ?? null;
  if (mdView?.editor && mdView.file?.path && app.vault.getAbstractFileByPath(mdView.file.path)) {
    let leafAlive = false;
    const viewLeaf = (mdView as { leaf?: unknown }).leaf;
    app.workspace.iterateAllLeaves((l) => {
      if (l === viewLeaf) leafAlive = true;
    });
    if (leafAlive) {
      mdView.editor.replaceSelection(`${text} `);
      return true;
    }
  }
  // 块编辑器:块编辑器没有常驻光标,追加顶级块(insertTopLevelBlock 只有
  // BlockEditorView 有,鸭子探测避免跨模块 import)。
  const view = app.workspace.getMostRecentLeaf?.()?.view as
    | { insertTopLevelBlock?: (t: string, k: string) => unknown }
    | null;
  if (view && typeof view.insertTopLevelBlock === 'function') {
    view.insertTopLevelBlock(text, 'raw');
    return true;
  }
  return false;
}

// ------------------------------------------------------------------
// 伴随笔记(每视频一个 md,标记列表即笔记本体)
// ------------------------------------------------------------------

export interface VideoMarkRow {
  seconds: number;
  label: string;
  /** 行内时间戳链接之后的备注文本(用户手写的)。 */
  note: string;
  /** 1-based 行号(跳回笔记用)。 */
  line: number;
}

/** 视频的伴随笔记路径(`<folder>/<视频名去扩展名>.md`)。 */
export function companionNotePath(folder: string, videoName: string): string {
  const base = videoName.replace(/\.[^.]+$/, '') || videoName;
  const clean = folder.trim().replace(/^\/+|\/+$/g, '');
  return normalizePath(clean ? `${clean}/${base}.md` : `${base}.md`);
}

/** 伴随笔记的头部模板(首次创建时写入)。 */
function companionNoteHeader(videoName: string, linkTarget: string | null): string {
  const ref = linkTarget ? `\n来源:${linkTarget}\n` : '';
  return `# ${videoName}\n${ref}\n`;
}

/**
 * 确保伴随笔记存在(没有就按头部模板创建,含目录创建),返回 vault 路径。
 */
export async function ensureCompanionNote(
  app: App,
  opts: { folder: string; videoName: string; linkTargetForHeader?: string | null },
): Promise<string> {
  const path = companionNotePath(opts.folder, opts.videoName);
  if (app.vault.getAbstractFileByPath(path)) return path;
  const folder = normalizePath(opts.folder.trim().replace(/^\/+|\/+$/g, ''));
  if (folder && !app.vault.getAbstractFileByPath(folder)) {
    try {
      await app.vault.createFolder(folder);
    } catch {
      /* 并发/已存在:创建失败不致命,下面 create 会再报真错 */
    }
  }
  await app.vault.create(path, companionNoteHeader(opts.videoName, opts.linkTargetForHeader ?? null));
  return path;
}

/** 确保伴随笔记存在并追加一行标记;返回笔记的 vault 路径。 */
export async function appendMarkToCompanionNote(
  app: App,
  opts: { folder: string; videoName: string; line: string; linkTargetForHeader?: string | null },
): Promise<string> {
  const path = await ensureCompanionNote(app, opts);
  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) {
    await app.vault.process(file, (content) => {
      const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      return `${content}${sep}- ${opts.line}\n`;
    });
  }
  return path;
}

/**
 * 读伴随笔记里的标记行(时间戳链接 + 备注)。
 * 同时认两种链接形态:`[label](target#t=N)` 与 `[[target#t=N|label]]`。
 * `onlyTarget`:给了就只保留指向该目标(完整串比对,大小写/斜杠归一)的行。
 */
export async function readMarksFromNote(app: App, notePath: string, onlyTarget?: string): Promise<VideoMarkRow[]> {
  const file = app.vault.getAbstractFileByPath(notePath);
  if (!(file instanceof TFile)) return [];
  const content = await app.vault.cachedRead(file);
  const rows: VideoMarkRow[] = [];
  const lines = content.split('\n');
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  const want = onlyTarget ? norm(onlyTarget) : null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('#t=')) continue;
    let label = '';
    let target = '';
    let rest = '';
    const md = /\[([^\]]*)\]\(([^)]+?)#t=([^&)]*)[^)]*\)(.*)$/.exec(line);
    const wiki = /\[\[([^\]|#]+)#t=([^&\]|]*)[^\]]*\]\](.*)$/.exec(line);
    if (md) {
      label = md[1];
      target = md[2];
      rest = md[4];
    } else if (wiki) {
      target = wiki[1];
      rest = wiki[3];
    } else {
      continue;
    }
    const seconds = parseTimecodeSubpath(`#t=${md ? md[3] : wiki?.[2] ?? ''}`);
    if (seconds === null) continue;
    if (want && norm(target) !== want) continue;
    rows.push({
      seconds,
      label: label || formatTimecode(seconds),
      note: rest.replace(/^\s+/, '').trim(),
      line: i + 1,
    });
  }
  rows.sort((a, b) => a.seconds - b.seconds);
  return rows;
}

/** 打开库内笔记(标准 openLinkText 路由,复用已有标签页语义)。 */
export async function openVaultNote(app: App, notePath: string): Promise<void> {
  await app.workspace.openLinkText(notePath, '', false);
}

/** 统一的小提示(给打标记/跳转的反馈)。 */
export function noticeMark(msg: string): void {
  new Notice(msg, 1800);
}
