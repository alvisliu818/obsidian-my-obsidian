// 虚拟文档树(mountPanel)顶栏工具栏:注册表 + 配置归一 + 「编辑工具栏」面板。
//
// 结构移植自思源虚拟文档树 mount-tree-dock 的工具栏:
//   - 整条顶栏都是按钮,按「注册表 + 用户配置」渲染;
//   - 每个按钮在「编辑工具栏」里二选一归属:开关开 = 顶栏,开关关 = 收进「更多」菜单;
//   - 「更多」本身固定在顶栏(它是编辑入口),菜单里是收进去的按钮(按顶栏同序)
//     + 固定的「编辑工具栏…」项;
//   - 配置(order + hidden)持久化在设置里,改动即时生效。
//
// 与思源版的差异:思源按钮集里还有标签筛选/回收站/重新加载标签这类它自己的
// 域内动作,本面板没有对应能力,不设占位按钮。
import { Modal, setIcon } from 'obsidian';

export interface PanelToolbarButton {
  /** 配置里的唯一标识 */
  key: string;
  /** 悬停提示与菜单文案 */
  label: string;
  /** lucide 图标名(setIcon) */
  icon: string;
}

export const PANEL_TOOLBAR_BUTTONS: PanelToolbarButton[] = [
  { key: 'locate', label: '定位当前文件', icon: 'crosshair' },
  { key: 'new-file', label: '在当前目录新建文件', icon: 'file-plus' },
  { key: 'new-folder', label: '在当前目录新建文件夹', icon: 'folder-plus' },
  { key: 'mount', label: '添加挂载', icon: 'plus' },
  { key: 'git-mount', label: '挂载 Git 仓库…', icon: 'git-branch' },
  { key: 'baidu-mount', label: '挂载百度网盘…', icon: 'cloud' },
  { key: 'drag-mode', label: '拖拽排序模式', icon: 'arrow-up-down' },
  { key: 'refresh', label: '重新扫描', icon: 'refresh-cw' },
  { key: 'collapse-all', label: '全部收起', icon: 'chevrons-down-up' },
];

/** 「更多」是编辑入口,固定在顶栏(收进更多就没法再打开配置) */
export const PANEL_TOOLBAR_FIXED = 'more';

export interface PanelToolbarCfg {
  /** 按钮顺序(key 列表;空 = 注册表默认顺序) */
  order: string[];
  /** 收进「更多」的按钮 key(默认收起低频动作,对齐思源 MENU_ONLY_DEFAULTS) */
  hidden: string[];
}

/** 默认收进「更多」的按钮:新建走右键菜单更顺手,顶栏只留高频动作 */
export const PANEL_MENU_ONLY_DEFAULTS = ['new-file', 'new-folder'];

export function panelToolbarButtonByKey(key: string): PanelToolbarButton | undefined {
  return PANEL_TOOLBAR_BUTTONS.find((b) => b.key === key);
}

export function defaultPanelToolbarCfg(): PanelToolbarCfg {
  return { order: [], hidden: [...PANEL_MENU_ONLY_DEFAULTS] };
}

/** 归一:order 补注册表新增按钮(自动进末尾)、去已下线;hidden 只留已知 key */
export function resolvePanelToolbar(cfg: PanelToolbarCfg | null | undefined): { order: string[]; hidden: Set<string> } {
  const known = PANEL_TOOLBAR_BUTTONS.map((b) => b.key);
  const src = cfg ?? defaultPanelToolbarCfg();
  const order = src.order.filter((k) => known.includes(k));
  for (const k of known) {
    if (!order.includes(k)) order.push(k);
  }
  const hidden = new Set((src.hidden ?? []).filter((k) => known.includes(k) && k !== PANEL_TOOLBAR_FIXED));
  return { order, hidden };
}

/**
 * 「编辑工具栏」面板:每个按钮一个开关(开 = 顶栏 / 关 = 收进「更多」)+ ↑↓ 排序,
 * 改动即时回调(调用方负责渲染与持久化),交互与思源版一致。
 */
export class PanelToolbarEditorModal extends Modal {
  constructor(
    app: unknown,
    private cfg: PanelToolbarCfg,
    private onChange: (cfg: PanelToolbarCfg) => void,
  ) {
    super(app as never);
  }

  onOpen(): void {
    this.contentEl.addClass('lgp-tbedit');
    this.contentEl.createDiv({
      cls: 'lgp-tbedit__hint',
      text: '开关开 = 显示在顶栏;开关关 = 收进「更多」菜单(不占顶栏)。↑↓ 调整顺序,「更多」菜单里的按钮同样按此顺序;「更多」本身固定在顶栏。改动即时生效。',
    });
    const rowsEl = this.contentEl.createDiv({ cls: 'lgp-tbedit__rows' });
    const barEl = this.contentEl.createDiv({ cls: 'lgp-tbedit__bar' });

    const renderRows = (): void => {
      rowsEl.empty();
      const { order } = resolvePanelToolbar(this.cfg);
      order.forEach((key, idx) => {
        const b = panelToolbarButtonByKey(key);
        if (!b) return;
        const row = rowsEl.createDiv({ cls: 'lgp-tbedit__row' });
        const toggle = row.createEl('input', { type: 'checkbox' });
        toggle.checked = !this.cfg.hidden.includes(key);
        toggle.addEventListener('change', () => {
          const hidden = new Set(this.cfg.hidden);
          if (toggle.checked) hidden.delete(key);
          else hidden.add(key);
          this.cfg = { order: this.cfg.order, hidden: [...hidden] };
          this.onChange(this.cfg);
          renderRows();
        });
        const iconEl = row.createSpan({ cls: 'lgp-tbedit__icon' });
        setIcon(iconEl, b.icon);
        row.createSpan({ cls: 'lgp-tbedit__label', text: b.label });
        row.createDiv({ cls: 'lgp-tbedit__spacer' });
        const upBtn = row.createEl('button', {
          cls: 'clickable-icon lgp-tbedit__move',
          attr: { 'aria-label': '上移' },
        });
        setIcon(upBtn, 'arrow-up');
        upBtn.disabled = idx === 0;
        upBtn.addEventListener('click', () => {
          const order2 = resolvePanelToolbar(this.cfg).order;
          if (idx === 0) return;
          [order2[idx - 1], order2[idx]] = [order2[idx], order2[idx - 1]];
          this.cfg = { order: order2, hidden: this.cfg.hidden };
          this.onChange(this.cfg);
          renderRows();
        });
        const downBtn = row.createEl('button', {
          cls: 'clickable-icon lgp-tbedit__move',
          attr: { 'aria-label': '下移' },
        });
        setIcon(downBtn, 'arrow-down');
        downBtn.disabled = idx >= order.length - 1;
        downBtn.addEventListener('click', () => {
          const order2 = resolvePanelToolbar(this.cfg).order;
          if (idx >= order2.length - 1) return;
          [order2[idx + 1], order2[idx]] = [order2[idx], order2[idx + 1]];
          this.cfg = { order: order2, hidden: this.cfg.hidden };
          this.onChange(this.cfg);
          renderRows();
        });
      });
    };
    renderRows();

    const resetBtn = barEl.createEl('button', { text: '恢复默认', cls: 'mod-cta' });
    resetBtn.addEventListener('click', () => {
      this.cfg = defaultPanelToolbarCfg();
      this.onChange(this.cfg);
      renderRows();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
