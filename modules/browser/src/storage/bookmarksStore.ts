import type { Bookmark } from "../types";
import type { DataStore } from "./dataStore";

export const UNTAGGED = "未分类";

export class BookmarksStore {
  constructor(private store: DataStore) {}

  private get items(): Bookmark[] {
    return this.store.data.bookmarks;
  }

  list(): Bookmark[] {
    return this.items;
  }

  find(url: string): Bookmark | undefined {
    return this.items.find((b) => b.url === url);
  }

  has(url: string): boolean {
    return !!this.find(url);
  }

  /** Returns true when the bookmark was added, false when it was removed. */
  toggle(entry: { title: string; url: string; favicon?: string }): boolean {
    const hit = this.find(entry.url);
    if (hit) {
      this.items.splice(this.items.indexOf(hit), 1);
      this.store.save();
      return false;
    }
    this.items.unshift({
      id: "bm" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      title: entry.title || entry.url,
      url: entry.url,
      favicon: entry.favicon,
      tags: [],
      createdAt: Date.now(),
    });
    this.store.save();
    return true;
  }

  /** 加标签（去重、保序）；思源 BookmarksDock 同款能力。 */
  addTag(id: string, tag: string): void {
    const clean = tag.trim().replace(/\s+/g, " ").slice(0, 24);
    if (!clean) return;
    const b = this.items.find((x) => x.id === id);
    if (!b) return;
    const tags = b.tags ?? [];
    if (!tags.some((t) => t.toLowerCase() === clean.toLowerCase())) {
      this.update(id, { tags: [...tags, clean] });
    }
  }

  /** 移除单个标签。 */
  removeTag(id: string, tag: string): void {
    const b = this.items.find((x) => x.id === id);
    if (!b?.tags) return;
    this.update(id, { tags: b.tags.filter((t) => t !== tag) });
  }

  update(id: string, patch: Partial<Bookmark>): void {
    const hit = this.items.find((b) => b.id === id);
    if (!hit) return;
    Object.assign(hit, patch);
    this.store.save();
  }

  remove(id: string): void {
    const i = this.items.findIndex((b) => b.id === id);
    if (i >= 0) this.items.splice(i, 1);
    this.store.save();
  }

  allTags(): string[] {
    const set = new Set<string>();
    for (const b of this.items) for (const t of b.tags ?? []) set.add(t);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  /** A bookmark with several tags shows up in every one of its groups. */
  groupByTag(): Map<string, Bookmark[]> {
    const map = new Map<string, Bookmark[]>();
    for (const b of this.items) {
      const tags = (b.tags ?? []).length ? b.tags : [UNTAGGED];
      for (const t of tags) {
        if (!map.has(t)) map.set(t, []);
        map.get(t)!.push(b);
      }
    }
    return map;
  }

  search(keyword: string): Bookmark[] {
    const k = keyword.trim().toLowerCase();
    if (!k) return this.items;
    return this.items.filter(
      (b) =>
        b.title.toLowerCase().includes(k) ||
        b.url.toLowerCase().includes(k) ||
        (b.tags ?? []).some((t) => t.toLowerCase().includes(k)),
    );
  }
}
