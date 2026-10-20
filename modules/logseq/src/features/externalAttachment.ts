import { App, Notice } from 'obsidian';
import type { BlockEditorView } from '../view/BlockEditorView';
import {
  baseOf,
  dirOf,
  ensureDir,
  exists,
  extOf,
  joinAbs,
  uniqueCopyName,
  writeExternalBinary,
} from './extFs';

/**
 * 库外笔记（挂载目录里的文件）的附件落盘：粘贴图片 / 拖入文件。
 *
 * 为什么单独一套：`vault.adapter` 会把绝对路径解析成 `<库根>\E:\...` 而失败，
 * 库外文件也不在 vault 里，所以这里一律走 Node fs（extFs）。而 custom-attachment
 * -location（CAL）是靠猴补丁 `vault.*` / `fileManager.*` 生效的，库外文件根本
 * 不走这些 API，CAL 对它压根不会被调用——所以这里把 CAL 的**路径模板**接过来
 * 用，而不是等它的补丁被触发。
 *
 * 目标目录的优先级：
 *   1. CAL 模块启用且关闭了「跟随 Obsidian 附件位置」→ 按它的
 *      `attachmentFolderPath` 模板解析（{{noteFileName}} 等 token 用库外笔记
 *      的真实路径求值，`./` 相对笔记目录、`/` 相对挂载根）。
 *   2. 否则 → 笔记所在目录（对应 Obsidian 的「当前文件所在文件夹」）。
 * CAL 不可用（未启用/没装）时静默走第 2 条——它是软依赖。
 *
 * token 只实现文件夹模板里常见的几个；不认识的 token 求值为空串，绝不抛异常
 * 打断粘贴。
 */

const CAL_MODULE_ID = 'custom-attachment-location';
const HOST_PLUGIN_ID = 'obsidian-my-obsidian';

/** 从宿主的设置切片里读 CAL 的文件夹模板（软依赖：读不到返回 null）。 */
function calFolderTemplate(app: App): string | null {
  const plugins = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } })
    .plugins?.plugins;
  const host = plugins?.[HOST_PLUGIN_ID] as
    | { settings?: { modules?: Record<string, { enabled?: boolean; data?: Record<string, unknown> }> } }
    | undefined;
  const slice = host?.settings?.modules?.[CAL_MODULE_ID];
  if (!slice || slice.enabled === false) return null;
  const data = slice.data ?? {};
  // 「跟随 Obsidian 附件位置」对库外文件没有对应设置 → 退回笔记同目录。
  if (data.shouldFollowObsidianAttachmentLocation !== false) return null;
  const template = data.attachmentFolderPath;
  return typeof template === 'string' && template.trim() ? template : null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 最小 strftime：`{{date:YYYY-MM-DD}}` 之类，够文件夹模板用。 */
function formatDate(d: Date, fmt: string): string {
  return fmt
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/YY/g, pad2(d.getFullYear() % 100))
    .replace(/MM/g, pad2(d.getMonth() + 1))
    .replace(/DD/g, pad2(d.getDate()))
    .replace(/HH/g, pad2(d.getHours()))
    .replace(/mm/g, pad2(d.getMinutes()))
    .replace(/ss/g, pad2(d.getSeconds()));
}

/** 把路径统一成 `/` 分隔，便于分段比较。 */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

export interface ExternalAttachmentContext {
  /** 库外笔记的绝对路径。 */
  noteAbs: string;
  /** 挂载根：模板以 `/` 开头时的基准；没有就按笔记目录算。 */
  mountRoot?: string;
}

/** 解析这条库外笔记的附件应该落到哪个（绝对）目录。 */
export function resolveExternalAttachmentDir(
  app: App,
  ctx: ExternalAttachmentContext,
): string {
  const noteDir = dirOf(ctx.noteAbs);
  const template = calFolderTemplate(app);
  if (!template) return noteDir;

  const noteDirName = baseOf(noteDir);
  const mountRoot = ctx.mountRoot ? norm(ctx.mountRoot) : '';
  const folderPath =
    mountRoot && norm(noteDir).toLowerCase().startsWith(mountRoot.toLowerCase() + '/')
      ? norm(noteDir).slice(mountRoot.length + 1)
      : noteDirName;

  const resolved = template
    .replace(/\{\{([^}]*)\}\}/g, (_m, raw: string) => {
      const token = raw.trim();
      if (token === 'noteFileName') {
        return baseOf(ctx.noteAbs).replace(/\.[^.]+$/, '');
      }
      if (token === 'noteFolderName') return noteDirName;
      if (token === 'noteFolderPath') return folderPath;
      const dm = /^date:(.*)$/.exec(token);
      if (dm) return formatDate(new Date(), dm[1] ?? 'YYYY-MM-DD');
      return '';
    })
    .replace(/\\/g, '/')
    .trim()
    // 空 token 会留下尾巴（`./x/{{nope}}` → `./x/`）；目录路径不需要它。
    .replace(/\/+$/, '');

  if (!resolved) {
    // 模板只剩 `/`（即挂载根）时按挂载根，否则退回笔记目录。
    return template.trim().replace(/\\/g, '/').startsWith('/')
      ? mountRoot || noteDir
      : noteDir;
  }
  // `/x` = 相对挂载根；`./x`、`../x` = 相对笔记目录；其余按笔记目录（vault 根
  // 在库外没有对应物，笔记目录是最贴近的锚点）。
  if (resolved.startsWith('/')) {
    const base = mountRoot || noteDir;
    return joinAbs(base, resolved.replace(/^\/+/, ''));
  }
  return joinAbs(noteDir, resolved.replace(/^\.\//, ''));
}

/**
 * 笔记 → 附件的相对链接路径（POSIX 分隔）。
 * 不在同一棵子树下（跨盘/跨挂载）时退化为文件名，链接仍然可解析。
 */
export function relativeAttachmentLink(noteAbs: string, targetAbs: string): string {
  const from = dirOf(noteAbs).replace(/\\/g, '/').split('/').filter(Boolean);
  const to = targetAbs.replace(/\\/g, '/').split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common += 1;
  }
  const ups = from.length - common;
  // 跨盘（没有公共段，且两边都是绝对路径）时相对路径没有意义。
  if (common === 0 && ups > 0 && /^[A-Za-z]:/.test(noteAbs)) {
    return to[to.length - 1] ?? '';
  }
  const parts = [...Array(ups).fill('..'), ...to.slice(common)];
  return parts.join('/');
}

