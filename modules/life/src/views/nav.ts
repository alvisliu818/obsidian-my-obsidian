/**
 * Life 侧边导航面板（2026-11-24 用户）：习惯 / 代办 / 计划 / 计时等面板
 * 收进一个侧栏列表，点一项就在主区标签页打开对应面板。
 *
 * 为什么单独做 ItemView 而不是继续用 ribbon 菜单：菜单是一次性的、关掉
 * 就找不到；侧栏常驻，能一眼看到全部入口并标出当前打开的面板。
 * 清单里的 viewType 全部复用 life 已有面板，不新建功能视图。
 */
import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';
import type LifePlugin from '../main';
import { VIEW_LIFE_HOME } from './home';
import { VIEW_LIFE_VAULTLOG } from './vaultlog';
import { VIEW_LIFE_CLOCK } from './clock';
import { VIEW_LIFE_TIMER } from './timer';
import { VIEW_LIFE_DDAY } from './dday';
import { VIEW_LIFE_TODO } from './todo';
import { VIEW_LIFE_TASKS } from './tasks';
import { VIEW_LIFE_HABITS } from './habits';
import { VIEW_LIFE_CALENDAR } from './calendar';
import { VIEW_LIFE_PLANS } from './plans';
import { VIEW_LIFE_LEDGER } from './ledger';

export const VIEW_LIFE_NAV = 'life-nav';

interface NavItem {
  type: string;
  name: string;
  icon: string;
}

/** 用户点名的四项放最前；任务与代办同类，紧随其后。 */
const PRIMARY: NavItem[] = [
  { type: VIEW_LIFE_HABITS, name: '习惯', icon: 'flame' },
  { type: VIEW_LIFE_TODO, name: '代办', icon: 'list-checks' },
  { type: VIEW_LIFE_TASKS, name: '任务', icon: 'square-check-big' },
  { type: VIEW_LIFE_PLANS, name: '计划', icon: 'calendar-range' },
  { type: VIEW_LIFE_TIMER, name: '计时', icon: 'timer' },
];

/** 其余 life 面板也一并列出，免得侧栏和 ribbon 菜单两套入口内容不一致。 */
const MORE: NavItem[] = [
  { type: VIEW_LIFE_HOME, name: 'HOME', icon: 'home' },
  { type: VIEW_LIFE_VAULTLOG, name: '库记录', icon: 'archive' },
  { type: VIEW_LIFE_CLOCK, name: '时钟', icon: 'clock' },
  { type: VIEW_LIFE_DDAY, name: '倒数日', icon: 'calendar-clock' },
  { type: VIEW_LIFE_CALENDAR, name: '大日历', icon: 'calendar-days' },
  { type: VIEW_LIFE_LEDGER, name: '记账', icon: 'wallet' },
];

export class LifeNavView extends ItemView {
  plugin: LifePlugin;

  constructor(leaf: WorkspaceLeaf, plugin: LifePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_LIFE_NAV;
  }

  getDisplayText(): string {
    return '生活面板';
  }

  getIcon(): string {
    return 'life-buoy';
  }

  async onOpen(): Promise<void> {
    await super.onOpen();
    this.containerEl.addClass('life-nav-view');
    this.render();
    // 当前高亮跟随标签页切换；生命周期由 ItemView 的 Component 托管。
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshActive()));
  }

  /** 重画列表（视图数量固定，开销可忽略）。 */
  render(): void {
    const root = this.contentEl;
    root.empty();
    this.addGroup(root, '常用', PRIMARY);
    this.addGroup(root, '更多面板', MORE);
    this.refreshActive();
  }

  private addGroup(root: HTMLElement, label: string, items: NavItem[]): void {
    root.createDiv({ cls: 'life-nav-group-title', text: label });
    for (const item of items) {
      const row = root.createDiv({ cls: 'life-nav-item' });
      row.dataset.viewType = item.type;
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      const icon = row.createSpan({ cls: 'life-nav-icon' });
      setIcon(icon, item.icon);
      row.createSpan({ cls: 'life-nav-label', text: item.name });
      const open = (): void => void this.plugin.openPanelInTab(item.type);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          open();
        }
      });
    }
  }

  /** 给当前工作区的面板对应的行加 is-active（侧栏自身不算）。 */
  private refreshActive(): void {
    const activeType = this.app.workspace.activeLeaf?.view?.getViewType?.() ?? '';
    for (const el of this.contentEl.querySelectorAll<HTMLElement>('.life-nav-item')) {
      el.toggleClass('is-active', el.dataset.viewType === activeType);
    }
  }
}
