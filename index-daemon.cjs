// 2026-11-06 更名兼容垫片:index-daemon.cjs → MyKernel.cjs。
// 旧客户端(页面未重载)的 scriptPath 仍指向本文件——转发到新内核,
// 全部客户端自然换血后本垫片可删除。
require(__dirname + "/MyKernel.cjs");
