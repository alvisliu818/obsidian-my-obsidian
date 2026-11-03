# 轻量图标插件质量修复 Implementation Plan（实施计划）

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务实施本计划。
> 使用复选框记录执行进度，不跳过失败验证与复测。

**Goal:** 修复主题适配、渐变串色、特殊名称匹配、键盘选图和贡献指南链接五项已复现问题，保持插件的轻量结构。

**Architecture:** 保留单个插件入口、生成式图标数据和既有文件树生命周期管理。主题适配使用宿主接口，图标内部引用在渲染入口隔离，选图交互使用原生按钮。沿用测试与发布链路，不引入依赖或通用框架。

**Tech Stack:** TypeScript（类型化脚本语言）、Obsidian API（宿主接口）、SVG（矢量图）、Node.js 内置测试、happy-dom（文档模型测试环境）、esbuild（打包工具）。

**Spec:** `docs/superpowers/plans/2026-09-07-plugin-quality-fixes.md` 内“审查契约与验收目标”章节是本次实施的完整需求契约，不依赖聊天记录或另一份设计文档。

## Global Constraints

> 修复范围受插件的实际运行场景约束。
> 每个任务均须满足本节要求。

- **仓库**：`GilbertzzzZZ/obsidian-material-icon-theme`。
- **本机路径**：`/home/ubuntu/projects/plugin/obsidian-material-icon-theme`。其他机器使用该仓库的实际检出目录，命令均从仓库根目录执行。
- **审查基线提交**：`b7a3b06ab5904aa2bea8a56109e8d8c6a952c8a5`，基线分支为 `main`。
- **进程模型**：插件在 Obsidian 笔记库的宿主环境内运行，不创建服务或工作进程。必须支持同一笔记库的多个文件树视图和独立窗口，不假定所有元素属于同一个文档对象。
- **用户模型**：每个笔记库按一位本地交互用户设计，不建立跨用户、跨笔记库协调机制。
- **调用频率**：文件树操作随添加、重命名、滚动、展开和布局变化触发。主题刷新随宿主主题变化触发。选择器仅在新增或编辑规则时打开。
- **失败代价**：错误影响图标辨识、选择操作或宿主界面。插件不得修改笔记内容、文件名称或笔记库之外的数据。
- **宿主边界**：保留 `minAppVersion: 1.13.0` 和 `isDesktopOnly: false`。
- **依赖边界**：不新增依赖，不修改 `material-icon-theme: "5.38.1"` 和依赖锁文件。
- **语言与编译边界**：保留 `ES2018` 编译目标与现有十种界面语言，不主动翻译既有英文内容。
- **结构边界**：不拆分 `src/main.ts`，不建立图标服务、注册表、主题状态框架或通用字典模块。
- **保护机制**：保留文件树局部更新、行复用、启动补刷、刷新等待上限、观察器回收和卸载清理。
- **来源边界**：不修改图标生成规则、上游版本绑定或发布来源核验流程，不提交生成的 `main.js`、`src/icon-data.ts`。
- **性能基线**：审查产物 `main.js` 为 `2,099,400` 字节。510 个文件的实测中，滚动位置上的文件行数量为 35–49。以同环境前后对比验收，不引入其他项目的体积上限。
- **测试边界**：保留原有 40 项测试，为已确认缺陷增加行为回归，不新增覆盖率门槛或长期浏览器测试工具链。
- **发布边界**：本计划不手工升级插件版本，不创建发布标签，不合并主分支，不触发正式发布。

---

## 审查契约与验收目标

> 五项修复各自具有确定的触发方式和结果。
> 不将顺手重构或未复现的防御机制纳入实施。

- **主题适配**：深色启动及浅色切回深色后，`vercel.json` 使用深色图标，颜色为 `#cfd8dc`，浅色时为 `#455a64`。宿主重复发送样式变化事件而主题未变时，不重建文件树图标。
- **预览一致性**：主题切换后打开设置、规则弹窗或图标选择器，使用相应主题图标。保留既有短生命周期弹窗模型，不建立跨弹窗状态同步系统。
- **渐变隔离**：Kotlin 与 Bitbucket 同屏时保持各自颜色。文件树、选择器和规则预览共用的渲染入口必须隔离每个图标实例的内部标识及引用。
- **名称匹配**：`constructor`、`__proto__` 等合法目录名不能命中对象继承属性。正常映射、自定义规则、大小写不敏感和最长扩展名优先规则不变。
- **键盘选图**：搜索结果可使用 Tab 聚焦，聚焦后 Enter 或 Space 完成选择，Escape 取消。鼠标点击行为保留，不要求新增方向键网格导航。
- **文档入口**：中英文 README 的贡献指南链接在 GitHub 上可点击，并指向仓库中的 `CONTRIBUTING.md`。
- **事实基线**：上述显示问题已在独立 Obsidian 1.13.7 环境复现。原有测试、构建、设置增删改、多视图及三轮启停检查通过。
- **尚未覆盖**：移动端、Obsidian 1.13.0、第三方主题及正式远端发布不在已有实测证据内。实施后须如实报告验证范围，不将模拟测试称为宿主验证。

