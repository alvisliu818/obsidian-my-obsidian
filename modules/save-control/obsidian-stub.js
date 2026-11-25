// 编译期桩：单测只需要这些名字可解析（targets.ts 的 instanceof TFile 不会在
// 单测路径上真正执行）。
export class TFile {}
export class TFolder {}
export class Plugin {}
export class Notice {}
// versionFs.ts 用 Platform.isMobileApp 判定存储后端；单测一律按桌面（Node fs
// 测试替身）处理。
export const Platform = { isMobileApp: false, isMobile: false, isDesktop: true, isMacOS: false };

