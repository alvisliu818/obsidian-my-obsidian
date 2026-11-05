import { HISTORY_DEDUP_WINDOW, HISTORY_HARD_LIMIT } from "../constants";
import type { HistoryEntry } from "../types";
import type { DataStore } from "./dataStore";

export interface HistoryGroup {
  label: string;
  entries: HistoryEntry[];
}

export class HistoryStore {
  constructor(private store: DataStore) {}

  private get items(): HistoryEntry[] {
    return this.store.data.history;
  }

  list(): HistoryEntry[] {
    return this.items;
  }

  get enabled(): boolean {
    return this.store.data.settings.recordHistory;
  }

  get limit(): number {
    return this.store.data.settings.historyLimit;
  }

  /** Same URL inside the dedup window refreshes the existing row. */
  record(url: string, title: string, favicon?: string): void {
    if (!this.enabled || !url) return;
    if (!/^https?:\/\//i.test(url)) return;
    if (this.limit <= 0) return;

    const now = Date.now();
    const hit = this.items.find((h) => h.url === url);
    if (hit && now - hit.visitTime < HISTORY_DEDUP_WINDOW) {
      hit.visitTime = now;
      if (title) hit.title = title;
      if (favicon) hit.favicon = favicon;
      // Move to the top without re-sorting the whole list on every nav.
      this.items.splice(this.items.indexOf(hit), 1);
      this.items.unshift(hit);
    } else {
      if (hit) this.items.splice(this.items.indexOf(hit), 1);
      this.items.unshift({ url, title: title || url, favicon, visitTime: now });
    }

    if (this.items.length > Math.min(this.limit, HISTORY_HARD_LIMIT)) {
      this.items.length = Math.min(this.limit, HISTORY_HARD_LIMIT);
    }
    this.store.save();
  }

  search(keyword: string): HistoryEntry[] {
    const k = keyword.trim().toLowerCase();
    if (!k) return this.items;
    return this.items.filter(
      (h) => h.url.toLowerCase().includes(k) || (h.title || "").toLowerCase().includes(k),
    );
  }

  /** today / yesterday / last 7 days / earlier — same buckets as SiYuan. */
  groupByDate(entries?: HistoryEntry[]): HistoryGroup[] {
    const src = entries ?? this.items;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = 24 * 60 * 60 * 1000;
    const yesterdayStart = todayStart - day;
    const sevenDaysAgo = todayStart - 7 * day;

    const groups: HistoryGroup[] = [
      { label: "今天", entries: [] },
      { label: "昨天", entries: [] },
      { label: "7 天内", entries: [] },
      { label: "更早", entries: [] },
    ];
    for (const e of src) {
      if (e.visitTime >= todayStart) groups[0].entries.push(e);
      else if (e.visitTime >= yesterdayStart) groups[1].entries.push(e);
      else if (e.visitTime >= sevenDaysAgo) groups[2].entries.push(e);
      else groups[3].entries.push(e);
    }
    return groups.filter((g) => g.entries.length > 0);
  }

  clearByDate(dateKey: string): void {
    const [y, m, d] = dateKey.split("-").map(Number);
    if (!y || !m || !d) return;
    const start = new Date(y, m - 1, d).getTime();
    const end = start + 24 * 60 * 60 * 1000;
    const kept = this.items.filter((h) => h.visitTime < start || h.visitTime >= end);
    if (kept.length !== this.items.length) {
      this.store.data.history = kept;
      this.store.save();
    }
  }

  clear(): void {
    this.store.data.history = [];
    this.store.save();
  }

  remove(url: string): void {
    const i = this.items.findIndex((h) => h.url === url);
    if (i >= 0) {
      this.items.splice(i, 1);
      this.store.save();
    }
  }
}