---

## 文件职责与执行准备

> 运行时代码改动集中在既有入口与样式中。
> 本计划文件是唯一新增的长期文档。

**文件范围**

- **修改 `src/main.ts`**：主题事件、矢量图引用隔离、安全的映射查询、原生选择按钮。
- **修改 `styles.css`**：仅调整选图按钮的默认样式及键盘焦点状态。
- **修改 `tests/file-tree.test.mjs`**：复用编译替身和文档模型辅助函数，增加上述行为回归。
- **修改 `README.md`、`README-zh.md`**：各恢复一处贡献指南链接。
- **不修改 `tests/release.test.mjs`、`scripts/`、`.github/workflows/`、`package.json`、`package-lock.json`、`manifest.json`、`src/icon-data.d.ts`**。
- **依赖顺序**：任务 1 → 2 → 3 → 4 → 5 → 6。同一实现文件和测试入口连续演进，执行者不得并行编辑这些文件。

**执行前检查**

- [x] 阅读并遵守实际环境的 `AGENTS.md`，确认工作目录类型，保留已有改动。
- [x] 执行以下只读及远端引用同步检查，确认基线是否发生变化。

```bash
git status --short
git worktree list --porcelain
git fetch origin
git log --oneline HEAD..origin/main
git merge-base --is-ancestor b7a3b06ab5904aa2bea8a56109e8d8c6a952c8a5 origin/main
```

- [x] 若存在更新，检查涉及本计划文件的差异并校准计划，不覆盖其他任务的改动。
- [x] 使用独立命名分支 `codex/fix-plugin-quality`。主仓库中确认未提交内容仅含本计划、且任务分支尚未创建时，执行下列命令。已有任务分支则核对后继续，不重复创建。需要新工作树时先执行 `superpowers:using-git-worktrees`，不在工作树检出 `main`。

```bash
git switch -c codex/fix-plugin-quality origin/main
```
- [x] 使用 Node.js 22 与 npm 10。执行基线检查，出现失败先定位环境或既有问题，不通过删测试继续。

```bash
node --version
npm --version
npm ci
npm test
npm run lint
npm run build
```

- [x] 尚未提交的计划须先加入任务分支，按下列命令单独提交并推送。已包含计划的提交不重复创建。

```bash
git add docs/superpowers/plans/2026-09-07-plugin-quality-fixes.md
git commit -m "docs: 规划插件质量修复" -m "固定五项审查问题的实施范围和最小方案。
记录回归用例、宿主验收及交付边界。"
git push -u origin HEAD
```

- [x] 每个实现任务通过验证后按逻辑单元提交并推送，提交说明保留改动范围和行为变化。下列提交命令只用于已获实施授权的阶段。

---

## 实施任务

> 每项任务按失败测试、最小实现、复测和提交推进。
> 文档修复使用确定的内容检查代替新增长期测试脚本。

### Task 1：接入宿主主题状态和变化通知

**Files**

- Modify：`src/main.ts` 的 `onload()`、`onunload()` 和主题字段。
- Test：`tests/file-tree.test.mjs` 的图标替身、插件初始化辅助函数及主题用例。

**Interfaces**

- Consumes：`App.isDarkMode(): boolean`、`Workspace.on('css-change', callback)`、`Plugin.registerEvent()`、`resetAndRefresh(): void`。
- Produces：保留 `plugin.isDark: boolean`，在加载后和主题变化后与宿主一致。
- Produces：测试辅助函数 `createLoadedThemePlugin(initialDark)`，返回 `{ plugin, events, setDark, dispose }`。

- [x] **Step 1：增加能区分深浅主题的测试素材。** 在既有 `SVG` 常量增加以下字段，在测试替身 `iconRegistry` 增加 `vercel` 条目，并将 `fileNameKeys` 改为含 `'vercel.json': 'vercel'` 的对象。

```javascript
// SVG 中新增
vercelDark: '<svg xmlns="http://www.w3.org/2000/svg" data-icon="vercel-dark"></svg>',
vercelLight: '<svg xmlns="http://www.w3.org/2000/svg" data-icon="vercel-light"></svg>',

// iconRegistry 中新增
vercel: { dark: SVG.vercelDark, light: SVG.vercelLight },
```

- [x] **Step 2：在测试文件加入加载辅助函数和失败用例。** `onLayoutReady()` 不触发，仅隔离本任务的加载及事件行为。既有文件树用例继续负责行观察逻辑，最终实机步骤负责真实宿主生命周期。

