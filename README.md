# Breadcrumb Nav（Obsidian 面包屑导航）

把 [logseq-plugin-breadcrumb-nav](../logseq-plugin-breadcrumb-nav) 的思路搬到 Obsidian：
在**笔记顶部、文件路径（视图头部）下方**常驻一条面包屑，显示 `文件名 › 一级标题 › 二级标题 › …`，
并支持**悬浮查看同级**与**下一级连续下钻**（菜单项悬浮即自动铺开下一级，不用点）。

Logseq 里是「页面 ➡️ 块层级」，Obsidian 里对应「文件 ➡️ 标题层级（H1 › H2 › H3 …）」。

## 功能

- **面包屑常驻**：打开笔记即显示，占据笔记顶部一栏空间（不遮挡正文）；默认吸顶，滚动时固定在文件路径下方。
  **切到非笔记视图（新建标签页、看板等）时保留占位不移除**，切回笔记正文位置不变，不会来回跳动；
  多栏/分屏时每个笔记视图各有一条，各自跟随自己的光标或滚动位置。
- **跟随当前位置**：实时预览下跟随**光标**所在行，阅读模式下跟随**滚动位置**，自动定位到当前标题。
- **悬浮查看同级**：悬浮面包屑某一级，160ms 后弹出该级的同级标题；当前所在那一支加粗高亮，点击跳转。
- **下一级图标（可连续下钻）**：面包屑末尾始终有个 `▸`（没有标题链时代表「顶层标题」），点击或悬浮列出下一级。

  | 点哪里 | 行为 |
  | --- | --- |
  | 列表项**文本** | **跳转**到该标题（面包屑回到「跟随当前位置」模式） |
  | 列表项**（悬浮）** | **就地展开**它的下一级，叠成级联子菜单，可一路悬浮下去（默认开启） |
  | 列表项右侧 **`▸`（点击）** | **继续下钻**：该项追加到面包屑末尾，并立即展开它的下一级菜单 |

  下钻链路：末尾 `▸` → 菜单里点某项的 `▸` → 菜单换成它的下级 → 再点 `▸` …… 想停在某一层就点文本跳转。

  只想快速看一眼下层有什么，鼠标停在条目上 160ms 后右侧自动铺开下一级，鼠标移开或停到别的条目上就自动收起。
  默认**不必瞄准 `▸`**；如果觉得扫过条目就弹出太灵敏，可在设置里关掉「悬浮条目本体即展开」，
  这样只有精确停在 `▸` 上才会展开。
- **点击面包屑某一级**：跳转并把路径**截短到该级**，其 `▸` 继续可选；该级没有下级时不显示图标。
- **跳转对齐视口顶部**：跳转后目标标题停在**视口顶部**（而不是居中），并自动避开吸顶面包屑的高度，不会被盖住。
- **回到跟随模式**：在编辑器里点了别处、移动光标或用方向键移动，面包屑恢复为「跟随当前位置」，下钻状态清空。
- **悬浮文件名显示同标签笔记**：悬浮面包屑最前面的文件名，列出与当前笔记有相同标签（frontmatter `tags` 或正文 `#标签`）的其他笔记，条目上带出命中的标签（如 `会议记录  #项目`），点击打开。
- **滚动不误关菜单**：滚动时菜单跟随锚点重新定位而不是消失；菜单内部滚动不会关闭。
- **级联子菜单**：菜单项有下级时，鼠标停在条目上（默认，不用瞄准 `▸`）160ms 即展开下一级，可逐层悬浮深入；
  子菜单贴在所属条目右侧（右边放不下自动翻到左侧），来源条目保持高亮标明出处。
  在菜单里移动鼠标不会误收起，只有移出整个菜单区域 220ms 后才关闭。
- **开关**：左侧功能区图标按钮启用/停用（停用态图标带斜线），也可用命令面板的「Breadcrumb Nav: 启用 / 停用面包屑导航」。

## 安装

构建产物统一输出到 **`dist/`**，它本身就是可直接安装的插件目录。把 `dist` 里的内容复制到
`<库>/.obsidian/plugins/breadcrumb-nav/` 即可：

