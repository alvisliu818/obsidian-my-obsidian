/**
 * 内核注册表 — 移植自 siyuan-editor `src/utils/kernel/registry.ts`。
 *
 * 职责:docId → KernelClient 的映射,以及「每个文档用哪个内核」的选择与持久化。
 * 现在只有 Legacy 后端,但注册表先立起来:将来加 Jupyter 后端时调用点完全不用动。
 *
 * 单实例起步:所有入口不传 docId 时走同一个默认 key,语义与原全局单例一致。
 */

import { type KernelClient, type KernelKind } from './types';
import { LegacyPythonKernel } from './legacyPython';

/** 没传 docId 时的默认 key。叫 global 而不是 ''——空串太容易被误当「未设置」。 */
export const DEFAULT_KERNEL_ID = '__default__';

/** 一个文档的内核选择:后端种类 + Jupyter 时的 kernelspec(预留) */
export interface KernelChoice {
  kind: KernelKind;
  specName?: string;
  specResourceDir?: string;
}

/** docId → 内核实例 */
const instances = new Map<string, KernelClient>();
/** docId → 用户选择的内核。没有记录 = 用默认后端 */
const choices = new Map<string, KernelChoice>();

// ===== 选择持久化(宿主注入) =====

export interface KernelChoicePersistence {
  load(): Promise<Record<string, KernelChoice> | null>;
  save(data: Record<string, KernelChoice>): Promise<void>;
}

let persistence: KernelChoicePersistence | null = null;
let choicesLoaded = false;

/** 宿主(插件)在 onload 时注册存取实现;注册前的选择只在内存里 */
export function registerKernelChoicePersistence(h: KernelChoicePersistence): void {
  persistence = h;
}

/** 从宿主存储加载所有文档的内核选择(幂等) */
export async function loadKernelChoices(): Promise<void> {
  if (choicesLoaded || !persistence) return;
  choicesLoaded = true;
  try {
    const data = await persistence.load();
    if (data) {
      for (const [k, v] of Object.entries(data)) {
        if (v && (v.kind === 'jupyter' || v.kind === 'syfe')) choices.set(k, v);
      }
    }
  } catch {
    // 存储坏了不致命:退回默认选择
  }
}

/** 把当前所有选择写回宿主存储 */
export async function saveKernelChoices(): Promise<void> {
  if (!persistence) return;
  try {
    const obj: Record<string, KernelChoice> = {};
    for (const [k, v] of choices) obj[k] = v;
    await persistence.save(obj);
  } catch {
    // 保存失败不致命:下次启动回到默认
  }
}

// ===== 实例创建 =====

function createInstance(_choice?: KernelChoice): KernelClient {
  // 当前唯一后端;Jupyter 落地后按 choice.kind 分派。
  return new LegacyPythonKernel();
}

/** 取该文档的内核,不存在则按需创建。 */
export function getKernel(docId: string = DEFAULT_KERNEL_ID): KernelClient {
  const existing = instances.get(docId);
  if (existing) return existing;
  const created = createInstance(choices.get(docId));
  instances.set(docId, created);
  return created;
}

/** 该文档当前选择的内核 */
export function getKernelChoice(docId: string = DEFAULT_KERNEL_ID): KernelChoice | null {
  return choices.get(docId) ?? null;
}

/**
 * 切换内核种类/spec。**会销毁现有实例**,下次 getKernel 按新选择重建 ——
 * 内核有状态,不重启就换后端会让「内存里的变量」凭空消失而用户不知情。
 */
export function setKernelChoice(docId: string, choice: KernelChoice): void {
  choices.set(docId, choice);
  const existing = instances.get(docId);
  if (existing) {
    instances.delete(docId);
    void existing.shutdown().catch(() => {
      // 关不掉就算了:进程可能已经死了
    });
  }
  void saveKernelChoices();
}

/** 关闭并移除某个文档的内核(重启等价于 dispose 后再 getKernel) */
export async function disposeKernel(docId: string): Promise<void> {
  const existing = instances.get(docId);
  if (!existing) return;
  instances.delete(docId);
  try {
    await existing.shutdown();
  } catch {
    // ignore
  }
}

/** 插件卸载时收尾:关掉所有还在跑的内核 */
export async function disposeAllKernels(): Promise<void> {
  const all = Array.from(instances.entries());
  instances.clear();
  for (const [, kernel] of all) {
    try {
      await kernel.shutdown();
    } catch {
      // ignore
    }
  }
}