```javascript
async function createLoadedThemePlugin(initialDark) {
  const plugin = createPlugin();
  const events = new Map();
  const cleanups = [];
  let dark = initialDark;
  plugin.bootTimers = [];
  plugin.app = {
    isDarkMode: () => dark,
    workspace: {
      on(name, callback) {
        events.set(name, callback);
        return { name };
      },
      onLayoutReady() {},
    },
  };
  plugin.loadSettings = async () => {};
  plugin.addSettingTab = () => {};
  plugin.registerEvent = ref => cleanups.push(() => events.delete(ref.name));
  plugin.register = callback => cleanups.push(callback);
  await plugin.onload();
  return {
    plugin,
    events,
    setDark(value) { dark = value; },
    dispose() {
      plugin.onunload();
      cleanups.forEach(callback => callback());
    },
  };
}

test('theme: startup and changes use the host scheme', async t => {
  const h = await createLoadedThemePlugin(true);
  t.after(() => h.dispose());
  assert.equal(h.plugin.getFileIconSvg('vercel.json'), SVG.vercelDark);

  const container = document.createElement('div');
  const { item, title } = createFileRow('vercel.json');
  container.appendChild(item);
  document.body.appendChild(container);
  h.plugin.containers.set(container, h.plugin.observeContainer(container));
  h.plugin.refreshIcons();
  assert.equal(title.querySelector('svg').dataset.icon, 'vercel-dark');

  h.setDark(false);
  h.events.get('css-change')();
  assert.equal(title.querySelector('svg').dataset.icon, 'vercel-light');

  const unchanged = title.querySelector('svg');
  h.events.get('css-change')();
  assert.equal(title.querySelector('svg'), unchanged);

  h.setDark(true);
  h.events.get('css-change')();
  assert.equal(title.querySelector('svg').dataset.icon, 'vercel-dark');
});

test('theme: registered callbacks are removed on unload', async () => {
  const h = await createLoadedThemePlugin(false);
  assert.equal(h.events.has('css-change'), true);
  h.dispose();
  assert.equal(h.events.has('css-change'), false);
});
```

- [x] **Step 3：运行失败测试。** 预期深色启动仍返回浅色素材，或缺少 `css-change` 回调。

```bash
node --test --test-name-pattern='theme:' tests/file-tree.test.mjs
```

- [x] **Step 4：在 `await this.loadSettings()` 后初始化主题并注册事件。** 删除 `themeObserver`、`themeDoc` 两个闲置字段及其注册、断开和置空语句，不删除文件树观察器或其他清理逻辑。

```typescript
this.isDark = this.app.isDarkMode();
this.registerEvent(this.app.workspace.on('css-change', () => {
  const nextIsDark = this.app.isDarkMode();
  if (nextIsDark === this.isDark) return;
  this.isDark = nextIsDark;
  this.resetAndRefresh();
}));
```

- [x] **Step 5：运行主题用例、全量测试与检查。**

```bash
node --test --test-name-pattern='theme:' tests/file-tree.test.mjs
npm test
npm run lint
npm run build
```

- [x] **Step 6：提交并推送主题修复。**

```bash
git add src/main.ts tests/file-tree.test.mjs
git commit -m "fix: 恢复图标主题适配" -m "使用宿主主题查询和变化通知刷新图标。
删除闲置主题字段，补充初始化、切换和注销回归。"
git push -u origin HEAD
```

### Task 2：隔离每个矢量图实例的内部引用

**Files**

- Modify：`src/main.ts` 的 `parseSvgIcon()`。
- Test：`tests/file-tree.test.mjs` 的图标替身与渐变隔离用例。

**Interfaces**

- Consumes：`parseSvgIcon(svg: string, doc: Document): SVGElement | null`，所有文件树、规则预览和选择器共用此入口。
- Produces：函数签名不变，返回节点中的本地 `id`、`url(#id)`、`href="#id"`、`xlink:href="#id"` 成对改名。
- Boundary：只处理随插件发布的矢量图属性，不引入任意用户矢量图清洗器，不改变颜色、路径和视口。

- [x] **Step 1：增加两个同名渐变的素材。** 将以下 `gradientA`、`gradientB` 加入 `SVG`，将 `gradient` 加入测试替身图标表，增加 `grad: 'gradient'` 扩展名映射。

```javascript
// SVG 中新增
gradientA: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="a"><stop stop-color="red"/></linearGradient><linearGradient id="b" xlink:href="#a"/></defs><path fill="url(#b)"/><use href="#a"/></svg>',
gradientB: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="a"><stop stop-color="blue"/></linearGradient><linearGradient id="b" xlink:href="#a"/></defs><path fill="url(#b)"/><use href="#a"/></svg>',

// iconRegistry 中新增
gradient: { dark: SVG.gradientA, light: SVG.gradientB },
```

- [x] **Step 2：增加以下失败用例。** 断言引用仍落在各自图标内部，不将序号具体值写死在测试中。

