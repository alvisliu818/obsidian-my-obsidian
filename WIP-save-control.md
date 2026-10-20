# save-control 合并模块 — 未完成任务清单（WIP）

> **✅ 本清单已全部完成（2026-10-13），留档备查。**
> 完成情况：§2.1 探针 12/12 ALL PASS（根因是探针判定源，非产品问题，详见
> 提交 73f2cf4 的说明）；§2.2 已提交 `73f2cf4` 并推送；§2.3 主库已部署
> （md5 一致，重启 Obsidian 生效）；§2.4 记忆文件已更新（2026-10-13.md /
> MEMORY.md）。

> 生成日期：2026-10-13
> 范围：仅记录 save-control 模块的剩余工作，不涉及其它功能。
> 本文档按「整理未完成任务」生成，不包含任何代码改动 / 构建 / 提交 / 部署动作。

---

## 0. 当前状态一句话

代码合并**已完成**、能**构建**（main.js）、能通过 **991 个 logseq 单测 + 7 个 externalStore 单测**、能**随宿主启动**（`loadedModuleIds` 含 `save-control`）。但仍有 4 件收尾没做：

1. ~~e2e 探针最后一项断言（`保存并关闭：标签页已关`）未稳定通过~~ → **已解决：探针判定源错误（登记表滞后），关闭前抓 DOM 引用后 12/12 ALL PASS**；
2. ~~整个 save-control 模块**尚未 git 提交**~~ → **已提交 `73f2cf4` 并推送**；
3. ~~尚未**部署到主库**（`E:\HOME\BaiduSyncdisk`）~~ → **已部署，md5 一致**；
4. ~~记忆文件（`2026-10-13.md` / `MEMORY.md`）**未更新**~~ → **已更新**。

---

## 1. 已完成的代码合并（作为验收基线）

按 `git status --short` 实际改动，本次新增/修改涉及：

**宿主接线（已修改）**
- `src/main.ts`：新增 `SaveControlPlugin` 的 descriptor（`id:"save-control"`、`legacyId:"save-history"`、`desktopOnly:true`）。
- `styles.css`：追加 save-control 样式（save-history 约 933 行 + autosave-control 约 40 行 + `.sc-unsaved-dot` / `.sc-unsaved-close__row`）。
- `modules/logseq/src/view/BlockEditorView.ts`、`ExternalBlockView.ts`、`ExternalCodeView.ts`、`ExternalFileView.ts`：三视图接入 `isDirty()` / `configureAutoSave()`（暴露 `ExternalSaveHandle`）。

**save-control 模块内（已修改）**
- `manifest.json`、`autosave.ts`、`diff.ts`、`main.ts`、`settings.ts`、`storage.ts`、`ui.ts`、`versioning.ts`

**save-control 模块内（新增）**
- `NOTICE.md`（署名 + 许可表 + subtree 历史说明）
- `src/autosave-ui/`、`src/autosave/`（AutoSaveController、PendingSaveQueue、EditActivityTracker、WorkspaceLayoutSaveController）
- `closePrompt.ts`、`debug.ts`、`externalScheduler.ts`、`externalStore.ts`
- `fileKind.ts`、`settingsTab.ts`、`styles-asc.css`、`tabUnsavedDot.ts`、`targets.ts`、`tests/`

**设计要点（排障/接手用）**
- **SaveTarget 抽象**：库外目标铸造「合成 TFile」，`path` = 快照目录绝对路径，storage 据此路由 fs 存储（`isExternalSnapshotPath` 匹配 `^[A-Za-z]:[\\/]` 或 `/`）。
- **外部快照库**：`plugins/<id>/save-control-snapshots`（或配置 `externalSnapshotFolder`），键 `ext_<escaped-abs>_<hash>`。
- **调度器**：`ExternalSaveScheduler` 接管各库外视图的内建自动保存（`configureAutoSave`），避免与模块调度器竞速。
- **未保存圆点**：`UnsavedDotMonitor` 每 500ms 轮询注入 `.sc-unsaved-dot`（已核实 Obsidian 1.14.4 无原生 modified 圆点）。
- **关闭提示**：`WorkspaceLeaf.prototype.detach` 被 `createDetachWrapper` 包装，拦截关脏标签页弹三选项（取消 / 保存并关闭 / 不保存并关闭）。
- **已知交互**：合并版 AutoSaveController patch `MarkdownView.save` 等，与 logseq 的 `setViewState` 补丁叠加 —— 已 e2e 验证。

