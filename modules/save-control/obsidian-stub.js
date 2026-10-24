// 编译期桩：单测只需要这些名字可解析（targets.ts 的 instanceof TFile 不会在
// 单测路径上真正执行）。
export class TFile {}
export class TFolder {}
export class Plugin {}
export class Notice {}