```javascript
test('svg isolation: instances keep their own IDs and references', () => {
  const plugin = createPlugin();
  const first = createFileRow('first.grad');
  const second = createFileRow('second.grad');
  document.body.append(first.item, second.item);
  plugin.isDark = true;
  plugin.injectFileIcon(first.title, 'first.grad');
  plugin.isDark = false;
  plugin.injectFileIcon(second.title, 'second.grad');
  const svgs = [first, second].map(row => row.title.querySelector('svg'));
  const ids = svgs.flatMap(svg => [...svg.querySelectorAll('[id]')].map(el => el.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const svg of svgs) {
    const [a, b] = svg.querySelectorAll('linearGradient');
    assert.equal(b.getAttributeNS('http://www.w3.org/1999/xlink', 'href'), `#${a.id}`);
    assert.equal(svg.querySelector('path').getAttribute('fill'), `url(#${b.id})`);
    assert.equal(svg.querySelector('use').getAttribute('href'), `#${a.id}`);
  }
  assert.equal(svgs[0].querySelector('stop').getAttribute('stop-color'), 'red');
  assert.equal(svgs[1].querySelector('stop').getAttribute('stop-color'), 'blue');

  const host = first.title.querySelector('.mfi-icon');
  plugin.injectFileIcon(first.title, 'first.grad', true);
  assert.equal(first.title.querySelector('.mfi-icon'), host);
  const finalIds = [...document.querySelectorAll('.mfi-icon [id]')].map(el => el.id);
  assert.equal(new Set(finalIds).size, finalIds.length);
});
```

- [x] **Step 3：运行失败测试。** 预期唯一标识数量小于标识总数量。

```bash
node --test --test-name-pattern='svg isolation:' tests/file-tree.test.mjs
```

- [x] **Step 4：在矢量图辅助函数区域增加实例计数器，并替换 `parseSvgIcon()`。** 无内部标识的图标走快速返回路径。仅改写当前图标中存在的标识，保留属性命名空间。

```typescript
let svgInstanceId = 0;

function parseSvgIcon(svg: string, doc: Document): SVGElement | null {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) return null;
  const root = parsed.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg') return null;

  const node = doc.importNode(root, true) as unknown as SVGElement;
  const identified: Element[] = Array.from(node.querySelectorAll('[id]'));
  if (node.hasAttribute('id')) identified.unshift(node);
  if (identified.length === 0) return node;

  const prefix = `mfi-svg-${++svgInstanceId}-`;
  const ids = new Map<string, string>();
  for (const element of identified) {
    const original = element.getAttribute('id');
    if (!original) continue;
    const renamed = prefix + original;
    ids.set(original, renamed);
    element.setAttribute('id', renamed);
  }

  for (const element of [node, ...Array.from(node.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      let value = attribute.value;
      if (attribute.localName === 'href' && value.startsWith('#')) {
        const renamed = ids.get(value.slice(1));
        if (renamed) value = `#${renamed}`;
      }
      value = value.replace(
        /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g,
        (match: string, _quote: string, id: string) => {
          const renamed = ids.get(id);
          return renamed ? `url(#${renamed})` : match;
        },
      );
      if (value !== attribute.value) {
        element.setAttributeNS(attribute.namespaceURI, attribute.name, value);
      }
    }
  }
  return node;
}
```

- [x] **Step 5：运行隔离用例、原有行复用回归和全量检查。** 真实颜色对比属于任务 6 的必做验收，不能用标识数量断言替代。

```bash
node --test tests/file-tree.test.mjs
npm test
npm run lint
npm run build
```

- [x] **Step 6：提交并推送渐变隔离修复。**

```bash
git add src/main.ts tests/file-tree.test.mjs
git commit -m "fix: 隔离图标内部渐变引用" -m "为每个矢量图实例隔离内部标识及引用。
保留图标宿主复用，增加命名空间和渐变回归。"
git push
```

### Task 3：只查询映射表自身的条目

**Files**

- Modify：`src/main.ts` 的图标表查询辅助函数及五类查询点。
- Test：`tests/file-tree.test.mjs` 的特殊名称和显式映射用例。

**Interfaces**

- Consumes：既有 `iconRegistry`、`fileNameKeys`、`fileExtensionKeys`、`folderNameKeys`、`folderNameOpenKeys`。
- Produces：文件内辅助函数 `ownValue<T>(table: Record<string, T>, key: string): T | undefined`，不导出或建立通用模块。

- [x] **Step 1：将测试替身 `fileNameKeys` 保留 `vercel.json` 条目并加入显式 `constructor: 'typescript'`。增加以下用例。** 文件夹表保持空对象，用于复现继承属性错误。

```javascript
test('lookup: inherited names use folder defaults', () => {
  const plugin = createPlugin();
  for (const name of ['constructor', '__proto__', 'CONSTRUCTOR']) {
    assert.equal(plugin.getFolderIconKey(name, true), 'folder');
    assert.equal(plugin.getFolderIconKey(name, false), 'folder-open');
    const { item, title } = createFolderRow(name);
    document.body.appendChild(item);
    plugin.injectFolderIcon(title, true);
    assert.equal(title.querySelector('svg').dataset.icon, 'folder');
    plugin.updateFolderIcon(title, false);
    assert.equal(title.querySelector('svg').dataset.icon, 'folder-open');
  }
});

