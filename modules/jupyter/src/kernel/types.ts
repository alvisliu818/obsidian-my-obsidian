/**
 * 内核抽象层的类型定义 — 移植自 siyuan-editor `src/utils/kernel/types.ts`。
 *
 * KernelClient 的成员是照 LegacyPythonKernel 的公开 API 逐个抄下来的,
 * 不虚构、不精简;这样「syfe 内置内核」与将来的「Jupyter 内核」在此接口下
 * 可互换,调用点只依赖 KernelClient。
 */

export type KernelStatus = 'stopped' | 'starting' | 'ready' | 'error';

/** 内核事件(与 syfe-kernel.py 发出的 JSON 一一对应) */
export type KernelEvent =
  | { type: 'kernel_ready'; version: string; executable: string; pid: number }
  // stream 必须带 id:宿主按 pending[id] 分发事件,没有 id 的事件会被丢掉。
  | { type: 'stream'; id: string; name: 'stdout' | 'stderr'; text: string }
  | { type: 'status'; id: string; state: 'busy' | 'idle'; execution_count: number }
  | {
      type: 'execute_result';
      id: string;
      execution_count: number;
      data: Record<string, string>;
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'error';
      id: string;
      // 协议层错误(未知请求类型、内核自身崩了)没有序号概念,所以可选。
      execution_count?: number;
      ename: string;
      evalue: string;
      traceback: string[];
    }
  | { type: 'complete_result'; id: string; matches: string[]; cursor_start: number; cursor_end: number }
  | {
      type: 'inspect_result';
      id: string;
      kind: 'hover' | 'signature' | 'definition';
      content: string;
      signature?: string;
      name?: string;
      start?: number;
      end?: number;
    }
  | { type: 'reset_result'; id: string }
  | { type: 'info_result'; id: string; version: string; executable: string };

/** 一个执行请求的最终结果 */
export interface ExecuteOutcome {
  ok: boolean;
  /** 该次执行的序号(Jupyter 的 In[n]) */
  executionCount: number;
  stdout: string;
  stderr: string;
  /** 最后一个表达式的值(text/plain) */
  result?: string;
  /** 富文本 / 图片结果(键是 mime type) */
  richData?: Record<string, string>;
  error?: { ename: string; evalue: string; traceback: string[] };
}

export interface CompleteOutcome {
  matches: string[];
  cursorStart: number;
  cursorEnd: number;
}

export interface InspectOutcome {
  content: string;
  signature?: string;
  name?: string;
  start?: number;
  end?: number;
}

export type KernelListener = (ev: KernelEvent) => void;
export type StatusListener = (status: KernelStatus, detail?: string) => void;

/** 内核运行信息 */
export interface KernelInfo {
  version: string;
  executable: string;
}

/** 一次成功执行过的代码,中断重启后用于重放历史 */
export interface HistoryEntry {
  code: string;
  executionOrder: number;
}

/** 内核后端的种类(syfe = 内置内核;jupyter = 预留) */
export type KernelKind = 'jupyter' | 'syfe';

/** 内核后端必须实现的接口。 */
export interface KernelClient {
  readonly kind: KernelKind;

  start(): Promise<boolean>;
  /** 内核工作目录(笔记本所在目录;Jupyter 标准语义,重启后仍生效) */
  setCwd(cwd: string): void;
  execute(code: string, opts?: { silent?: boolean; timeoutMs?: number }): Promise<ExecuteOutcome | null>;
  complete(code: string, cursor: number): Promise<CompleteOutcome | null>;
  inspect(
    code: string,
    cursor: number,
    kind?: 'hover' | 'signature' | 'definition',
  ): Promise<InspectOutcome | null>;
  reset(): Promise<boolean>;
  info2(): Promise<KernelInfo | null>;
  interrupt(): Promise<void>;
  shutdown(): Promise<void>;

  onEvent(cb: KernelListener): () => void;
  onStatus(cb: StatusListener): () => void;

  readonly kernelInfo: KernelInfo | null;
  readonly currentStatus: KernelStatus;
  readonly isReady: boolean;
  readonly executedHistory: ReadonlyArray<HistoryEntry>;
}
