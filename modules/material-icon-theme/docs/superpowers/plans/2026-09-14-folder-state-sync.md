# 文件夹展开状态同步修复实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复隐藏文件夹状态改变后重新显示时沿用旧图标的问题，同时避免状态未变时重复绘制。

**Architecture:** 保留现有局部观察与行回收流程。文件夹行每次处理时重新核对所需图标，在图标容器记录已绘制的图标键，仅键改变时替换 SVG（矢量图）；主题切换继续使用既有清空并重绘流程。

**Tech Stack:** TypeScript、Obsidian、MutationObserver（页面变更观察器）、Node.js 内置测试、happy-dom、esbuild。

**Spec:** 用户在本任务确认的范围：修复问题 #2、验证性能、执行指定 `/review`、修正发现后发布。不另建重复设计文档。

## Global Constraints

> 以本地小插件的实际使用场景限制实现范围。

- 进程数：每个 Obsidian 窗口一个渲染进程，保留既有多窗口支持，不增加跨进程协调。
- 用户数：每个笔记库单操作员，不增加并发写入机制。
- 调用频率：文件夹展开、收起及滚动时触发局部处理，不增加轮询或全树扫描。
- 失败代价：文件夹图标与实际状态不符，误导导航；不得改动用户笔记。
- 上游保持 `material-icon-theme@5.38.1`，最低 Obsidian 版本保持 `1.13.0`，发布补丁版 `1.3.3`。
- 保留监听器清理、图标容器复用、主题刷新、文件与文件夹行复用机制。
- 状态和图标键未变时保留原 SVG 节点；图标键改变时只重绘对应文件夹。
- 不新增依赖、配置项、永久性能脚本或抽象层，不拆分 `src/main.ts`。
- 沿用用户已明确的当前仓库独立分支方式，不创建额外工作区，不创建 PR（合并请求）。
- 开发分支 `codex/fix-folder-state-sync`，审查和验证通过后合并 `main`、推送并发布。

---

## 修复依据

> 2026-09-14 在 Obsidian 1.13.7 与插件 1.3.2 中连续三次复现。

- 展开父文件夹及子文件夹，收起父文件夹，点击“全部收起”，再展开父文件夹。
- 子文件夹模型及箭头已收起，但图标仍为展开状态。
- `pruneFolderObservers()` 清理隐藏行的观察器，保留其图标。
- `processItem()` 因 `data-mfi-applied` 标记跳过已有图标，只重新注册观察器。
- 受益者是使用文件树的插件用户，触发操作属于日常导航；修复只增加图标键比较与针对性重绘。

---

## 实施

> 源码与回归测试组成一个可独立验证的修复单元。

### Task 1: 同步重新显示的文件夹图标

**Files:**

- Modify: `src/main.ts` 中 `processItem`、`injectFolderIcon`、`placeIcon`、`updateFolderIcon`。
- Test: `tests/file-tree.test.mjs`，复用已有构建与页面模拟设施。
- Commit together: 本方案、以上两个文件。版本字段由控制者在宿主验收后处理。

**Interfaces:**

- Consumes: `processItem(itemEl)`、`observeContainer(container)`、`getFolderIconKey(path, collapsed)` 与既有测试辅助函数。
- Produces: 既有调用入口不变，`placeIcon` 返回创建或复用的图标容器，供文件夹路径记录 `data-mfi-icon-key`。
- 图标键只存放于图标容器，不新增长期映射表；图标被移除时记录一起消失。

- [x] **Step 1: 先添加失败用例。** 在现有测试文件新增普通文件夹的展开和收起两个方向，用真实观察器处理离开与重新加入页面，断言最终图标。核心测试内容如下：

```js
for (const [initialCollapsed, before, after] of [
  [false, 'folder-open', 'folder'],
  [true, 'folder', 'folder-open'],
]) {
  test(`reattached folder reconciles ${before} to ${after}`, async t => {
    const plugin = createPlugin();
    const container = document.createElement('div');
    const { item, title } = createFolderRow('plain');
    item.classList.toggle('is-collapsed', initialCollapsed);
    document.body.appendChild(container);
    const observer = plugin.observeContainer(container);
    t.after(() => {
      observer.disconnect();
      plugin.folderObservers.forEach(obs => obs.disconnect());
    });
    container.appendChild(item);
    await flushMutations();
    const host = title.querySelector('.mfi-icon');
    assert.equal(title.querySelector('svg').dataset.icon, before);
    item.remove();
    await flushMutations();
    assert.equal(plugin.folderObservers.has(item), false);
    item.classList.toggle('is-collapsed', !initialCollapsed);
    await flushMutations();
    container.appendChild(item);
    await flushMutations();
    assert.equal(title.querySelector('svg').dataset.icon, after);
    assert.equal(title.querySelector('.mfi-icon'), host);
    item.classList.toggle('is-collapsed', initialCollapsed);
    await flushMutations();
    assert.equal(title.querySelector('svg').dataset.icon, before);
  });
}
```

