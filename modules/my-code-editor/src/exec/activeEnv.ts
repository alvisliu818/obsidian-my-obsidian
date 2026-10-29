/**
 * 当前选中的 Python 环境(单例)。
 *
 * 为什么是模块级状态而不是每次从 settings 传:
 * `exec/codeBlockRun.ts` 是被 renderTree 直接调用的模块函数,拿不到 plugin
 * 实例;jupyter 插件那边也是同一个套路(`pythonInterpreter.ts` 的
 * interpreterOverride)。设置在 main.ts 里加载一次,运行路径直接读。
 */
import type { PythonEnv } from './pythonEnvs';

let active: PythonEnv | null = null;

export function setActivePythonEnv(env: PythonEnv | null): void {
  active = env;
}

export function getActivePythonEnv(): PythonEnv | null {
  return active;
}
