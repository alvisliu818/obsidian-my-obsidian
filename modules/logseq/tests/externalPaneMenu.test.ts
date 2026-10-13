/**
 * 库外标签页 ⋮ / 右键菜单：双跳转发、T 形适配器、逃逸路径、菜单构建。
 *
 * 弹窗与真实 fs 操作由 e2e 覆盖（_tab-menu-verify.mjs）；这里用假 menu /
 * 假 host 验证纯逻辑：适配器形状、source 门控、LAST-wins 去重、自建项在转发
 * 之后（因此赢过核心那些对库外假路径无效的同名项）。
 */

import { describe, expect, it } from 'vitest';
import { TFile, type Menu } from 'obsidian';
import {
  buildExternalPaneMenu,
  dedupeMenuByTitle,
  forwardFileMenuEvent,
  makeExternalTFileAdapter,
  makeExternalTFolderAdapter,
  vaultEscapePath,
  type ExternalPaneTarget,
  type PaneMenuHost,
} from '../src/features/externalPaneMenu';
import { renameTarget } from '../src/features/extFs';

// ------------------------------------------------------------------
// fakes
// ------------------------------------------------------------------

interface RecItem {
  title: string;
  section?: string;
  warning?: boolean;
  icon?: string;
  onClick?: () => void;
  sep?: boolean;
}

function fakeMenu(): { items: RecItem[]; addItem(cb: (item: unknown) => void): void; addSeparator(): void } {
  const items: RecItem[] = [];
  return {
    items,
    addItem(cb) {
      const it: RecItem = { title: '' };
      const chain = {
        setTitle(t: string) {
          it.title = t;
          return chain;
        },
        setIcon(i: string) {
          it.icon = i;
          return chain;
        },
        setSection(s: string) {
          it.section = s;
          return chain;
        },
        setWarning(w: boolean) {
          it.warning = w;
          return chain;
        },
        onClick(cb2: () => void) {
          it.onClick = cb2;
          return chain;
        },
      };
      cb(chain);
      items.push(it);
    },
    addSeparator() {
      items.push({ title: '', sep: true });
    },
  };
}

interface TriggerRec {
  name: string;
  file: unknown;
  source: string;
}

function fakeHost(opts: { native?: boolean; extFile?: unknown; popout?: boolean; onFileMenu?: (menu: unknown, file: unknown, source: string) => void } = {}) {
  const triggers: TriggerRec[] = [];
  const revealed: string[] = [];
  const opened: string[] = [];
  let refreshed = 0;
  const viewStates: Array<{ type: string; state: unknown }> = [];
  const handler = (menu: unknown, file: unknown, source: string): void => {
    triggers.push({ name: 'file-menu', file, source });
    opts.onFileMenu?.(menu as Parameters<NonNullable<typeof opts.onFileMenu>>[0], file, source);
  };
  const host: PaneMenuHost & {
    triggers: TriggerRec[];
    revealed: string[];
    opened: string[];
    get refreshed(): number;
    viewStates: typeof viewStates;
  } = {
    app: {
      vault: {
        getAbstractFileByPath: (p: string) => (p.startsWith('file:') ? (opts.extFile ?? null) : null),
        adapter: { getBasePath: () => 'E:/Vault' },
      },
      workspace: {
        trigger: (name: string, ...args: unknown[]) => {
          if (name === 'file-menu') handler(args[0], args[1], String(args[2] ?? ''));
        },
        ...(opts.popout
          ? {
              openPopoutLeaf: () => ({
                setViewState: (vs: { type: string; state: unknown }) => {
                  viewStates.push(vs);
                  return Promise.resolve();
                },
              }),
            }
          : {}),
      },
    } as unknown as PaneMenuHost['app'],
    canOpenNativeExternal: () => opts.native !== false,
    revealInSystem: (abs) => revealed.push(abs),
    openWithSystem: (abs) => opened.push(abs),
    refreshMounts: () => {
      refreshed += 1;
    },
    vaultBasePath: () => 'E:/Vault',
    triggers,
    revealed,
    opened,
    get refreshed() {
      return refreshed;
    },
    viewStates,
  };
  return host;
}

const ABS = 'E:/Other/note.md';

// ------------------------------------------------------------------
// vaultEscapePath
// ------------------------------------------------------------------

describe('vaultEscapePath', () => {
  const vault = { adapter: { getBasePath: () => 'E:/Vault' } };

  it('escapes out of the vault with a ../ chain', () => {
    expect(vaultEscapePath('E:/Other/note.md', vault)).toBe('../Other/note.md');
  });

  it('counts the ups from the common prefix', () => {
    // base E:/Vault (2 parts) vs E:/A/B/c.md → ups = 1
    expect(vaultEscapePath('E:/A/B/c.md', vault)).toBe('../A/B/c.md');
    const deep = { adapter: { getBasePath: () => 'E:/A/B' } };
    expect(vaultEscapePath('E:/A/B/C/d.md', deep)).toBe('C/d.md');
    expect(vaultEscapePath('E:/A/B/c.md', deep)).toBe('c.md');
  });

  it('falls back to the absolute path across drives', () => {
    expect(vaultEscapePath('D:/note.md', vault)).toBe('D:/note.md');
  });

  it('returns the absolute path when the base is unknown', () => {
    expect(vaultEscapePath(ABS, { adapter: {} })).toBe(ABS);
    expect(vaultEscapePath(ABS, {})).toBe(ABS);
  });
});

