# Command Menu Extension Guide（命令菜单扩展指南）

v0.2.2 起插件的 `/`（斜杆）与 `<`（角括号）命令使用**自绘菜单**（`src/features/commandMenu.ts`），不再走 CM6 的 tooltip 补全层（探针实测 CM6 tooltip 在 Obsidian 宿主 DOM 中不渲染，连内置 `[[` 补全也不显示）。本文说明如何追加新命令。

## 两种命令类型

### 1. 文本插入命令（insert）

在触发点插入一段文本（替换 `/query` 或 `<query` 触发文本），可指定插入后的光标位置：

```ts
// src/features/commandMenu.ts → SLASH_COMMANDS 数组
{ label: 'Callout', group: 'Formatting', detail: 'Obsidian callout', insert: '> [!note] ', caret: 0 },
```

- `insert`：插入的文本（支持 `\n`）
- `caret`（可选）：插入后光标在插入文本中的偏移；缺省为文本末尾

### 2. 块模型命令（block）

通过宿主视图执行结构操作（撤销栈、脏标记、重渲染自动走 `host.mutate`）：

```ts
{
  label: 'Clear scheduled',
  group: 'Task state',
  detail: 'remove scheduled:: property',
  block: (h) => h.setPropCommand('scheduled', null), // 见下方 helper 约定
},
```

块命令拿到的 `host` 是 `BlockEditorView`，可直接用：

- `host.focusedBlock` — 当前聚焦块（可能为 null，务必判空）
- `host.mutate(fn, patch)` — 一切结构变更的统一入口
- 现成桥接方法：`handleTabFromCommand(shift)`、`handleEnterFromCommand()`、`deleteFocusedBlock()`

### `<` 命令（ANGLE_COMMANDS）

同理，但语义是 HTML 片段与实体（`div/br/mark/kbd/&nbsp;…`）。数组同样在 `commandMenu.ts`。

## 触发与过滤规则

- `/` 在**行首或空白后**触发斜杆菜单；`<` 同理触发角括号菜单（`maybeOpenMenu` 里的 `/(^|\s)[\/<]$/`）。
- 触发后继续打字即过滤（label / group / detail 三字段模糊匹配）；菜单内 `↑↓` 选择、`Enter`/`Tab` 执行、`Esc`/点击外部关闭。
- 过滤词里出现空格自动关闭菜单（查询只取一个词；`&` 开头的实体查询除外）。
- 菜单打开期间 `↑↓/Enter/Tab/Esc` 被 `commandMenuKeymap()`（Prec.highest）拦截，不影响正常打字。

## 样式

菜单 DOM 类名：`.block-command-menu > .bcm-item(.is-selected) > .bcm-label + .bcm-detail`，样式在 `styles.css` 末尾的 "Self-drawn slash / angle command menu" 区块。

## 回归清单（改动命令后必跑）

```bash
npm test                                        # 208 单测
npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/ux.spec.ts        # 4 项 UX（含菜单）
npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/acceptance.spec.ts # 8 项安全回归
```

UX E2E 02/03 会真实键入 `/todo`、`<kbd` 并断言落盘结果——新增命令若影响持久化格式，先改这里。