- [x] **Step 2: 运行失败用例。** `node --test --test-name-pattern='reattached folder' tests/file-tree.test.mjs`；预期只因最终图标仍是旧值而失败，不接受测试设施错误。
- [x] **Step 3: 最小实现。** `processItem` 中将图标处理条件改为 `isFolder || !titleEl.hasAttribute(APPLIED_ATTR)`；`injectFolderIcon` 对已有图标调用 `updateFolderIcon` 后返回；保留禁用设置和强制刷新行为。图标键记录与短路代码如下：

```ts
// injectFolderIcon：原 placeIcon 调用保留参数，接收返回的图标容器。
const icon = this.placeIcon(
  titleEl,
  contentEl,
  this.getSvg(this.getIconSet(key)),
  `${ICON_CLASS} ${FOLDER_ICON_CLASS}`
);
icon.dataset.mfiIconKey = key;
titleEl.setAttribute(APPLIED_ATTR, '1');

// placeIcon：在既有 renderIconInto 调用之后返回 icon。
return icon;

// updateFolderIcon：找到 span 后，按键决定是否重新渲染。
const key = this.getFolderIconKey(titleEl.dataset.path ?? '', collapsed);
if (span.dataset.mfiIconKey === key) return;
renderIconInto(span, this.getSvg(this.getIconSet(key)), 16);
span.dataset.mfiIconKey = key;
```

- [x] **Step 4: 补充同一契约的保护。** 状态未变的重新显示与连续 `processItem` 保留同一个 SVG；通过现有测试图标格式为 `assets` 添加专用闭合、展开图标映射，并覆盖重新显示；核对既有主题切换、行复用和禁用测试仍通过。测试期望使用明确图标名，不用生产匹配函数计算期望。
- [x] **Step 5: 验证并自审。** 运行 `npm test`、`npm run lint`、`npm run build` 和 `git diff --check`，只接受本任务改动。报告先失败后成功的命令、输出和测试数。
- [x] **Step 6: 提交修复单元。** 提交本方案、源码与测试，标题 `fix: 同步重新显示的文件夹图标`，正文解释重新显示时校正图标且未变时不重绘，末尾 `Refs: #2`；推送任务分支。由控制者派发任务审查，不由实施者再派代理。

---

## 宿主验收与发布

> 控制者完成实际运行验收、指定审查及发布验证，不把这些外部状态视为仅凭代码即可完成。

- [x] 在独立临时笔记库中使用 Obsidian 1.13.7，对修复前后运行相同脚本，不操作用户日常笔记库或其他任务的窗口。
- [x] 复现步骤连续三次正确；补验证隐藏状态批量展开、专用文件夹图标、主题切换、插件启停。
- [x] 对相同长列表比较批量展开、收起和滚动的脚本执行耗时与绘制次数，记录中位数及波动；状态未变时新增 SVG 替换次数必须为零，不用固定等待时间冒充耗时。
- [x] 不增加永久基准脚本，运行记录保存到临时目录或忽略的任务记录目录。
- [x] 任务审查确认规格符合、代码质量通过；主控制者执行用户指定的 `/review` 完整流程，并完成全分支独立审查；有真实问题则修复、复测、复审。
- [x] 将 `package.json`、`manifest.json`、锁文件两处根版本统一为 `1.3.3`，依赖条目不变；对最终版本运行测试、检查、构建。
- [ ] 合并前同步远端 `main`，确认验证提交未漂移；直接合并并推送，核对本地、跟踪引用和远端主分支提交一致。
- [ ] 创建与推送 `1.3.3` 标签，跟进既有 Release 工作流，不重复手动触发；验证测试、构建、来源检查和上传完成。
- [ ] 下载实际发布的三个附件，与验证构建逐字节比较；核对附件版本、标签提交和三份构建来源签名。
- [ ] 发布成功后回复并关闭问题 #2，将 My Tasks（个人任务看板）标记完成；核验回读结果。

---

## 交接选项

> 本次按用户指令直接实施，不等待再次选择。

- 可另行整理一份提示词交给其他 Agent（代理）执行，以本方案为唯一实施依据，包含仓库、分支、包含方案的提交及 `AGENTS.md` 要求。
- 交接时沿用本仓库不创建 PR 的规则，完成审查、修复、复测、合并推送与发布后报告结果。
