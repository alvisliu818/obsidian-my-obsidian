/**
 * 内核托盘（R2c，docs/kernel-separation-design.md §6.7）。
 *
 * systray2 的 JS（纯 JS，含 debug/fs-extra 传递依赖）**打进 daemon bundle**；
 * 唯一边车是 traybin/<platform> 二进制（deploy.mjs 复制，helper 按
 * __dirname/traybin 解析=bundle 所在插件目录）。helper 协议探针实测要点
 * （tmp/_probe-tray.mjs，2026-11-05）：
 *   - CJS default 双层包装：require('systray2').default 才是类
 *   - onError 必须 ready() 之后注册（构造后同步注册时 _process 尚为 null 会崩）
 *   - kill(exitNode=false)——默认 true 会顺手 process.exit 杀宿主
 *   - MenuItem 无 id，点击事件按 title 分发
 * 降级纪律：任何失败（依赖缺/icon 缺/spawn 失败）→ 返回 null，内核无头继续。
 * 本文件只服务 daemon bundle——渲染进程侧勿 import（require 不可解析）。
 */

import path from 'node:path';
import type SysTrayNS from 'systray2';

export interface TrayActions {
  onOpen(): void;
  onSync(): void;
  onExit(): void;
}

export interface TrayHandle {
  /** 优雅杀 helper（exitNode=false，不杀宿主）。 */
  kill(): Promise<void>;
  /** 同步杀（process 'exit' 钩子/gracefulStop 用，防孤儿图标）。 */
  killSync(): void;
  /** 运行时改托盘名（客户端 setConfig 推送 app.vault.getName() 显示名，
   *  比 spawn argv 的路径 basename 更准——用户改过库名时以它为准）。
   *  helper 已死/不支持时静默降级，绝不影响内核主链路。 */
  setVaultName(name: string): void;
}

const ITEM_OPEN = '打开 Obsidian';
const ITEM_SYNC = '增量索引';
const ITEM_EXIT = '退出内核';

export function startKernelTray(
  actions: TrayActions,
  opts?: { iconDir?: string; vaultName?: string },
): TrayHandle | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SysTray = require('systray2').default as typeof SysTrayNS;
    // 图标：<bundle 目录>/assets/kernel.ico（bundle 跑在插件目录=部署边车；
    // smoke 场景经 iconDir 覆盖）。
    const dir = opts?.iconDir ?? path.dirname(process.argv[1] ?? '.');
    const iconPath = path.join(dir, 'assets', 'kernel.ico');
    let icon = '';
    try {
      icon = require('fs').readFileSync(iconPath).toString('base64');
    } catch {
      process.stderr.write(`[kernel-tray] icon missing (${iconPath}), tray disabled\n`);
      return null;
    }
    // 提示名跟库名走（2026-11-17 用户需求）：多库各一个内核托盘时肉眼可辨，
    // 不再是一排同名 MyKernel。displayName 缺省回落 argv 路径 basename。
    let vaultName = (opts?.vaultName ?? '').trim() || 'MyKernel';
    const tray = new SysTray({
      menu: {
        icon,
        title: vaultName,
        tooltip: `${vaultName} · 索引内核运行中`,
        items: [
          { title: ITEM_OPEN, tooltip: '在 Obsidian 中打开本库' },
          { title: ITEM_SYNC, tooltip: '增量索引变更文件' },
          SysTray.separator,
          { title: ITEM_EXIT, tooltip: '优雅停止索引内核' },
        ],
      },
      debug: false,
    });
    const dispatch = (title: string): void => {
      process.stderr.write(`[kernel-tray] click: ${title}\n`);
      if (title === ITEM_OPEN) actions.onOpen();
      else if (title === ITEM_SYNC) actions.onSync();
      else if (title === ITEM_EXIT) actions.onExit();
      else process.stderr.write(`[kernel-tray] click unmatched\n`);
    };
    void tray
      .ready()
      .then(() => {
        try {
          tray.onError((e) => process.stderr.write(`[kernel-tray] error: ${String(e).slice(0, 120)}\n`));
        } catch {
          /* systray2 quirk: 见文件头 */
        }
        return tray.onClick((a) => dispatch(String(a.item?.title ?? '')));
      })
      .catch((e: unknown) => {
        process.stderr.write(`[kernel-tray] init failed: ${String(e).slice(0, 120)}\n`);
      });
    return {
      kill: () => tray.kill(false),
      killSync: () => {
        try {
          tray.process.kill();
        } catch {
          /* 已死 */
        }
      },
      setVaultName: (name: string) => {
        const trimmed = name.trim();
        if (!trimmed || trimmed === vaultName) return;
        vaultName = trimmed;
        void tray
          .sendAction({
            type: 'update-menu',
            menu: {
              icon,
              title: vaultName,
              tooltip: `${vaultName} · 索引内核运行中`,
              items: [
                { title: ITEM_OPEN, tooltip: '在 Obsidian 中打开本库' },
                { title: ITEM_SYNC, tooltip: '增量索引变更文件' },
                SysTray.separator,
                { title: ITEM_EXIT, tooltip: '优雅停止索引内核' },
              ],
            },
          })
          .catch((e: unknown) => {
            process.stderr.write(`[kernel-tray] rename failed: ${String(e).slice(0, 120)}\n`);
          });
      },
    };
  } catch (e) {
    process.stderr.write(`[kernel-tray] unavailable: ${String(e).slice(0, 120)}\n`);
    return null;
  }
}
