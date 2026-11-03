# TraceTime

TraceTime is an Obsidian plugin that tracks and displays the **last edited time of every block** (paragraph, heading, code block, list, table…) in your notes, with labels aligned to the right of the document area.

## Features

- **Block-level time tracking**: incremental re-parsing via CodeMirror ChangeSets — only blocks near the edit are touched, never a full-document diff
- **Undo/redo aware**: restoring content with Ctrl+Z restores its original timestamp (content-hash session history)
- **External change recovery**: timestamps migrate by block hash when files are changed by sync tools or other editors
- **Configurable display rules**: a ladder of formats (just now → minutes ago → hours ago → today → yesterday → days ago → this year → full date) with a live-preview settings tab
- **Timestamp rollback**: every write keeps a one-generation backup; restore from the settings tab if timestamps ever get clobbered
- **Performance first**: millisecond incremental path, viewport-only rendering, debounced batched writes, no full-vault scan on startup

## Data storage

Time data lives in `<vault>/.obsidian/plugins/tracetime/records/`, one MessagePack record per Markdown file. **Note content is never stored** — only block hashes, the first/last 32 normalized characters of each block, and timestamps.

## Installation

### Manual

Copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/tracetime/` and enable the plugin in Settings → Community plugins.

### BRAT

Install the BRAT plugin and add the repository `QuincySx/obsidian-tracetime`.

## Development

```
npm install
npm run dev    # watch build
npm run build  # type check + production build
npm test       # core logic self-tests
npm run pack   # package dist/tracetime-<version>.zip
```

---

# TraceTime（中文）

TraceTime 是一个 Obsidian 插件：为笔记中的**每个块**（段落、标题、代码块、列表、表格……）记录并显示"最后编辑时间"，标签统一显示在文档区右侧。

## 特性

- **块级时间追踪**：编辑时通过 CodeMirror ChangeSet 做增量窗口重解析，只处理改动附近的块，不做全文 diff
- **撤销/重做感知**：Ctrl+Z 撤销后内容回到旧版本，时间戳一并恢复（基于内容哈希的会话历史栈）
- **外部修改恢复**：同步软件或其他编辑器改动文件时，按块哈希回迁时间戳
- **可配置的显示规则**：阶梯式规则（刚刚 → N 分钟前 → N 小时前 → 今天 → 昨天 → N 天前 → 今年 → 完整日期），设置页带实时预览
- **时间戳回滚**：每次写入前自动保留上一代备份，误刷后可在设置页一键恢复
- **性能优先**：毫秒级增量路径、视口内渲染、防抖批量落盘、启动不扫描全库

## 数据存储

时间数据保存在 `<库>/.obsidian/plugins/tracetime/records/`，每个 Markdown 文件一条 MessagePack 记录，**不保存笔记正文**（只存块哈希、前后各 32 个标准化字符和时间戳）。

## License

MIT

## Outline lists (Logseq md granularity)

List items are tracked as individual blocks: every `- ` / `* ` / `1.` line
starts its own block, so an outline needs **no blank lines** between items
(upstream merged consecutive list lines into one block until a blank line).
Indented soft lines and indented code/quotes belong to the item above them.

Note for existing installs: records written by 0.1.x used the merged-block
granularity; on first open after upgrading, unchanged items keep their
timestamps via hash reconciliation where possible, otherwise they are re-seeded
from the file's mtime.
