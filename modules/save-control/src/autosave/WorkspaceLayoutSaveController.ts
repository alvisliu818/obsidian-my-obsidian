import { App } from "obsidian";
import { dlog } from "../debug";

type AdapterWriteFn = (normalizedPath: string, data: string, options?: unknown) => Promise<void>;
type WrappedWriteMetadata<T> = { __ascOriginal?: T };

type PendingWorkspaceWrite = {
  normalizedPath: string;
  data: string;
  options?: unknown;
};

function callAdapterWrite(
  fn: AdapterWriteFn,
  thisArg: unknown,
  normalizedPath: string,
  data: string,
  options?: unknown,
): Promise<void> {
  return (fn.bind(thisArg) as (normalizedPath: string, data: string, options?: unknown) => Promise<void>)(
    normalizedPath,
    data,
    options,
  );
}

export class WorkspaceLayoutSaveController {
  private originalAdapterWrite: AdapterWriteFn | null = null;
  private installedAdapterWriteWrapper: AdapterWriteFn | null = null;
  private flushTimeoutId: number | null = null;
  private pendingWrite: PendingWorkspaceWrite | null = null;
  private allowImmediateWrite = false;

  constructor(
    private readonly app: App,
    private readonly isEnabled: () => boolean,
    private readonly getDelaySeconds: () => number,
    /**
     * 「直到关闭 Obsidian 才写盘」。开启后不设定时器，布局改动一直缓冲在
     * 内存，由 quit 钩子（AutoSaveController 的 workspace 'quit' 监听，
     * 那里已无条件 flush）在退出前落盘。
     */
    private readonly isUntilQuit: () => boolean,
  ) {}

  /**
   * 是否延迟写盘：两个开关任一开启即可——
   * deferWorkspaceLayoutSaves = 延迟 N 秒；deferWorkspaceLayoutUntilQuit =
   * 更强形式（一直缓冲到退出）。让后者自洽，不必先开前者。
   */
  private shouldDefer(): boolean {
    return this.isEnabled() || this.isUntilQuit();
  }

  enable() {
    const adapterWithWrite = this.app.vault.adapter as typeof this.app.vault.adapter & { write?: AdapterWriteFn };
    if (typeof adapterWithWrite.write !== "function") {
      return;
    }

    this.originalAdapterWrite = this.unwrapWrappedFunction(adapterWithWrite.write);
    this.installedAdapterWriteWrapper = this.createAdapterWriteWrapper(this.originalAdapterWrite);
    adapterWithWrite.write = this.installedAdapterWriteWrapper;
  }

  disable() {
    // 卸载 / 关闭功能前先把缓冲的布局改动落盘：until-quit 模式下它是唯一的
    // 写盘机会，而 cancel() 会直接丢弃 pendingWrite。退出路径上 quit 钩子
    // 已经 flush 过，这里变成 no-op（pendingWrite 已空）。
    void this.flush();

    const adapterWithWrite = this.app.vault.adapter as typeof this.app.vault.adapter & { write?: AdapterWriteFn };
    if (this.originalAdapterWrite && adapterWithWrite.write === this.installedAdapterWriteWrapper) {
      adapterWithWrite.write = this.originalAdapterWrite;
    }

    this.originalAdapterWrite = null;
    this.installedAdapterWriteWrapper = null;
    this.cancel();
  }

  refreshScheduling() {
    if (!this.pendingWrite) {
      return;
    }

    if (!this.shouldDefer()) {
      void this.flush();
      return;
    }

    this.schedule();
  }

  hasPending(): boolean {
    return this.pendingWrite !== null;
  }

  schedule() {
    if (!this.pendingWrite) {
      return;
    }

    // 不论哪种模式，先清掉可能残留的旧定时器：从「延迟 N 秒」切到
    // 「直到退出」时，旧的到期写盘必须撤销，否则会提前落盘。
    if (this.flushTimeoutId !== null) {
      window.clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }

    if (!this.shouldDefer()) {
      void this.flush();
      return;
    }

    // 「直到关闭才写」：不排任何定时器，一直缓冲在内存，
    // 等 quit 钩子（AutoSaveController 里已无条件 flush）在退出前落盘。
    if (this.isUntilQuit()) {
      dlog("Deferred workspace layout write until app quit", this.pendingWrite.normalizedPath);
      return;
    }

    this.flushTimeoutId = window.setTimeout(() => {
      void this.flush();
    }, this.getDelaySeconds() * 1000);
  }

  cancel() {
    if (this.flushTimeoutId !== null) {
      window.clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }

    this.pendingWrite = null;
  }

  async flush() {
    if (!this.pendingWrite || !this.originalAdapterWrite) {
      return;
    }

    const pendingWrite = this.pendingWrite;
    this.pendingWrite = null;

    if (this.flushTimeoutId !== null) {
      window.clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }

    this.allowImmediateWrite = true;
    try {
      await callAdapterWrite(
        this.originalAdapterWrite,
        this.app.vault.adapter,
        pendingWrite.normalizedPath,
        pendingWrite.data,
        pendingWrite.options,
      );
      dlog("Workspace layout flushed", pendingWrite.normalizedPath);
    } finally {
      this.allowImmediateWrite = false;
    }
  }

  private createAdapterWriteWrapper(originalAdapterWrite: AdapterWriteFn): AdapterWriteFn {
    // until-quit 开关自洽：单独打开它也要能缓冲（判定见 shouldDefer）。
    const shouldDefer = () => this.shouldDefer();
    const isWorkspaceLayoutPath = (normalizedPath: string) => this.isWorkspaceLayoutPath(normalizedPath);
    const schedule = () => this.schedule();
    const allowImmediateWrite = () => this.allowImmediateWrite;
    const setPendingWrite = (pendingWrite: PendingWorkspaceWrite) => {
      this.pendingWrite = pendingWrite;
    };

    const wrappedAdapterWrite = async function wrappedAdapterWrite(
      this: unknown,
      normalizedPath: string,
      data: string,
      options?: unknown,
    ) {
      if (
        allowImmediateWrite() ||
        !shouldDefer() ||
        !isWorkspaceLayoutPath(normalizedPath)
      ) {
        await callAdapterWrite(originalAdapterWrite, this, normalizedPath, data, options);
        return;
      }

      setPendingWrite({ normalizedPath, data, options });
      schedule();
      dlog("Deferred workspace layout write", normalizedPath);
    };

    return this.markWrappedFunction(wrappedAdapterWrite, originalAdapterWrite);
  }

  private isWorkspaceLayoutPath(normalizedPath: string): boolean {
    const normalizedConfigDirPath = `${this.app.vault.configDir}/`;
    const candidatePath = normalizedPath.replace(/\\/gu, "/");
    return candidatePath === "workspace.json"
      || candidatePath === "workspace-mobile.json"
      || candidatePath === `${normalizedConfigDirPath}workspace.json`
      || candidatePath === `${normalizedConfigDirPath}workspace-mobile.json`
      || candidatePath.endsWith("/workspace.json")
      || candidatePath.endsWith("/workspace-mobile.json");
  }

  private markWrappedFunction<T>(wrapper: T, original: T): T {
    const wrappedFunction = wrapper as T & WrappedWriteMetadata<T>;
    wrappedFunction.__ascOriginal = original;
    return wrapper;
  }

  private unwrapWrappedFunction<T>(fn: T): T {
    return (fn as T & WrappedWriteMetadata<T>).__ascOriginal ?? fn;
  }
}
