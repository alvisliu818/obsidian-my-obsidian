/**
 * 移动到…/复制到…（思源 dest-picker 对齐）：
 * 目录选择器浏览所有已启用的**库外目录挂载**（远端不可作为目的地），
 * move = copyEntry 成功后把源送进系统回收站（安全侧），copy 直接落盘。
 */
import { App, Modal, Notice } from 'obsidian';
import type { ExternalMount } from '../types';
import { isRemoteMount } from '../types';
import { copyEntry, trashEntry } from './extFs';

export interface DestPickOptions {
  title: string;
  srcAbs: string;
  srcName: string;
  srcIsDir: boolean;
  /** true = 移动（复制成功后源进回收站）；false = 复制。 */
  move: boolean;
  onDone?: (destPath: string) => void;
}

function joinDest(dir: string, name: string): string {
  return dir.replace(/\/+$/, '') + '/' + name;
}

function parentOf(dir: string): string {
  return dir.split('/').slice(0, -1).join('/');
}

/** 收集可用作目的地的库外目录挂载（enabled + 非远端 + 目录）。 */
function destMountRoots(mounts: ExternalMount[]): ExternalMount[] {
  return (mounts ?? []).filter((m) => m.enabled && !isRemoteMount(m));
}

/** 打开移动/复制确认流：先选目标目录，再落盘。 */
export function promptMoveCopy(
  app: App,
  mounts: ExternalMount[],
  opts: DestPickOptions,
): void {
  DestPickerModal.openFor(app, mounts, opts);
}

export class DestPickerModal extends Modal {
  /** 面板菜单直开的便捷入口。 */
  static openFor(app: App, mounts: ExternalMount[], opts: DestPickOptions): void {
    new DestPickerModal(app, mounts, opts).open();
  }

  constructor(
    app: App,
    private mounts: ExternalMount[],
    private opts: DestPickOptions,
  ) {
    super(app as never);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.opts.title });
    const note = contentEl.createDiv();
    note.setText(this.opts.srcName + ' → 选择目标目录');
    note.style.cssText = 'color:var(--text-muted);font-size:12px;margin-bottom:8px;word-break:break-all';
    const list = contentEl.createDiv();
    list.style.cssText = 'max-height:50vh;overflow:auto';
    const roots = destMountRoots(this.mounts);
    if (!roots.length) {
      list.createDiv({ text: '没有可用的库外目录挂载' });
      return;
    }
    let curRoot: ExternalMount | null = null;
    let curDir = '';
    const crumb = contentEl.createDiv();
    crumb.style.cssText = 'font-size:11px;color:var(--text-faint);margin-bottom:6px;word-break:break-all';
    const renderRows = async (): Promise<void> => {
      list.empty();
      const rows: { name: string; abs: string; isDir: boolean }[] = [];
      if (!curRoot) {
        for (const r of roots) rows.push({ name: r.label, abs: r.path, isDir: true });
      } else {
        const absDir = curDir || curRoot.path;
        try {
          const req = (window as any).require;
          const fsx = req('fs');
          for (const d of fsx.readdirSync(absDir, { withFileTypes: true })) {
            if (d.name.startsWith('.')) continue;
            rows.push({ name: d.name, abs: joinDest(absDir, d.name), isDir: d.isDirectory() });
          }
        } catch (e) {
          list.createDiv({ text: '读取目录失败：' + String((e as Error)?.message ?? e) });
        }
      }
      for (const row of rows) {
        const el = list.createDiv();
        el.style.cssText = 'padding:4px 8px;cursor:pointer;border-radius:4px';
        el.setText((row.isDir ? '📁 ' : '') + row.name);
        el.addEventListener('mouseenter', () => (el.style.background = 'var(--background-modifier-hover)'));
        el.addEventListener('mouseleave', () => (el.style.background = ''));
        el.addEventListener('click', async () => {
          if (!row.isDir) {
            new Notice('目标必须是目录');
            return;
          }
          if (!curRoot) {
            curRoot = this.mounts.find((m) => m.path === row.abs) ?? null;
            curDir = row.abs;
          } else {
            curDir = row.abs;
          }
          crumb.setText(curDir);
          await renderRows();
        });
      }
      if (curRoot) {
        const pick = list.createDiv();
        pick.style.cssText = 'padding:6px 8px;cursor:pointer;color:var(--text-accent)';
        pick.setText('✓ 使用当前目录作为目标');
        pick.addEventListener('click', () => void this.commit(curDir));
      }
    };
    void renderRows();
    const nav = contentEl.createDiv();
    const back = nav.createEl('button', { text: '返回上级' });
    back.addEventListener('click', () => {
      if (!curRoot) return;
      const parent = parentOf(curDir);
      curDir = parent.length >= curRoot.path.length ? parent : curRoot.path;
      crumb.setText(curDir);
      void renderRows();
    });
    const here = nav.createEl('button', { text: '使用当前目录' });
    here.style.marginLeft = '8px';
    here.addEventListener('click', () => {
      if (curRoot) void this.commit(curDir);
    });
  }
  onClose(): void {
    this.contentEl.empty();
  }
  private async commit(destDir: string): Promise<void> {
    try {
      if (this.opts.move) {
        await moveExternalTo(this.opts.srcAbs, destDir);
        new Notice('已移动到 ' + destDir);
      } else {
        await copyExternalTo(this.opts.srcAbs, destDir);
        new Notice('已复制到 ' + destDir);
      }
      this.opts.onDone?.(destDir);
      this.close();
    } catch (e: any) {
      new Notice((this.opts.move ? '移动失败：' : '复制失败：') + String(e?.message ?? e));
    }
  }
}

/** 移动：复制到目标 → 源送进系统回收站（安全侧，可恢复）。 */
export async function moveExternalTo(srcAbs: string, destDir: string): Promise<void> {
  const dest = joinDest(destDir, srcAbs.split(/[\\/]/).pop() ?? 'file');
  if (dest === srcAbs) throw new Error('源与目标是同一位置');
  const copy = copyEntry(srcAbs, destDir);
  if (!copy.ok) throw new Error(copy.error || '复制失败');
  const del = await trashEntry(srcAbs);
  if (!del.ok) {
    new Notice('源文件进回收站失败，目标已复制（源保留）');
  }
}

/** 复制：直接 copyEntry（碰撞自动加后缀）。 */
export async function copyExternalTo(srcAbs: string, destDir: string): Promise<void> {
  const copy = copyEntry(srcAbs, destDir);
  if (!copy.ok) throw new Error(copy.error || '复制失败');
}
