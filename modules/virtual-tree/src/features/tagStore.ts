/**
 * 虚拟文档树标签（思源 tag-store.ts 对齐）：文件/文件夹打标签，树行徽标 +
 * 面板筛选。数据落在模块设置（tags/fileTags 字段），与收藏/最近打开同款存储。
 */
import type { TagDef, VirtualTreeSettings } from '../types';
import { TAGS_CHANGED_EVENT } from '../types';

const TAG_PALETTE = ['#eac54f', '#7bd17b', '#7ab8f5', '#f0a0c8', '#b48ef5'];

export function allTags(settings: VirtualTreeSettings): TagDef[] {
  return settings.tags ?? [];
}

export function tagById(settings: VirtualTreeSettings, id: string): TagDef | undefined {
  return allTags(settings).find((t) => t.id === id);
}

/** 新建标签（颜色缺省取调色板轮转）。 */
export function addTag(settings: VirtualTreeSettings, name: string, color?: string): TagDef {
  const tags = allTags(settings);
  const id = 'tag-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const def: TagDef = {
    id,
    name: name.trim(),
    color: color || TAG_PALETTE[tags.length % TAG_PALETTE.length],
  };
  settings.tags = [...tags, def];
  emitTagsChanged();
  return def;
}

export function removeTag(settings: VirtualTreeSettings, id: string): void {
  settings.tags = allTags(settings).filter((t) => t.id !== id);
  const ft = { ...(settings.fileTags ?? {}) };
  for (const p of Object.keys(ft)) {
    ft[p] = (ft[p] ?? []).filter((t) => t !== id);
    if (!ft[p].length) delete ft[p];
  }
  settings.fileTags = ft;
  emitTagsChanged();
}

export function fileTagIds(settings: VirtualTreeSettings, abs: string): string[] {
  return (settings.fileTags ?? {})[abs] ?? [];
}

export function fileHasTag(settings: VirtualTreeSettings, abs: string, tagId: string): boolean {
  return fileTagIds(settings, abs).includes(tagId);
}

export function addTagToPath(settings: VirtualTreeSettings, abs: string, tagId: string): void {
  const ft = { ...(settings.fileTags ?? {}) };
  const ids = ft[abs] ?? [];
  if (!ids.includes(tagId)) ids.push(tagId);
  ft[abs] = ids;
  settings.fileTags = ft;
  emitTagsChanged();
}

export function removeTagFromPath(settings: VirtualTreeSettings, abs: string, tagId: string): void {
  const ft = { ...(settings.fileTags ?? {}) };
  ft[abs] = (ft[abs] ?? []).filter((t) => t !== tagId);
  if (!ft[abs].length) delete ft[abs];
  settings.fileTags = ft;
  emitTagsChanged();
}

/** 路径是否命中标签筛选（命中任一即保留；筛选空 = 全保留）。 */
export function pathMatchesTagFilter(
  settings: VirtualTreeSettings,
  abs: string,
  activeTagIds: string[],
): boolean {
  if (!activeTagIds.length) return true;
  const ids = fileTagIds(settings, abs);
  return activeTagIds.some((id) => ids.includes(id));
}

/** 变更广播（面板重渲染）。 */
export function emitTagsChanged(target?: Window | null): void {
  try {
    (target ?? window).dispatchEvent(new CustomEvent(TAGS_CHANGED_EVENT));
  } catch {
    /* ignore */
  }
}