test('lookup: own entries win and inherited icon keys are rejected', () => {
  const plugin = createPlugin();
  assert.equal(plugin.getFileIconSvg('CONSTRUCTOR'), SVG.typescript);
  assert.equal(plugin.getFileIconSvg('sample.ts'), SVG.typescript);
  assert.equal(plugin.getFileIconSvg('sample.unknown'), SVG.file);
  assert.equal(plugin.getIconSet('constructor').light, SVG.file);
  assert.equal(plugin.getIconSet('__proto__').light, SVG.file);
});
```

- [x] **Step 2：运行失败测试。** 预期目录查询返回函数或对象，或图标表返回继承属性。

```bash
node --test --test-name-pattern='lookup:' tests/file-tree.test.mjs
```

- [x] **Step 3：增加以下辅助函数。** 使用与 `ES2018` 类型库兼容的自身属性检查，不修改编译目标。

```typescript
function ownValue<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
```

- [x] **Step 4：修改以下查询点。** 自定义规则数组匹配、优先级和默认图标键保持不变。

```typescript
// getIconSet() 的返回值
return ownValue(iconRegistry, key)
  ?? ownValue(iconRegistry, defaultFileIconKey)
  ?? { dark: '', light: '' };

// getFileIconSvg() 的三个表查询
const scopedKey = ownValue(fileNameKeys, segments.slice(-2).join('/'));
const nameKey = ownValue(fileNameKeys, lower);
const extKey = ownValue(fileExtensionKeys, ext);

// getFolderIconKey() 的返回值
return ownValue(table, name) ?? (collapsed ? folderIconKey : folderOpenIconKey);
```

- [x] **Step 5：运行名称匹配用例和全量检查。**

```bash
node --test --test-name-pattern='lookup:' tests/file-tree.test.mjs
npm test
npm run lint
npm run build
```

- [x] **Step 6：提交并推送映射查询修复。**

```bash
git add src/main.ts tests/file-tree.test.mjs
git commit -m "fix: 排除图标映射的继承属性" -m "映射查询只读取对象自身的条目。
覆盖特殊目录名、默认图标及显式同名映射。"
git push
```

### Task 4：使用原生按钮完成键盘选图

**Files**

- Modify：`src/main.ts` 的 `IconPickerModal.onOpen()`。
- Modify：`styles.css` 的选图条目样式。
- Test：`tests/file-tree.test.mjs` 的测试编译入口、最小弹窗替身及选择器行为用例。

**Interfaces**

- Consumes：`IconPickerModal(app, isDark, currentKey, strings, onSelect)` 的既有构造参数与回调。
- Produces：原生 `button` 选项，保留 `.mfi-picker-item`、`.mfi-picker-svg`、`.mfi-picker-name` 类名及搜索逻辑。
- Boundary：不实现完整弹窗框架，不增加运行时测试导出，不模拟浏览器的原生键盘行为。

- [x] **Step 1：仅在测试编译结果中导出选择器类。** 测试文件增加 `readFileSync`、`dirname` 导入，在已有 `builder` 配置中增加下列加载规则，将模块解构改为同时读取 `default` 与 `IconPickerModal`。

```javascript
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

builder.onLoad({ filter: /[\\/]src[\\/]main\.ts$/ }, args => ({
  contents: readFileSync(args.path, 'utf8') + '\nexport { IconPickerModal };',
  loader: 'ts',
  resolveDir: dirname(args.path),
}));

// 替换既有模块解构
const { default: MaterialFileIconsPlugin, IconPickerModal } = await import(moduleUrl);
```

- [x] **Step 2：替换测试替身的空 `Modal` 类。** 其余宿主替身保持原状。

```javascript
export class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = document.createElement('div');
    this.titleEl = document.createElement('h2');
  }
  close() { this.onClose(); }
}
```

- [x] **Step 3：在既有 `Object.defineProperties(window.HTMLElement.prototype, ...)` 中追加以下属性。** 保留已有 `createSpan`、`empty`、`instanceOf` 实现。

```javascript
createEl: {
  value(tag, options = {}) {
    const el = this.ownerDocument.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text) el.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
    this.appendChild(el);
    return el;
  },
},
createDiv: {
  value(options = {}) { return this.createEl('div', options); },
},
addClass: {
  value(...classes) { this.classList.add(...classes); },
},
setText: {
  value(text) { this.textContent = text; },
},
```

- [x] **Step 4：为已有 `createSpan` 辅助函数增加 `options.text` 支持，写入选择器失败用例。** 原生键盘选择另由实机验收，不用合成 `keydown` 的结果冒充浏览器行为。

```javascript
// createSpan 中在 appendChild 前新增
if (options.text) span.textContent = options.text;