```
breadcrumb-nav/          ← 把 dist/ 里的东西复制到这里
├─ main.js
├─ manifest.json
└─ styles.css
```

然后在 设置 → 第三方插件 里启用。也可以在插件目录里做个软链接指向 `dist`，
这样 `npm run dev` 边改边热重载。

## 设置

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | true | 是否启用（功能区图标 / 命令可切换） |
| `maxLength` | number | 50 | 面包屑与菜单每项文本的最大长度，超出以 … 截断 |
| `enableSiblingsMenu` | boolean | true | 是否启用「悬浮查看同级」 |
| `enableNextLevel` | boolean | true | 是否启用「下一级」图标 |
| `hoverExpandChildren` | boolean | true | 是否启用「悬浮即展开下一级」（关闭后只能点击 ▸ 下钻） |
| `hoverExpandOnItem` | boolean | true | 悬浮**条目本体**即展开下一级；关闭后必须精确停在 `▸` 上才展开 |
| `enableRelatedPages` | boolean | true | 是否启用「悬浮文件名显示同标签笔记」 |
| `includeCurrentHeading` | boolean | true | 是否把当前所在标题也算作面包屑最后一级 |
| `sticky` | boolean | true | 面包屑是否吸顶（关闭则随内容滚动） |
| `followCursor` | boolean | true | 是否跟随光标 / 滚动位置自动更新 |
| `maxMenuItems` | number | 20 | 悬浮菜单一次最多显示多少条目 |

## 实现要点

- **数据来源**：`app.metadataCache.getFileCache(file).headings`（`HeadingCache[]`）用栈构建 `HeadingNode` 树，
  先序遍历顺序即文档顺序，`key` 取标题起始偏移量。
- **当前位置**：实时预览 / 源码模式取 `view.editor.getCursor().line`，找最后一个 `position.start.line <= 光标行` 的标题；
  阅读模式取滚动位置，与 `.markdown-preview-view` 里的 `h1..h6` 元素按序比对。
- **跳转（对齐视口顶部，而不是居中）**：不用 `scrollIntoView` 的居中参数。源码 / 实时预览模式先
  `setCursor` + `scrollIntoView(range, false)` 让目标行进入视口，然后按三条路径依次降级来对齐顶部，
  `inset = 吸顶面包屑高度 + 8px`（不减去的话目标标题会被面包屑盖住）：

  1. **CodeMirror 原生**：运行时 `require("@codemirror/view")`（放在 try/catch 里，宿主没提供就跳过），
     用 `EditorView.scrollIntoView(offset, { y: "start", yMargin: inset })` —— 由 CM 自己找滚动容器，最稳。
  2. **坐标手算**：`cm.coordsAtPos()` 拿视口坐标，向上找**真正会滚动的祖先容器**
     （按 `overflow-y` + `scrollHeight > clientHeight` 判断，兼容 `.cm-scroller` 与 `.view-content`），
     再 `scrollTop += 行top - (容器top + inset)`，并在下一帧用 `requestAnimationFrame` 再校正一次
     （CM / Obsidian 有时会在这之后再滚一次）。
  3. **兜底换算**：`coordsAtPos` 拿不到时（目标行未渲染）用 `cm.lineBlockAt()` + `contentDOM` 位置换算，
     再不行就从 `cm.domAtPos()` 找 `.cm-line` 量位置。

  阅读模式同理：按标题元素位置直接算目标 `scrollTop = 元素在内容中的位置 - inset`。
- 跳转后 600ms 内的滚动 / 光标事件不计为「用户主动切换」，避免程序化跳转把自己的下钻状态清掉。
- **DOM 位置**：面包屑 div 作为 `view.contentEl` 的**第一个子元素**插入（即在文件路径/视图头部下方、正文上方），
  `position: sticky; top: 0`，自身占位所以会自然把正文往下推，不遮挡内容。