// ------------------------------------------------------------------
// renameTarget
// ------------------------------------------------------------------

describe('renameTarget', () => {
  it('keeps the parent directory and the original separator', () => {
    expect(renameTarget('E:\\a\\b.md', 'c.md')).toBe('E:\\a\\c.md');
    expect(renameTarget('/a/b.md', 'c.md')).toBe('/a/c.md');
  });

  it('treats a separator-less path as a bare name', () => {
    expect(renameTarget('b.md', 'c.md')).toBe('c.md');
  });
});

// ------------------------------------------------------------------
// T 形适配器
// ------------------------------------------------------------------

describe('makeExternalTFileAdapter', () => {
  const vault = { adapter: { getBasePath: () => 'E:/Vault' } };

  it('passes the instanceof gate and carries resolvable fields', () => {
    const f = makeExternalTFileAdapter(ABS, vault);
    expect(f).not.toBeNull();
    expect(f instanceof TFile).toBe(true);
    expect(f!.path).toBe('../Other/note.md');
    expect(f!.name).toBe('note.md');
    expect(f!.basename).toBe('note');
    expect(f!.extension).toBe('md');
    expect((f!.parent as unknown as { path: string }).path).toBe('E:/Other');
  });

  it('handles extension-less names', () => {
    const f = makeExternalTFileAdapter('E:/Other/Dockerfile', vault);
    expect(f!.name).toBe('Dockerfile');
    expect(f!.basename).toBe('Dockerfile');
    expect(f!.extension).toBe('');
  });
});

describe('makeExternalTFolderAdapter', () => {
  it('carries the folder shape', () => {
    const vault = { adapter: { getBasePath: () => 'E:/Vault' } };
    const f = makeExternalTFolderAdapter('E:/Other/sub', vault);
    expect(f).not.toBeNull();
    expect(f!.path).toBe('../Other/sub');
    expect(f!.name).toBe('sub');
    expect((f as unknown as { isRoot(): boolean }).isRoot()).toBe(false);
  });
});

// ------------------------------------------------------------------
// forwardFileMenuEvent
// ------------------------------------------------------------------

describe('forwardFileMenuEvent', () => {
  it('does nothing when this Obsidian cannot open external files', () => {
    const host = fakeHost({ native: false });
    const menu = fakeMenu();
    expect(forwardFileMenuEvent(host, menu as unknown as Menu, ABS, false, 'logseq-external-pane')).toBe(false);
    expect(host.triggers).toHaveLength(0);
  });

  it('hop-2 only when the TExternalFile lookup misses', () => {
    const host = fakeHost();
    const menu = fakeMenu();
    const ok = forwardFileMenuEvent(host, menu as unknown as Menu, ABS, false, 'logseq-external-pane');
    expect(ok).toBe(false);
    expect(host.triggers).toHaveLength(1);
    expect(host.triggers[0].source).toBe('logseq-external-pane-tfile');
    expect(host.triggers[0].file instanceof TFile).toBe(true);
  });

  it('hop-1 then hop-2 when the lookup hits, and reports hop-1', () => {
    const host = fakeHost({ extFile: { path: `file:/E:/Other/note.md` } });
    const menu = fakeMenu();
    const ok = forwardFileMenuEvent(host, menu as unknown as Menu, ABS, false, 'logseq-external-pane');
    expect(ok).toBe(true);
    expect(host.triggers.map((t) => t.source)).toEqual(['logseq-external-pane', 'logseq-external-pane-tfile']);
  });

  it('uses the -tfolder suffix for folders', () => {
    const host = fakeHost();
    forwardFileMenuEvent(host, fakeMenu() as unknown as Menu, 'E:/Other/sub', true, 'logseq-external-pane');
    expect(host.triggers[0].source).toBe('logseq-external-pane-tfolder');
  });

  it('gives up on hop-2 when a hop-1 handler throws', () => {
    const host = fakeHost({
      extFile: { path: 'file:/E:/Other/note.md' },
      onFileMenu: () => {
        throw new Error('boom');
      },
    });
    const ok = forwardFileMenuEvent(host, fakeMenu() as unknown as Menu, ABS, false, 'logseq-external-pane');
    expect(ok).toBe(false);
    expect(host.triggers).toHaveLength(1); // 只有 hop-1，且没有落到 hop-2
  });

  it('dedupes same-titled items, keeping the last', () => {
    const host = fakeHost({
      onFileMenu: (menu) => {
        const m = menu as unknown as { addItem(cb: (i: unknown) => void): void };
        m.addItem((i) => (i as { setTitle(t: string): unknown }).setTitle('复制绝对路径'));
        m.addItem((i) => (i as { setTitle(t: string): unknown }).setTitle('复制绝对路径'));
      },
    });
    const menu = fakeMenu();
    forwardFileMenuEvent(host, menu as unknown as Menu, ABS, false, 'logseq-external-pane');
    const titles = menu.items.map((i) => i.title).filter(Boolean);
    expect(titles).toEqual(['复制绝对路径']);
  });
});