test('picker: searchable options are focusable named buttons', t => {
  const chosen = [];
  const picker = new IconPickerModal({}, false, 'typescript', {
    pickIcon: '选择图标',
    searchPlaceholder: '搜索图标',
  }, key => chosen.push(key));
  t.after(() => picker.onClose());
  document.body.appendChild(picker.contentEl);
  picker.onOpen();
  const search = picker.contentEl.querySelector('input');
  search.value = ' TypeScript ';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  const options = [...picker.contentEl.querySelectorAll('.mfi-picker-item')];
  assert.equal(options.length, 1);
  const option = options[0];
  assert.equal(option.tagName, 'BUTTON');
  assert.equal(option.type, 'button');
  assert.equal(option.getAttribute('aria-label'), 'typescript');
  assert.equal(option.getAttribute('aria-pressed'), 'true');
  assert.equal(option.tabIndex, 0);
  option.focus();
  assert.equal(document.activeElement, option);
  option.click();
  assert.deepEqual(chosen, ['typescript']);
  assert.equal(picker.contentEl.childElementCount, 0);
});

test('picker: closing without selection does not submit a rule', () => {
  const chosen = [];
  const picker = new IconPickerModal({}, false, '', {
    pickIcon: '选择图标',
    searchPlaceholder: '搜索图标',
  }, key => chosen.push(key));
  picker.onOpen();
  picker.onClose();
  assert.deepEqual(chosen, []);
});
```

- [x] **Step 5：运行失败测试。** 预期条目仍是 `DIV`，而不是可聚焦按钮。

```bash
node --test --test-name-pattern='picker:' tests/file-tree.test.mjs
```

- [x] **Step 6：替换选项创建代码和两个内部容器。** 保留既有选中样式与点击回调，不增加 Enter、Space 的自定义键盘处理器。

```typescript
const item = grid.createEl('button', {
  cls: 'mfi-picker-item',
  attr: {
    type: 'button',
    'aria-label': key,
    'aria-pressed': String(key === this.currentKey),
  },
});
if (key === this.currentKey) item.addClass('is-active');

const svgWrap = item.createSpan({ cls: 'mfi-picker-svg' });
renderIconInto(svgWrap, svg, 24);
item.createSpan({ text: key, cls: 'mfi-picker-name' });
```

- [x] **Step 7：把条目、悬停和选中规则的选择器改成 `button.mfi-picker-item` 对应形式，并给条目规则增加下列属性。** 保留原有布局、间距与边框规则，不修改其他组件样式。

```css
/* 追加到 button.mfi-picker-item 规则内 */
height: auto;
color: var(--text-normal);
background: transparent;
box-shadow: none;
font: inherit;
text-align: center;

/* 新增独立规则 */
button.mfi-picker-item:focus-visible {
  outline: 2px solid var(--interactive-accent);
  outline-offset: -2px;
}
```

- [x] **Step 8：运行选择器及全量检查。** 窄窗口尺寸、焦点可见性和原生按键属于任务 6 的必做检查。

```bash
node --test --test-name-pattern='picker:' tests/file-tree.test.mjs
npm test
npm run lint
npm run build
```

- [x] **Step 9：提交并推送键盘选图修复。**

```bash
git add src/main.ts styles.css tests/file-tree.test.mjs
git commit -m "fix: 支持键盘选择图标" -m "使用具有可访问名称的原生按钮展示选图结果。
保留鼠标选择和搜索行为，补充焦点样式与行为回归。"
git push
```

### Task 5：恢复 GitHub 可用的贡献指南链接

**Files**

- Modify：`README.md:160`、`README-zh.md:160` 的贡献指南入口，行号以审查基线为准。
- Test：一次性内容检查，不新增文档检查依赖或长期脚本。

**Interfaces**

- Consumes：仓库根目录的 `CONTRIBUTING.md`。
- Produces：两种语言文档中的标准相对链接。
- Boundary：本项明确使用标准 Markdown 链接，覆盖格式技能关于仓库内文档使用双括号链接的默认规则。

- [x] **Step 1：运行下列检查，确认失败发生在旧的双括号链接上。**

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
assert.ok(existsSync('CONTRIBUTING.md'));
for (const file of ['README.md', 'README-zh.md']) {
  const source = readFileSync(file, 'utf8');
  assert.ok(source.includes('[CONTRIBUTING.md](CONTRIBUTING.md)'), file);
  assert.ok(!source.includes('[[CONTRIBUTING|CONTRIBUTING.md]]'), file);
}
JS
```

