/**
 * Opener registry for out-of-vault files (2026-10-27 module split).
 *
 * virtual-tree owns the ROUTING (`openExternalEntry`): media → its own viewers,
 * binary → the system, and everything text-shaped → a registered opener. The
 * editors themselves live in higher layers — logseq owns the markdown/block
 * routes (its parser is bound into ExternalBlockView/ExternalFileView), and
 * the code-editor module owns the code route — so they REGISTER here instead
 * of being imported (virtual-tree is the bottom layer and must not import them).
 *
 * Openers are registered at the owning module's onload and removed on unload
 * (or when the module is disabled). An opener that declines returns false and
 * the next one in line gets the file; when none accepts, the caller falls
 * back to a Notice rather than silently doing nothing.
 */

import type { ExternalMount } from './types';
import type { MountNode } from './features/mountFilter';

/** Options handed down from the entry's context menu (read-only, force routes). */
export type ExternalOpenOpts = {
  readOnly?: boolean;
  forceCodeEditor?: boolean;
  forceBlockEditor?: boolean;
  /**
   * 修饰键点击（Ctrl/Cmd/中键）的叶子语义：Keymap.isModEvent 的返回值
   * （open-tab-settings 模块在此改写 modClickBehavior，可能是不透明的
   * 装饰串，getLeaf 原样透传即可）。缺省 = 普通点击，按各自 split 设置。
   */
  paneMode?: string | boolean;
};

/** Which route an opener serves; `openExternalEntry` tries them in this order. */
export type OpenerRoute = 'markdown' | 'code' | 'shim';

/** The virtual-tree instance, so an opener can read mount settings (split view…). */
export interface OpenerCtx {
  // Structural type rather than a class import: keeps this file free of the
  // plugin module (and therefore trivially unit-testable).
  // No `& Record<string, unknown>`: the plugin's settings is an interface
  // (no implicit index signature), so a structural subset is the only
  // assignment-compatible shape; openers read exactly these fields.
  virtualTree: {
    settings: { externalSplitView: boolean };
  };
}

export interface ExternalOpener {
  /** Owner tag for removal (the registering module's id, e.g. 'logseq'). */
  owner: string;
  route: OpenerRoute;
  /** true = handled; false = decline, try the next opener on this route. */
  open(ctx: OpenerCtx, mount: ExternalMount, node: MountNode, opts?: ExternalOpenOpts): Promise<boolean>;
}

const registry: ExternalOpener[] = [];

/** Register one opener (called by the owning module's onload). */
export function registerOpener(opener: ExternalOpener): void {
  removeOpener(opener.owner, opener.route);
  registry.push(opener);
}

/**
 * Drop one opener slot — same owner re-registering its route. Keeping this
 * separate from removeOpeners lets a module refresh one route (e.g. on
 * settings change) without dropping its other routes.
 */
export function removeOpener(owner: string, route: OpenerRoute): void {
  for (let i = registry.length - 1; i >= 0; i--) {
    if (registry[i].owner === owner && registry[i].route === route) registry.splice(i, 1);
  }
}

/** Drop every opener registered by `owner` (module unload / disable). */
export function removeOpeners(owner: string): void {
  for (let i = registry.length - 1; i >= 0; i--) {
    if (registry[i].owner === owner) registry.splice(i, 1);
  }
}

/** Try every opener on `route` in registration order; false when all decline. */
export async function runOpeners(
  route: OpenerRoute,
  ctx: OpenerCtx,
  mount: ExternalMount,
  node: MountNode,
  opts?: ExternalOpenOpts,
): Promise<boolean> {
  for (const opener of registry.filter((o) => o.route === route)) {
    try {
      if (await opener.open(ctx, mount, node, opts)) return true;
    } catch (e) {
      // One broken opener must not strand the file: log and fall through.
      console.error(`[virtual-tree] opener ${opener.owner}/${route} failed:`, e);
    }
  }
  return false;
}