describe('dedupeMenuByTitle', () => {
  it('keeps separators and the last same-titled item', () => {
    const menu = fakeMenu();
    menu.addItem((i) => (i as { setTitle(t: string): unknown }).setTitle('A'));
    menu.addSeparator();
    menu.addItem((i) => (i as { setTitle(t: string): unknown }).setTitle('B'));
    menu.addItem((i) => (i as { setTitle(t: string): unknown }).setTitle('A'));
    dedupeMenuByTitle(menu as unknown as Menu);
    // 第一个 A 被最后那个顶掉；分隔符没有标题，原样留在原地。
    expect(menu.items.map((i) => i.title || '<sep>')).toEqual(['<sep>', 'B', 'A']);
  });
});

// ------------------------------------------------------------------
// buildExternalPaneMenu
// ------------------------------------------------------------------

describe('buildExternalPaneMenu', () => {
  const target = (over: Partial<ExternalPaneTarget> = {}): ExternalPaneTarget => ({
    abs: ABS,
    fileName: 'note.md',
    ...over,
  });

  it('adds the working items on the real absolute path', () => {
    const host = fakeHost();
    const menu = fakeMenu();
    buildExternalPaneMenu(host, menu as unknown as Menu, target());
    const byTitle = new Map(menu.items.map((i) => [i.title, i]));
    expect(byTitle.get('重命名')?.section).toBe('action');
    expect(byTitle.get('删除文件')?.section).toBe('danger');
    expect(byTitle.get('删除文件')?.warning).toBe(true);
    expect(byTitle.get('在系统资源管理器中显示')?.section).toBe('system');
    expect(byTitle.get('用系统默认应用打开')?.section).toBe('system');
    expect(byTitle.has('复制绝对路径')).toBe(true);
    byTitle.get('在系统资源管理器中显示')!.onClick!();
    byTitle.get('用系统默认应用打开')!.onClick!();
    expect(host.revealed).toEqual([ABS]);
    expect(host.opened).toEqual([ABS]);
  });

  it('puts our items after the forward so a broken same-titled core item loses', () => {
    // 核心 file-explorer 的 file-menu 处理器会给任何 TFile 加一个
    // 「在系统资源管理器中显示」，但它对库外假路径无效——去重 LAST wins，
    // 我们自己的实现必须赢。
    const host = fakeHost({
      onFileMenu: (menu) => {
        const m = menu as unknown as { addItem(cb: (i: unknown) => void): void };
        m.addItem((i) => {
          (i as { setTitle(t: string): unknown }).setTitle('在系统资源管理器中显示');
          (i as { onClick(cb: () => void): unknown }).onClick(() => host.revealed.push('BROKEN'));
        });
      },
    });
    const menu = fakeMenu();
    buildExternalPaneMenu(host, menu as unknown as Menu, target());
    const matches = menu.items.filter((i) => i.title === '在系统资源管理器中显示');
    expect(matches).toHaveLength(1);
    matches[0].onClick!();
    expect(host.revealed).toEqual([ABS]); // 不是 BROKEN
  });

  it('offers the popout item only when popout windows exist', () => {
    const withPopout = fakeHost({ popout: true });
    const menu = fakeMenu();
    buildExternalPaneMenu(withPopout, menu as unknown as Menu, target({ popout: { viewType: 'logseq-external-block', getState: () => ({ abs: ABS }) } }));
    const item = menu.items.find((i) => i.title === '在新窗口中打开');
    expect(item?.section).toBe('open');
    item!.onClick!();
    expect(withPopout.viewStates).toEqual([{ type: 'logseq-external-block', state: { abs: ABS }, active: true }]);

    const noPopout = fakeHost({ popout: false });
    const menu2 = fakeMenu();
    buildExternalPaneMenu(noPopout, menu2 as never, target({ popout: { viewType: 'logseq-external-block', getState: () => ({}) } }));
    expect(menu2.items.some((i) => i.title === '在新窗口中打开')).toBe(false);
  });

  it('still offers our items when the forward cannot run', () => {
    const host = fakeHost({ native: false });
    const menu = fakeMenu();
    buildExternalPaneMenu(host, menu as unknown as Menu, target());
    expect(menu.items.map((i) => i.title)).toContain('重命名');
    expect(menu.items.map((i) => i.title)).toContain('删除文件');
  });
});