/** 生成粘贴图片的默认文件名（Obsidian 风格，带时间戳）。 */
function pastedName(mime: string, d: Date): string {
  const ext = mime.split('/')[1]?.split(';')[0]?.toLowerCase() || 'png';
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `Pasted image ${stamp}.${ext === 'jpeg' ? 'jpg' : ext}`;
}

export interface ExternalAttachmentSinkOptions {
  app: App;
  /** 当前库外笔记的绝对路径（视图可能还没载入，故用取值函数）。 */
  noteAbs: () => string;
  mountRoot: () => string;
  /** 宿主块编辑器：用来插入链接并落盘。 */
  editor: () => BlockEditorView | null;
}

/**
 * 把粘贴/拖入的文件落到库外笔记旁边，并在文档里插入链接。
 * 返回 true 表示已处理（调用方据此 preventDefault）。
 */
export async function saveExternalAttachments(
  opts: ExternalAttachmentSinkOptions,
  files: File[],
): Promise<boolean> {
  const noteAbs = opts.noteAbs();
  if (!noteAbs) return false;
  const editor = opts.editor();
  if (!editor) return false;

  const dir = resolveExternalAttachmentDir(opts.app, {
    noteAbs,
    mountRoot: opts.mountRoot(),
  });
  if (!exists(dir)) {
    const made = ensureDir(dir);
    if (!made.ok) {
      new Notice(`无法创建附件目录：${made.error ?? dir}`);
      return false;
    }
  }

  let inserted = 0;
  for (const file of files) {
    const name = file.name || pastedName(file.type || 'image/png', new Date());
    const finalName = uniqueCopyName(dir, name);
    const target = joinAbs(dir, finalName);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      new Notice(`读取附件失败：${String(e).slice(0, 80)}`);
      continue;
    }
    const res = writeExternalBinary(target, bytes);
    if (!res.ok) {
      new Notice(`保存附件失败：${res.error ?? ''}`);
      continue;
    }
    // 图片/视频/音频用嵌入，其余用普通链接（库外文件没有 wikilink 解析）。
    const rel = relativeAttachmentLink(noteAbs, target);
    const label = rel.includes(' ') || rel.includes('(') ? `<${rel}>` : rel;
    const embeddable = /^(png|jpe?g|gif|svg|webp|bmp|mp4|webm|mp3|wav|ogg|mov|pdf)$/.test(
      extOf(finalName),
    );
    const bang = embeddable ? '!' : '';
    editor.insertTopLevelBlock(`${bang}[${finalName}](${label})`, 'raw');
    inserted += 1;
  }

  if (!inserted) return false;
  try {
    await editor.save();
  } catch {
    /* 保存失败不吞掉已经写好的附件 */
  }
  return true;
}

/**
 * 在容器上挂粘贴/拖放处理，返回移除函数。
 * 只在剪贴板/拖入确实带**文件**时接管，纯文本粘贴照旧交给编辑器。
 */
export function installExternalAttachmentHandlers(
  container: HTMLElement,
  opts: ExternalAttachmentSinkOptions,
): () => void {
  const filesOf = (dt: DataTransfer | null): File[] => {
    if (!dt) return [];
    const out: File[] = [];
    for (const item of Array.from(dt.files ?? [])) out.push(item);
    if (!out.length) {
      for (const item of Array.from(dt.items ?? [])) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) out.push(f);
        }
      }
    }
    return out;
  };

  const onPaste = (e: ClipboardEvent): void => {
    const files = filesOf(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    void saveExternalAttachments(opts, files);
  };

  const onDrop = (e: DragEvent): void => {
    const files = filesOf(e.dataTransfer);
    if (!files.length) return;
    // 只接管「从外部拖进来」的文件：块拖拽（dnd.ts）带的是自定义 data，
    // 不带 files，不会被这里截走。
    e.preventDefault();
    void saveExternalAttachments(opts, files);
  };

  container.addEventListener('paste', onPaste as EventListener);
  container.addEventListener('drop', onDrop as EventListener);
  return () => {
    container.removeEventListener('paste', onPaste as EventListener);
    container.removeEventListener('drop', onDrop as EventListener);
  };
}
