# save-control —— 组成与许可

本模块由两个上游 MIT 插件合并而成，合并后的仓库整体以 **GPL-3.0** 发布：

| 组件 | 上游版本 | 许可 | 作者 |
| --- | --- | --- | --- |
| save-history | 1.3.5（commit 809bcd7） | MIT | Sevoni（manifest 作者署名 Gugl） |
| obsidian-autosave-control | 1.0.19（commit dd53f7a） | MIT | mihasm |

- `src/`：以 save-history 为基座（存储/版本/差异/界面/locale），合并
  autosave-control 的 `autosave/*`（延迟落盘控制器、待保存队列、编辑活动
  跟踪、工作区布局延迟）与状态栏指示器。
- 合并新增：库外文件支持（`targets.ts` / `externalStore.ts` /
  `externalScheduler.ts`）、标签页未保存圆点（`tabUnsavedDot.ts`）、
  关闭标签页提示（`closePrompt.ts`）、设置项合并与开关（`settings.ts`）。
- 上游原始提交历史以 subtree 保留：save-history 在 `modules/save-control`
  前缀下（查历史用 `git log --full-history --follow`）；autosave-control
  的目录在合并完成后已移除（工作树不再保留独立副本），其快照仍可经
  `git show a8799b7` 查看全部 52 个文件，`git log --full-history --
  modules/autosave-control` 仍能定位引入点。