- **每个视图一条面包屑**：`bars: Map<contentEl, bar>`，不再全家共用一个实例。
  刷新时遍历 `workspace.getLeavesOfType("markdown")` 逐个渲染（活动视图额外应用下钻态 focal）；
  **一个笔记视图都没有时不移除已有面包屑**，只回收宿主已脱离文档的那些（`pruneDetached`），
  视图真正关闭才由 `pruneBars` 回收——这是「一直占位」的关键。
  判断视图用鸭子类型（`file` + `contentEl` + `getMode`）而非 `instanceof`，测试桩里的视图不是 `MarkdownView` 实例。
  ⚠️ 踩坑：`focalKey` 是全局的，渲染某个视图前必须**先清掉不属于当前这棵树的 focal，再取值**，
  否则会拿上一篇笔记的 key 去查当前树，得到空链（面包屑只剩文件名 + 一个 ▸）。
- **浮层**：`div.bcn-popup` 挂到 `document.body`，`position: fixed`，按锚点 `getBoundingClientRect()` 定位，
  超出视口下沿时自动上翻；`scroll`（capture）只做 `requestAnimationFrame` 重定位，锚点被移除（面包屑重建）才关闭。
- **级联子菜单**：浮层改为**栈式管理**（`popups: PopupLayer[]`，level 0 是根菜单，子菜单依次 +1），
  `closePopupsFrom(level)` 关掉某一层及其后代，切条目 / 移出菜单都靠它收尾。
  菜单条目的下一级用 `MenuEntry.children`（**懒加载函数**）描述，只在悬浮 `▸` 时才构建那一层，
  不会一次性递归展开整棵标题树。
  收起时机：`mouseleave` 起 220ms 计时，菜单内 `mousemove` / `mouseenter` 持续 `cancelHide()`——
  否则 `mouseenter` 只在进入时触发一次，鼠标在菜单里移动会被误判为「移出」而关掉菜单。
- **触发展开的位置可配**：`hoverExpandOnItem` 为 true 时，条目 `mouseenter` 直接 `schedulePopup(item, children, level + 1)`；
  关掉后条目的 `mouseenter` 只负责收起别的条目的子菜单，展开交给 `▸` 上的 `attachSubmenuHover`。
  两种路径走同一个 `schedulePopup`，所以行为（160ms 延时、切条目收起）完全一致。
- **同标签笔记**：遍历 `vault.getMarkdownFiles()` 收集 frontmatter `tags` 与正文 `tags`，取交集，结果缓存 10 秒，`metadataCache` 变更时失效。
- **刷新时机**：`file-open` / `active-leaf-change` 150ms、`layout-change` 200ms、`metadataCache:changed` 250ms、
  `editor-change` 与文档 `scroll` / `mousedown` / 方向键防抖后重建。

## 开发

```bash
npm install
npm run build   # tsc 类型检查 + esbuild 生产构建 → dist/
npm run dev     # esbuild watch（同样输出到 dist/）
npm test        # 构建 + 冒烟测试（迷你 DOM / Obsidian 桩，无需真实 Obsidian）
```

```
obsidian-breadcrumb-nav/
├─ src/
│  ├─ main.ts          # 插件主体：面包屑渲染、跳转、悬浮菜单、同标签笔记
│  ├─ headingTree.ts   # 平铺标题 → 层级树 + 取子级/同级/祖先链
│  ├─ settings.ts      # 设置面板
│  └─ types.ts         # 类型与默认设置
├─ tests/              # 冒烟测试与运行桩
├─ styles.css          # 源样式（构建时复制到 dist/）
├─ manifest.json       # 插件清单（构建时复制到 dist/）
└─ dist/               # 打包产物：main.js + manifest.json + styles.css，可直接安装
```

## 已知限制

- 阅读模式下按「标题元素序号」匹配缓存标题，若笔记里有大量嵌入笔记（也会渲染标题元素）可能对位偏移。
- 标题链很深时面包屑会换行显示（flex-wrap）。
- 与自行改写 `.view-content` 结构的主题/插件同用时，吸顶效果可能受影响，可在设置里关掉「吸顶显示」。
