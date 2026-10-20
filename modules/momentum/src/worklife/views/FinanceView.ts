import { ItemView, WorkspaceLeaf } from "obsidian";

import { VIEW_TYPE_FINANCE } from "../constants";
import type CalendarPlugin from "../main";
import FinanceTracker from "../finance/FinanceTracker.svelte";
import { tRaw } from "../i18n";

export default class FinanceView extends ItemView {
  private svelteComponent: FinanceTracker | null = null;

  constructor(leaf: WorkspaceLeaf, _plugin: CalendarPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_FINANCE;
  }

  getDisplayText(): string {
    return tRaw("hello.navFinance");
  }

  getIcon(): string {
    return "coins";
  }

  onOpen(): Promise<void> {
    if (this.svelteComponent) { this.svelteComponent.$destroy(); this.svelteComponent = null; }
    const container: HTMLElement = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("finance-view-container");

    this.svelteComponent = new FinanceTracker({
      target: container,
    });
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    if (this.svelteComponent) {
      this.svelteComponent.$destroy();
      this.svelteComponent = null;
    }
    return Promise.resolve();
  }
}