---

## 2. 待办任务清单（按推荐执行顺序）

### 2.1 收尾 e2e 探针（唯一阻塞点）

**现状**：探针 `tests/e2e/_save-control-verify.mjs` 当前 **11/12 通过**。唯一失败项：

```
FAIL  保存并关闭：标签页已关  {"usedModal":true,"domGoneAt":-1}
```

**探针当前逻辑（文件第 200–236 行）**
1. 点关闭按钮 → 弹窗出现；
2. 6 轮 ×250ms 在弹窗里找「保存并关闭」按钮并点击（`usedModal` 即此时置 `true`）；
3. 关闭判定改用 **DOM 真值**：`!leaf || !leaf.containerEl.isConnected || !leaf.tabHeaderEl?.isConnected`；
4. 12 轮 ×2.5s 轮询（共约 30s 上限），`domGoneAt` = 首次观测到断开的耗时，否则 `-1`；
5. 断言：`domGoneAt >= 0 && domGoneAt < 25000`。

**根因分析（两种可能，需实测区分）**
- **A. 模态遮挡导致 detach 被延迟执行**：Obsidian 在模态框打开期间会 **defer 工作区结构变更**，`detach` 调用了但标签页真正从 DOM 断开要等模态关闭。若 `createDetachWrapper` 的 save 分支在 `flushLeaf` 后**没有先关闭模态框**再 detach，则 `containerEl` 在模态关闭前始终 `isConnected`，轮询 30s 内都抓不到断开 → `domGoneAt` 恒为 `-1`。这是**功能层面需要修的真问题**。
- **B. 断言窗口/上限不匹配**：即便正常关闭，Obsidian 的延迟是十几秒量级，加上 400ms 等待 + 重试，若标签页在 ~27s 才断开，`domGoneAt≈27000` 会卡在 `<25000` 上限外（假阴性）。这是**测试判定**问题。

**推荐修复方向（先 A 后 B，或组合）**
1. 复查 `modules/save-control/src/autosave/AutoSaveController.ts` 的 `createDetachWrapper`：
   - 确认 `choice==='save'` 路径在 `flushLeaf` 之后、调用 `originalDetach` **之前**模态框已 `close()`；
   - 确认 20×250ms 重试 loop 真的执行了 `callWithArgs(originalDetach, self)`（用 `window.__detachLog` 插桩确认调用次数/时机）。
2. 若确认功能正常，修正断言：
   - 放宽上限（如 `< 45000`）或改为「只要 `domGoneAt >= 0` 即算通过」（不再卡 25s 上限，因为 Obsidian 的延迟是十几秒量级）；
   - 把 12 轮 ×2.5s 的窗口适当拉长（如 20 轮 ×2.5s = 50s）。

**判定标准**：重跑 `node tests/e2e/_save-control-verify.mjs`（需先 build + 部署到 e2e vault），`保存并关闭` 两项（落盘 + 标签页已关）通过、输出 `ALL PASS`。

> 说明：用户交互层面「保存并关闭」确实会关掉标签页，该失败更可能是**模态延迟 + 断言窗口**叠加的测试假象，但必须实跑确认，不能凭推断结案。

---

### 2.2 提交到 git

**待提交文件（来自 `git status --short`，确认无遗漏）**

修改（宿主 + logseq 集成）：
- `src/main.ts`、`styles.css`
- `modules/logseq/src/view/BlockEditorView.ts`
- `modules/logseq/src/views/ExternalBlockView.ts`
- `modules/logseq/src/views/ExternalCodeView.ts`
- `modules/logseq/src/views/ExternalFileView.ts`

修改（save-control 内）：
- `modules/save-control/manifest.json`、`autosave.ts`、`diff.ts`、`main.ts`、`settings.ts`、`storage.ts`、`ui.ts`、`versioning.ts`

