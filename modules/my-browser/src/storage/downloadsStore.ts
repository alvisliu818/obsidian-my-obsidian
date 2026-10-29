import type { DownloadItem, DownloadState } from "../types";
import type { DataStore } from "./dataStore";

export class DownloadsStore {
  constructor(private store: DataStore) {}

  private get items(): DownloadItem[] {
    return this.store.data.downloads;
  }

  list(): DownloadItem[] {
    return this.items;
  }

  create(init: { url: string; filename: string }): DownloadItem {
    const item: DownloadItem = {
      id: "dl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      url: init.url,
      filename: init.filename,
      savePath: "",
      total: 0,
      received: 0,
      state: "in_progress",
      startedAt: Date.now(),
    };
    this.items.unshift(item);
    this.store.save();
    return item;
  }

  progress(id: string, received: number, total: number): void {
    const hit = this.items.find((d) => d.id === id);
    if (!hit) return;
    hit.received = received;
    if (total) hit.total = total;
    // Progress ticks are frequent: notify the UI but let the debounced writer
    // decide when to touch the disk.
    this.store.notify();
  }

  setState(id: string, state: DownloadState, error?: string): void {
    const hit = this.items.find((d) => d.id === id);
    if (!hit) return;
    hit.state = state;
    if (error) hit.error = error;
    if (state !== "in_progress") hit.finishedAt = Date.now();
    this.store.save();
  }

  setSavePath(id: string, savePath: string): void {
    const hit = this.items.find((d) => d.id === id);
    if (!hit) return;
    hit.savePath = savePath;
    this.store.save();
  }

  remove(id: string): void {
    const i = this.items.findIndex((d) => d.id === id);
    if (i >= 0) this.items.splice(i, 1);
    this.store.save();
  }

  clearCompleted(): void {
    this.store.data.downloads = this.items.filter((d) => d.state !== "completed");
    this.store.save();
  }
}
