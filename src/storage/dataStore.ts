import type { Plugin } from "obsidian";
import { DEFAULT_DATA } from "../constants";
import type { PluginData } from "../types";

/**
 * Obsidian's loadData/saveData own ONE JSON blob for the whole plugin, so all
 * five collections live in a single object here. Writes are debounced: history
 * is appended on every navigation and a full re-serialize per keystroke would
 * be wasteful (the SiYuan plugin had this exact problem at 50k entries).
 */
export class DataStore {
  data: PluginData;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;

  constructor(private plugin: Plugin) {
    this.data = JSON.parse(JSON.stringify(DEFAULT_DATA)) as PluginData;
  }

  async load(): Promise<void> {
    const raw = (await this.plugin.loadData()) as Partial<PluginData> | null;
    const merged = JSON.parse(JSON.stringify(DEFAULT_DATA)) as PluginData;
    if (raw && typeof raw === "object") {
      if (raw.settings) Object.assign(merged.settings, raw.settings);
      if (Array.isArray(raw.bookmarks)) merged.bookmarks = raw.bookmarks;
      if (Array.isArray(raw.history)) merged.history = raw.history;
      if (Array.isArray(raw.downloads)) merged.downloads = raw.downloads;
      if (Array.isArray(raw.extensions)) merged.extensions = raw.extensions;
      if (Array.isArray(raw.session)) merged.session = raw.session;
    }
    this.data = merged;
    this.notify();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    for (const fn of Array.from(this.listeners)) {
      try {
        fn();
      } catch (e) {
        console.error("[obsidian-browser] store listener failed", e);
      }
    }
  }

  /** Debounced persist + immediate UI notification. */
  save(): void {
    this.notify();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, 800);
  }

  saveNow(): Promise<void> {
    if (this.pending) return this.pending;
    const snapshot = JSON.parse(JSON.stringify(this.data)) as PluginData;
    this.pending = this.plugin
      .saveData(snapshot)
      .catch((e) => console.error("[obsidian-browser] saveData failed", e))
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    return this.saveNow();
  }
}
