// 编译期桩：单测只需要这些名字可解析（local-scanner 的 instanceof TFolder
// 不会在单测路径上真正执行）。
export class TFile {}
export class TFolder {}
export class Plugin {}
export class Notice {}