- [x] **Step 2：将两处链接分别替换为以下内容。** 不修改其他文案或图标数量说明。

```markdown
See [CONTRIBUTING.md](CONTRIBUTING.md) for development, tests, upstream updates and releases.
```

```markdown
开发、测试、上游升级与发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
```

- [x] **Step 3：重新运行 Step 1 检查，确认通过。**

- [x] **Step 4：提交并推送链接修复。**

```bash
git diff --check
git add README.md README-zh.md
git commit -m "docs: 恢复贡献指南标准链接" -m "修正中英文说明中的贡献指南入口。
使用 GitHub 可渲染的相对链接，不改动指南内容。"
git push
```

---

## 最终验收与交付

> 自动测试与真实宿主验证分别报告。
> 未验证的环境不得标记为通过。

### Task 6：全量验证、宿主复测和交付审查

**Files**

- Verify：前五项任务的文件范围以及既有测试、构建和发布配置。
- Temporary：临时测试笔记库、截图和诊断脚本留在仓库之外，不新增长期工具。

**Interfaces**

- Consumes：任务 1–5 的最终提交和构建产物。
- Produces：全量检查结果、宿主版本、复现前后证据、性能对比和未验证清单。

- [x] **Step 1：执行锁定安装、全量回归和构建，确认原有发布测试仍通过。**

```bash
npm ci
npm test
npm run lint
npm run build
git diff --check
```

- [x] **Step 2：确认生成结果可复现并记录体积。** 两次构建的文件摘要必须相同，矢量图实例计数器不参与构建输出的随机化。

```bash
sha256sum main.js src/icon-data.ts
wc -c main.js
npm run build
sha256sum main.js src/icon-data.ts
wc -c main.js
```

- [x] **Step 3：准备独立的真实宿主环境。** 从该环境实际安装的 Obsidian 启动独立测试笔记库。若通过调试端口驱动，必须使用独立用户配置和已确认空闲的端口。不得连接另一项任务或日常笔记库执行写操作。
- [x] **Step 4：主题验收。** 创建内容为 `{}` 的 `vercel.json`，必要时启用显示所有文件类型。分别执行深色启动、浅色切换、切回深色，核对图标填充色。切换后打开规则和选择器，核对预览颜色。
- [x] **Step 5：渐变验收。** 创建 `a.kt` 与 `bitbucket-pipelines.yml` 并同时显示。保存修复前后截图，确认 Bitbucket 保持蓝色，不受 Kotlin 是否在视图中影响。打开完整选择器并搜索 `kotlin`、`bitbucket`、`aurelia`，核对筛选前后的颜色一致。
- [x] **Step 6：名称验收。** 创建 `constructor`、`__proto__` 两个目录，在展开与折叠后都保持默认目录图标。确认普通目录和文件类型仍命中原有图标。
- [x] **Step 7：键盘与规则验收。** 只使用键盘打开新增规则、填写扩展名、进入选择器、搜索 `typescript`、Tab 聚焦结果、Enter 确认。再次使用 Space 选择，另一次使用 Escape 取消。补测鼠标选择、编辑、删除、重复扩展名提示以及重新打开后的保存结果。
- [x] **Step 8：窗口与资源验收。** 在两个文件树和独立窗口中检查图标。完成至少三轮禁用、启用，禁用后插件图标、标记、文件树观察器和启动计时器必须清理，重新启用后没有重复或缺失图标。
- [x] **Step 9：滚动与性能验收。** 在约 500 个文件的临时笔记库中往返滚动、展开、折叠和重命名，核对可见行图标。分别重复测量五次选择器打开和相同搜索操作，与审查基线或同环境旧构建比较中位数。存在持续变慢时定位新增逻辑，不直接引入缓存层或虚拟列表。
- [x] **Step 10：兼容性记录。** 检查标准桌面窗口及窄窗口中的按钮布局、焦点边框和长图标名称。具备移动设备或最低版本环境时补实测，不具备时明确保留未验证项，不以桌面缩窄代替移动端验证。
- [x] **Step 11：运行 `/gstack-review` 技能。** 本环境对应可用技能 `review`。逐项复核发现的触发条件、实际影响、最小修复和长期代价，只修复本计划范围内的有效发现，并重跑相关测试及全量检查。
- [ ] **Step 12：在实施授权包含交付时运行 `/gstack-ship` 技能。** 本环境对应可用技能 `ship`。完成必要提交、推送和 PR（合并请求）创建，遵守仓库提交及问题关联规范。遇到需要新权限或扩大范围的动作时停止并请求用户决定，不自动合并或正式发布。
- [x] **Step 13：交付结果。** 汇报改动、审查结论、测试结果、实机范围、性能对比、PR 地址及未解决事项。计划完成不以测试数量、文件长度或“零风险”作为标准。