新增（save-control 内，含 `??` 未跟踪）：
- `modules/save-control/NOTICE.md`
- `modules/save-control/src/autosave-ui/`、`modules/save-control/src/autosave/`
- `modules/save-control/src/closePrompt.ts`、`debug.ts`、`externalScheduler.ts`、`externalStore.ts`、`fileKind.ts`、`settingsTab.ts`、`styles-asc.css`、`tabUnsavedDot.ts`、`targets.ts`、`tests/`

**不需提交的项（已核实）**
- `modules/autosave-control/`：已是 subtree 源、**已跟踪且未改动**（52 文件），不要重复 `add`；它作为 save-control 的上游源保留。
- 无 `modules/save-history` 目录（其历史已 subtree 进 `save-control`）。

**提交方式**
- 按一次「save-control 模块合并」提交即可（接线 + 样式 + 宿主 descriptor + 三视图集成可并入同一提交；subtree 历史已含在 save-control 内）。
- commit message 遵循仓库既有 Conventional Commits + 中文正文，并标注 workbuddy：

```
feat: 合并 save-control 模块（save-history + autosave-control）

将 save-history(MIT) 与 obsidian-autosave-control(MIT) 合并为单一
save-control 模块，支持库外文件的自动保存、版本快照、未保存圆点与
关闭提示。整体仓库许可为 GPL-3.0（已含两 GPL 模块，强 copyleft 要求）。

workbuddy

Co-Authored-By: workbuddy <noreply@workbuddy.ai>
```

**提交前验证**（不要提交构建不过的状态）
- `npm run build`（或 `build:fast`）→ 0 错误；
- `tsc --noEmit` → 0 错误；
- 单测：logseq vitest（约 962）+ `modules/save-control/tests/externalStore.test.ts`（7/7）。

---

### 2.3 部署到主库

- 目标目录：`E:\HOME\BaiduSyncdisk\.obsidian\plugins\obsidian-my-obsidian`
- 拷贝三件套：`main.js` + `manifest.json` + `styles.css`（**不动 `data.json`**，保留用户设置）。
- **主库启用后需重启 Obsidian** 才生效（此前已部署过一次做 e2e，但未提交）。
- 验证：主库打开一个库外文件，确认 ① 编辑后出现未保存圆点；② 延迟后自动落盘；③ 关脏标签页弹三选项且「保存并关闭」落盘 + 关闭。

---

### 2.4 更新记忆文件

- `E:/HOME/Code/.workbuddy/memory/2026-10-13.md`：
  - 把现有「save-control 合并模块（进行中，未提交）」小节（第 144–160 行）更新为「已完成合并 + 已提交 + 已交付」；
  - 补充 e2e 教训：**模态框打开期间 Obsidian defer 工作区结构变更**，`getLeavesOfType` 滞后十几秒，关闭判定必须用 DOM 真值（`containerEl` / `tabHeaderEl` `.isConnected`）。
- `E:/HOME/Code/.workbuddy/memory/MEMORY.md`：同步 save-control 模块的设计要点与状态（SaveTarget 抽象、外部快照库、三视图集成、关闭提示补丁）。

---

## 3. 可选清理（✅ 已完成：2026-10-13 经确认删除，commit 5a7061e）

- `modules/autosave-control/` 上游源目录已移除；快照仍可经 `git show a8799b7`
  查看，NOTICE.md 的历史说明已同步更新。

---

## 4. 整体交付状态（截至本清单）

**已交付并已提交**
| 功能 | commit |
|---|---|
| 虚拟文档树 Ctrl+C/V 复制粘贴 | `7232749` |
| omnisearch 搜库外文件 | `f79aaa4` |
| 最近使用面板（收录所有文件 + 类型筛选） | `f199123` |
| 库外标签页 ⋮/右键菜单补齐 | `9b4bd88` + `e078d6d` |
| 并入 GPL 两模块（ai-image-analyzer + omnisearch）+ 许可改 GPL-3 | `d5146ed` + `a7f5276` |

**进行中（未提交）**
- save-control 合并模块（本清单 §1–§2 的全部内容）。