---

## 实施验证记录

> 2026-09-07，在当前主仓库的 `codex/fix-plugin-quality` 分支实施。
> 自动化检查与真实宿主检查分别记录；不把未覆盖环境记为通过。

- **实现提交**：`f472c48` 主题、`ede326e` 渐变隔离、`7bcc2bd` 自身属性查询、`421e7ec` 键盘选图、`99af71f` 文档链接；均已提交并推送任务分支。
- **范围核对**：未修改依赖、锁文件、版本、上游绑定或发布链路；未提交生成文件。五项任务均通过独立规格与代码质量审查；最终整体审查及 Task 6 证据验收通过，无需要修复的发现，结论为可以合并，但没有执行合并。
- **自动化**：Node.js 22.23.2 / npm 10.9.9 下锁定安装、47 项测试、代码检查、类型检查和构建通过；原有 40 项测试保留。控制器交付前全量复测再次通过。
- **可复现构建**：两次 `main.js` SHA-256（摘要）均为 `85b8c9e98a7e15c84915ba9b72ced81b49921be6c1008b52c56a458549534bc3`；产物 `2,100,169` 字节，比基线增加 `769` 字节。
- **宿主功能**：独立 Obsidian 1.13.7 测试库确认深色启动、明暗切换及预览；Kotlin 与 Bitbucket 同屏颜色正确；完整选择器 1,126 项中的 1,136 个内部标识无重复，搜索前后颜色一致。
- **规则交互**：原生键盘 Tab、Enter、Space、Escape 和原生鼠标输入验证选择、取消、新增、编辑、删除、重复提示与持久化。测试初始焦点由程序设置，随后补查了原生 Tab 到达添加规则入口，不宣称系统设置入口全流程键盘自动化。
- **生命周期与文件树**：两个文件树、两个文档完成三轮禁用及启用；禁用后图标、标记、观察器及启动计时器归零，启用后无缺图或重复。514 个文件的滚动、展开、折叠及重命名样本全部正确；瞬时行数为 35、48、107、243、49、35，不能声称始终维持基线的 35–49 行；脱离文档的目录观察器为 0。
- **性能**：同方法五次测量，打开选择器中位数从旧版 `175.9 ms` 变为新版首次 `263.1 ms`，空闲前台复测为 `208.8 ms`；搜索由 `10.7 ms` 变为复测 `11.9 ms`。新增同步路径包含必要的内部引用隔离及原生按钮构建，未单独测量两者占比；没有为这项规则编辑时才触发的操作新增缓存或工具链。
- **布局**：标准桌面窗口及 `480×700` 桌面模拟视口中，长名称省略、2 像素键盘焦点边框和按钮布局通过；窄视口内按钮无重叠或越界。视口模拟不等于物理窗口或移动端实测。
- **宿主限制**：`constructor`、`__proto__` 顶层目录行的开合图标已验证；特殊目录测试数据还触发宿主自身索引及视图创建异常。仅在独立测试库可恢复地改名和移动测试文件，重启后文件树恢复；未给插件增加宿主兼容层，也不宣称修复该宿主限制。
- **既有安装提示**：`npm audit` 报告 `fast-uri` 开发依赖的一项 high（高严重性）告警，锁文件未变，不是本分支新增的运行时依赖；本计划未越界升级依赖。
- **未验证及未执行**：移动端、Obsidian 1.13.0、第三方主题未实测；尚未创建 PR、合并主分支、创建标签或正式发布。步骤 12 留待用户选择远端交付后执行。
- **本机证据**：逐项报告与审查账本保留于本计划对应的 `.superpowers/sdd/2026-09-07-plugin-quality-fixes/` 忽略目录；原始宿主日志和截图位于 `/tmp/material-icons-review.yARtFY/`，未提交到仓库。

---

## 计划确认后的执行选项

> 写完计划不代表已获得实施或远端交付授权。
> 选择执行方式后再进入对应流程。

- **子代理逐任务执行（推荐）**：使用 `superpowers:subagent-driven-development`，每项任务完成后审查，再进入下一项。
- **当前任务内执行**：使用 `superpowers:executing-plans`，按上述顺序实施并在检查点汇报。
- **整理提示词交给另一位 Agent（智能体）执行**：提示词以本计划为唯一实施依据，不复制实现细节。
  - 转交前提交并推送计划所在分支，核实包含计划的实际提交标识。
  - 提示词列明仓库、分支、提交和计划路径，要求阅读并遵守 `AGENTS.md`。
  - 要求完成后执行 `/gstack-review` 的审查、修复与复测，再执行 `/gstack-ship` 完成提交、推送和 PR 创建。
  - 要求在授权范围内自动采用技能推荐的最优选项，最终汇报 PR、审查、测试和未解决事项。
