/**
 * Core data types for the Logseq-style block editor.
 * This module must stay dependency-free (no obsidian / CM6 / DOM) — it is
 * unit-tested under plain Node via vitest. Type-only re-exports (import type)
 * from sibling bottom-layer modules are allowed: they erase at compile time.
 */

export type Marker = 'TODO' | 'DOING' | 'DONE' | null;

export const MARKERS: Exclude<Marker, null>[] = ['TODO', 'DOING', 'DONE'];

/** Automatic take-over scope for the block editor. */
export type ScopeMode = 'all' | 'folders';

  /** Per-page default editor, set by the page `editor` property. */
/** Per-page default editor, set by the page `editor` property. */
export type EditorChoice = 'logseq' | 'native';

/** Editor UI for the page-properties first block: Logseq `key:: value` text or Obsidian's native properties editor. */
export type PagePropsEditor = 'logseq' | 'native';

export interface Block {
  /** 'list' = outline bullet block (Logseq style); 'raw' = verbatim top-level content (headings, paragraphs, fences, quotes...) */
  kind: 'list' | 'raw';
  marker: Marker;
  /** GFM 任务状态单字符（' '/'X'/'/'-' 或自定义），undefined = 非任务（批次 23）。 */
  task?: string;
  /**
   * 段落容器标记(运行时字段,不落盘):源文件里没有列表标志(`-`)的顶层文本行。
   *
   * 思源式文档模型里,大纲列表只是文档的一种容器块,段落是另一种:段落不显示
   * 圆点、序列化不带 `- ` 前缀(保存不会把段落改写成列表项)。带任务标记的
   * 裸行(`TODO x`)语义上是任务项,不算段落。
   *
   * 生命周期:parser 的 flushBare 置位;Enter 分裂时继承;depth>0 时序列化回落
   * 带 `- ` 的形式(磁盘上嵌套段必须带标记,否则重解析会并成上一块的软行)。
   */
  bare?: boolean;
  /** Block text without marker/props. May contain '\n' for in-block line breaks (soft wrap). */
  text: string;
  /** Logseq-style properties (`key:: value` child lines). `id` and `collapsed` live here. */
  props: Record<string, string>;
  children: Block[];
  /** Runtime parent pointer (not serialized). */
  parent: Block | null;
  /**
   * Obsidian-format page properties: this props-only first block was created
   * from the file's frontmatter and round-trips as `key: value` lines inside
   * the `---` fences, never as Logseq `key:: value` lines.
   */
  frontmatter?: boolean;
  /**
   * 原文保真(2026-11-25)：该块在源文件中「自己拥有」的行（own line + soft
   * lines + props lines，不含 children），逐字节照抄。解析时由 parser 填充，
   * 序列化时若该块语义未变（srcSig 匹配）就直接吐这些原文行——缩进里的
   * `\t  ` 空格、空列表项的 `-`（无尾空格）等都不被规范化。
   */
  srcLines?: string[];
  /**
   * 原文保真(2026-11-25)：该块**前面**的空行（分隔行，可能含行尾空格），
   * 逐字节照抄。空行不属于任何块，但删掉就是改用户文件——记录在「下一块」
   * 身上，序列化时先吐 gap 再吐块。`undefined` = 运行时新造的块（无原文）；
   * `[]` = 源文件里该块前面没有空行。
   */
  srcGap?: string[];
  /**
   * 解析完成时的语义快照 text/marker/task/bare/props/kind。编辑后语义变了
   * 就与快照不等，该块走正常序列化；未编辑块保持相等 → 用 srcLines 原文。
   */
  srcSig?: string;
}

/** 块的语义签名——用于判断块自解析以来是否被编辑过。 */
export function blockSemanticSig(b: Block): string {
  return JSON.stringify([b.kind, b.marker, b.task ?? null, !!b.bare, b.text, b.props]);
}

/**
 * 整树结构签名（前序：每块语义签名 + 子块数）。
 *
 * 用于「整篇未编辑」判定：序列化时若树与解析时完全一致，直接返回
 * `sourceText` 原文——一个字节都不改。这覆盖了 parser 会归一化的畸形缩进、
 * 空行、围栏等所有边角，是「打开文件不要序列化」的最终保证。
 */
export function documentSemanticSig(blocks: Block[]): string {
  const parts: string[] = [];
  const walk = (nodes: Block[]): void => {
    for (const b of nodes) {
      parts.push(blockSemanticSig(b), String(b.children.length));
      walk(b.children);
    }
  };
  walk(blocks);
  // \u0000 不会出现在 JSON.stringify 的输出里（控制字符会被转义），作分隔安全。
  return parts.join('\u0000');
}

export interface ParsedDocument {
  /** Raw frontmatter including the `---` fences ('' if none). */
  frontmatter: string;
  /** Top-of-file page properties (unindented `key:: value` lines, Logseq style). */
  pageProps: string;
  blocks: Block[];
  /** The source file used CRLF line endings — serialize back with \r\n. */
  crlf?: boolean;
  /** The source file's indentation unit ('  ' for space-indented Logseq
      exports) — serialize back with it; defaults to tab. */
  indentUnit?: string;
  /** The source file ended with a newline — serialize back with one. */
  trailingNewline?: boolean;
  /**
   * 原文保真(2026-11-25)：打开时的原始文本（按 \n 归一，与 parse 用的 lines
   * 同源）。序列化时未编辑的块从这份原文里按行号取回，避免规范化改写；
   * 整篇未编辑时直接返回这份原文（见 documentSemanticSig）。
   */
  sourceText?: string;
  /**
   * 解析完成时的整树结构签名。保存时若与当前树一致（一个块都没动），
   * 序列化直接返回 `sourceText`——打开即保存也是零 diff。
   */
  parseTreeSig?: string;
  /**
   * 原文保真(2026-11-25)：文件末尾（最后一个块之后）的全部空行，逐字节
   * 照抄。`['']` 表示文件以单个换行结尾，`[]` 表示没有结尾换行，
   * `['', '']` 表示多一个空行。序列化时直接拼回，不依赖 trailingNewline
   * 的布尔近似（那个近似会把连续空行折叠成一个）。
   */
  trailingGap?: string[];
}

/**
 * Which groups of Logseq-specific shortcuts the block editor keeps.
 *
 * Every group is independent: turning one off hands exactly those keys back to
 * CM6 / Obsidian and leaves the others alone. `'all'` / `'none'` are accepted
 * as shorthands by the setting UI; they are expanded into the individual
 * boolean groups before being persisted, so the stored shape is always the
 * explicit one.
 *
 * These only ever apply INSIDE the block editor. The native Obsidian editor is
 * never touched — it always uses Obsidian's own shortcuts.
 */
export interface ShortcutOverrides {
  /** Alt+↑/↓ jump between blocks, Mod+Shift+↑/↓ and Alt+Shift+↑/↓ move them. */
  blockNavigation: boolean;
  /** Mod+Enter / Ctrl+Enter cycle the TODO marker. */
  todoCycle: boolean;
  /** Backspace at block start merges with the previous block; Delete merges forward. */
  blockMerge: boolean;
  /** Tab / Shift+Tab indent and outdent a block. */
  indent: boolean;
  /** Enter creates a new sibling block below. */
  newBlock: boolean;
  /** Typing a wrap character with a selection wraps it (*, _, ~, `, [, {, …). */
  selectionWrap: boolean;
  /**
   * Whole-block selection ops: Ctrl+A / X / C / D.
   * Only active when blocks are multi-selected.
   */
  bulkSelection: boolean;
  /** Undo / redo of block operations (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y). */
  undoRedo: boolean;
  /** Mod+L inserts/wraps a markdown link (og :editor/insert-link parity). */
  insertLink: boolean;
}

export const SHORTCUT_GROUP_LABELS: Record<keyof ShortcutOverrides, string> = {
  blockNavigation: '块导航（Alt+↑/↓ 跳转，Mod+Shift+↑/↓ 移动）',
  todoCycle: 'TODO 切换状态（Mod+Enter）',
  blockMerge: '合并块（Backspace / Delete）',
  indent: '缩进（Tab / Shift+Tab）',
  newBlock: '新建块（Enter）',
  selectionWrap: '选区包裹（有选区时输入* _ ~ ` [ {）',
  bulkSelection: '多选块操作（Ctrl+A / X / C / D）',
  undoRedo: '块操作的撤销 / 重做',
  insertLink: '插入链接（Mod+L）',
};

/** Every group defaulting to ON = stock Logseq behavior. */
export const DEFAULT_SHORTCUT_OVERRIDES: ShortcutOverrides = {
  blockNavigation: true,
  todoCycle: true,
  blockMerge: true,
  indent: true,
  newBlock: true,
  selectionWrap: true,
  bulkSelection: true,
  undoRedo: true,
  insertLink: true,
};

/** Merge stored (possibly partial/legacy) data over the defaults. */
export function shortcutOverridesFrom(raw: unknown): ShortcutOverrides {
  const o = (raw ?? {}) as Partial<ShortcutOverrides>;
  const out = { ...DEFAULT_SHORTCUT_OVERRIDES };
  for (const k of Object.keys(out) as (keyof ShortcutOverrides)[]) {
    if (typeof o[k] === 'boolean') out[k] = o[k];
  }
  return out;
}

export interface BlockEditorSettings {
  /** Folders (paths) where .md files keep opening with the native editor. */
  excludedFolders: string;
  /**
   * 索引忽略的黑名单（逐行一条；纯文本 = 名字/路径段整段相等，也接受裸正则
   * 或 `/正则/flags`）。命中即不进块索引/统一搜索（块级反链/标签/卡片/搜索
   * 都看不到它）。库内文件按库内相对路径匹配，库外挂载文件按绝对路径匹配。
   * 2026-11-28 用户需求：取代旧的「索引排除的文件夹」（旧值自动迁移过来）。
   */
  indexIgnoreBlacklist: string[];
  /** 索引忽略的白名单（例外）：命中即照常收录，优先于黑名单。 */
  indexIgnoreWhitelist: string[];
  /** Debounce delay (ms) before writing edits to disk. */
  saveDebounceMs: number;
  /** Python env used to run code ('' = auto-detect). See exec/pythonEnvs.ts. */
  pythonEnvId: string;
  /** Fallback interpreter path when no discovered env fits ('' = unused). */
  pythonEnvCustomPath: string;
  /** Open .md files in the block editor by default (all-intrusive take-over). */
  takeOverByDefault: boolean;
  /** Take-over scope: 'all' = every .md file (minus exclusions); 'folders' = only inside includedFolders. */
  scopeMode: ScopeMode;
  /** Show heading numbers in the block editor (SiYuan editor.headingNumber, batch 24). */
  headingNumberEnabled: boolean;
  /** Heading number format preset id (SiYuan editor.headingNumberFormat). */
  headingNumberFormat: string;
  /** Folders (paths) where the block editor takes over; used when scopeMode = 'folders'. */
  includedFolders: string;
  /** Journal (daily note) folder; '' = vault root or core daily-notes setting. */
  journalFolder: string;
  /** Journal file date format (YYYY-MM-DD style tokens); '' = core daily-notes setting or YYYY-MM-DD. */
  journalFormat: string;
  /** Template text used when creating a new journal file. */
  journalTemplate: string;
  /** User-defined template variables (`name = value` per line). */
  customTemplateVars: string;
  /** Automatic pre-write backups (`.logseq-editor/backups/`). */
  backupsEnabled: boolean;
  /** Operation log trail (`.logseq-editor/log.jsonl`). */
  opLogEnabled: boolean;
  /** Guide-line click: how many child levels get folded (0 = all levels). */
  guideLineCollapseLevels: number;
  /** Guide-line click: how many child levels get unfolded (0 = all levels). */
  guideLineExpandLevels: number;
  /** Editor for the page-properties first block: Logseq text editor or Obsidian's native properties editor. */
  pagePropsEditor: PagePropsEditor;
  /**
   * Per-page linked-reference filters, keyed by page path (Logseq's per-page
   * funnel state). Values are normalized page names; include = AND, exclude =
   * NONE — see `src/features/backlinkFilter.ts`.
   */
  refFilters: Record<string, RefFilter>;
  /** Which groups of Logseq-specific shortcuts the block editor keeps. */
  shortcuts: ShortcutOverrides;
  /**
   * Secondary SQLite index over the vault (markdown stays the source of
   * truth — the database is a rebuildable cache of it).
   *
   * Off by default: the in-memory BlockIndex already serves block refs and
   * backlinks, and the virtual document tree needs no database at all, so the
   * extra write/startup cost buys nothing for the common case. Turn it on for
   * the SQL console / large-vault query work.
   */
  sqliteIndexEnabled: boolean;
  /** Keep a snapshot of the database on disk so restarts do not re-index. */
  sqlitePersist: boolean;
  /** Re-index files when they change on disk (including edits from outside). */
  sqliteAutoSync: boolean;
  /**
   * Directory for the SQLite index file (logseq-index.sqlite). Empty = the
   * built-in default `E:\HOME\Runtime`. Node-fs absolute path — vault.adapter
   * resolves every path against the vault root and cannot reach it.
   */
  sqliteDbDir: string;
  /** R2a 常驻内核：unload 只断连不杀（detached + 空闲自退兜底孤儿）。默认开。 */
  kernelResident: boolean;
  /** R2c 内核托盘：托盘图标 + 右键退出。默认关；开启后空闲自退关闭。 */
  kernelTray: boolean;
  /**
   * Offer the collapse caret on every block whose body spans more than one
   * rendered line — not just list blocks with children. Off = the caret only
   * appears where it always did (list blocks with children).
   */
  foldEnabled: boolean;
  /** [TOC] 标记块渲染为可点击的标题目录（用户 2026-11-20；设置可关）。 */
  tocEnabled: boolean;
  /** 双链提示权重规则（逐行：权重,正则——路径命中正则的候选加该权重,越大越靠前）。 */
  linkWeightPatterns?: string[];
  /**
   * 大纲末尾的「添加块」提示行：鼠标移过去会在子弹圆点那一列浮现一条横线
   * 和一个加号，点击就在可见大纲最后追加一个新块并聚焦——对应 Logseq / 思源
   * 文档底部那一条可以接着往下写的空白行。
   *
   * 默认开启。关掉后这一行整条不再渲染：页面少一行占位（滚动到底就是最后
   * 一块），但「点空白处继续写」的入口随之消失——在最末一块里按 Enter 仍然
   * 照常分裂出新块，所以日常写作不受影响，只是少了那个视觉锚点。
   */
  addBlockAffordance: boolean;
  /**
   * 文末添加块行上的装饰——鼠标悬停时浮现的那条横线和一个加号。默认开启；
   * 关掉后行本身保留（仍可点击在文末追加新块），只是不再画横线和加号，
   * 底部回到一条安静的空白行。仅在 addBlockAffordance 开启时有意义。
   */
  addBlockMarks: boolean;
  /**
   * Block properties that stay in the markdown but are NOT drawn as a
   * `key:: value` row. Hiding is view-only: the property is still written,
   * still parsed back, still queryable, and still editable from the block
   * properties panel. Comma-separated; defaults to the fold flags so folding
   * a block does not litter the view with bookkeeping.
   */
  hiddenProps: string;
  /**
   * Soft-wrap long lines in the external code editor. On by default: config
   * files and comments read better wrapped, and "点开就是换行" is what people
   * expect from a switch labelled 换行.
   *
   * Turn it off for real horizontal scrolling, which deeply indented code
   * prefers. Named for the MODE, and wired so true = wrapping, deliberately: an
   * earlier version named it `externalCodeWrap: true` but did NOT add
   * lineWrapping, so the switch read backwards and the label had to be
   * re-explained in the description.
   *
   * @deprecated 2026-10:唯一入口已迁到编辑器设置(settings.json 的 wordWrap 键,
   * 设置页「代码编辑器 → 自动换行」)。本字段只在启动时读一次做迁移播种
   * (false → wordWrap:'off'),此后不再有运行时读者。
   */
  externalCodeWrap: boolean;
  /**
   * 启动时预建块内代码块的 Monaco 单例(预热)。
   *
   * 块内代码块是全局单例:聚焦时搬进来、提交后搬回池里,不销毁。但**第一次**
   * 搬进来之前实例还不存在,那一下创建(初始化 + 布局 + 字体测量)是插件里最贵
   * 的一步,表现为「第一次点进代码块要顿一下,之后都很快」。开着这一项,Obsidian
   * 布局就绪后就把实例建好放在池里,第一次点进代码块也变成纯搬 DOM。
   *
   * 默认关闭:启动阶段多建一个编辑器是有成本的(内存 + 一次初始化),而只有
   * 常写代码块的人才吃得到那份收益。
   */
  codeBlockPrewarm: boolean;
  /**
   * 底部引用区默认折叠，两个区独立开关。
   * 开 = 打开文件时该区只显示标题栏，点标题栏才展开（并触发查询）；关 = 默认展开。
   * 折叠只是会话内的显示状态，不写进文件。refsDefaultCollapsed 是旧单开关，
   * 迁移后保留作只读回显（不再被 UI 读写）。
   *
   * 为什么要默认值：Unlinked references 的查询是**全库 block 线性扫描**
   * （标题作为子串逐块匹配），主库 8.6k 笔记 / ~150 万 block 实测每次
   * 400ms~9s（稀有标题无早退）= 打开标签页卡死的元凶，故该项默认折叠
   * （不查询）；Linked references 走反链索引 Map 查找，默认展开。
   */
  refsLinkedDefaultCollapsed: boolean;
  refsUnlinkedDefaultCollapsed: boolean;
  /**
   * 底部链接引用区总开关：false = 整块不渲染（Linked / Unlinked references
   * 都不出现在页面底部）。2026-11-26 起默认关闭——底部更干净，需要时可在
   * 设置里开启，或用侧边面板命令「Open the linked/unlinked references panel」。
   */
  pageReferencesEnabled: boolean;
  /** 一次性迁移标记：底部引用区默认值由开改关（2026-11-26）后只强制落一次 false。 */
  pageReferencesDefaultOffMigrated?: boolean;
  /**
   * 布局就绪后后台预热未链接引用的签名索引。
   *
   * 未链接引用靠「按文件分片的 128 位字符签名」剪枝（见 BlockIndex）。分片
   * 是懒建的：第一次展开某个区时才建，主库实测首次约 0.5 秒，之后每次查询
   * 约 10~30ms。开了这一项，插件在 layout-ready 之后把全部分片提前建好，
   * 于是「首次展开」也没有那 0.5 秒。
   *
   * 预热同样按 8ms 分片让出主线程（background ≠ free，连续 0.5 秒的 CPU
   * 一样能被感觉到），所以开着也不影响操作；代价只有那十几 MB 常驻内存和
   * 启动后一小会儿的后台占用。关掉则退回懒建。
   */
  unlinkedScanPrewarm: boolean;
  /** 旧版单开关（1.14.x）：迁移到上面两个独立开关后仅在旧 data.json 兼容读取。 */
  refsDefaultCollapsed: boolean;
  /**
   * 代码文件打开时,注释区用 Logseq 块编辑器呈现(view zone 内嵌在 Monaco
   * 代码流里):可编辑、按 Markdown 渲染、写 [[双链]]。代码块仍由 Monaco 编辑。
   *
   * 默认开启——注释本来就是给人读的笔记,让它能被当成笔记编辑是这个插件的
   * 初衷。单个文件的临时反向覆盖只来自打开入口/布局恢复的 state(设置里的是
   * 默认值;视图头部切换按钮已按用户 2026-10-29 要求移除)。
   * 关掉则回到「整文件一台 Monaco」的纯源码形态。
   */
  externalCodeHybrid: boolean;
  /** LSP（Python 代码文件的 pyright 补全/提示/诊断）开关 */
  lspEnabled: boolean;
  /** 用户自定义语言服务器（语言→启动命令映射）；内置 pyright 不入此表，仅可用同 id 条目覆盖 enabled */
  lspServers: LspServerSpec[];
  /**
   * 块编辑器内的第三方 EditorSuggest 驱动（Various Complements 并入，
   * 2026-11-19）：打字/移动光标时防抖走 editorSuggest.trigger，让 VC 等
   * EditorSuggest 类插件的补全在块编辑器里生效（触发条件/弹层行为全部由
   * 插件自己的设置管）。关掉即恢复「块编辑器不接第三方 suggest」的旧行为。
   */
  thirdPartySuggestsEnabled: boolean;
  /**
   * 虚拟链接（fakelink/Virtual Linker 并入，2026-11-19）：正文里命中其他
   * 笔记的标题/别名/标题头的词动态渲染成链接，不写回 Markdown。渲染态与
   * 编辑态共用词库索引（metadataCache 驱动）；关掉即完全关闭两个装饰面。
   */
  virtualLinksEnabled: boolean;
  /** 虚拟链接是否收录别名（frontmatter aliases） */
  virtualLinksIncludeAliases: boolean;
  /** 虚拟链接是否收录标题头（可跳到对应标题锚） */
  virtualLinksIncludeHeaders: boolean;
  /** 全局排除词（换行/逗号分隔，大小写不敏） */
  virtualLinksExcludedKeywords: string;
  /** 排除目录前缀（换行分隔，按库内路径匹配） */
  virtualLinksExcludedDirectories: string;
  /** 允许「词界起」的前缀匹配（默认仅整词；CJK 恒子串不受此限） */
  virtualLinksMatchBeginningOfWords: boolean;
  /** 允许「词界尾」的后缀匹配 */
  virtualLinksMatchEndOfWords: boolean;
  /** 允许任意中段子串匹配（误报最多，默认关） */
  virtualLinksMatchAnyPartsOfWords: boolean;
  /**
   * VC 式词补全（Various Complements 原生吸收，2026-11-19）：随打随补，
   * 候选来自当前页面词频 / 全库标题别名（复用虚拟链接索引）/ 自定义词典 /
   * emoji shortcode（`:` 前缀）。走 CM6 autocompletion 管线。
   */
  wordCompleteEnabled: boolean;
  /** 触发前缀最短长度（VC minNumberOfCharactersTriggered，最小 2） */
  wordCompleteMinChars: number;
  /** 候选上限（VC maxNumberOfSuggestions） */
  wordCompleteMaxSuggestions: number;
  /** 自定义词典文件（库内相对路径，每行一词，可 `词<TAB>说明`） */
  wordCompleteDictionaryPath: string;
  /**
   * 扩展市场代码配色主题偏好：'' = 自动（优先已装扩展主题，明暗匹配）；
   * '__none__' = 不用扩展主题（内置 Obsidian 配色）；其他 = Monaco 主题名。
   */
  codeThemePref: string;
  /**
   * 扩展市场文件图标主题偏好：'' = 自动（第一个已装主题）；
   * '__none__' = 不使用扩展图标主题；其他 = 扩展 id。
   */
  iconThemePref: string;
  /**
   * 文件顶部的提示栏（文件名 / 库内库外标记 / 路径 / 同步状态 / 保存按钮）。
   * 2026-11-26 起默认关闭：占竖向空间，保存照常走自动保存节奏，移动端工具栏
   * 与桌面 Ctrl+S / ⋮ 菜单仍可手动保存。想看提示栏可在设置里手动开启。
   */
  externalBanner: boolean;
  /** 一次性迁移标记：提示栏默认值由开改关（2026-11-26）后只强制落一次 false。 */
  externalBannerDefaultOffMigrated?: boolean;
  /**
   * 文件打开时默认进入只读模式（2026-11-26）：块编辑器与代码编辑器共用。
   * 开启后打开的文件锁定、不能输入，需点工具栏「只读」按钮解锁；工具栏只在
   * 移动端显示，桌面端另有命令「切换只读/编辑」与 ⋮ 菜单项解锁。
   * 只作为新视图的初值，切换只读是视图会话状态，不写进设置/视图状态。
   */
  defaultReadOnly: boolean;
  /** Recently opened file paths, newest first (bounded by RECENT_LIMIT). */
  recentFiles: string[];
  /** Vault-wide content search panel options. */
  contentSearch: ContentSearchOptions;
}

/** LSP 语言服务器配置：语言 → 启动命令映射（多语言通用化） */
// LspServerSpec 已随 LSP 域迁往 code-editor（2026-10-27 Step B）。
// import type 在转译时擦除——本模块的"零运行时依赖、Node 直测"性质不变。
import type { LspServerSpec } from '../../code-editor/src/types';
export type { LspServerSpec };

/** Options for the vault-wide content search panel. */
export interface ContentSearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Folder prefix filter; '' = whole vault. */
  folder: string;
  /** Comma-separated extension list, dot optional; '' = defaults. */
  extensions: string;
  /** Files larger than this (KB) are skipped. */
  maxFileKB: number;
  /**
   * 库外挂载文件的内容倒排索引（ext_fts，2026-11-19 round2）：默认开（搜索
   * 毫秒级）。关掉 = 不再建 ext 倒排索引并清空现有条目（实测省 ~300MB 盘
   * 上空间——代码文本 trigram 放大 ~9×），内容搜索回落为按需读盘扫描
   * （~30MB 文本 ≈ 百 ms 级/次）。
   */
  extFtsEnabled: boolean;
}

export const DEFAULT_CONTENT_SEARCH: ContentSearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  folder: '',
  extensions: 'md, txt, markdown',
  maxFileKB: 1024,
  extFtsEnabled: true,
};

/** Merge stored (possibly partial) search options over the defaults. */
export function contentSearchFrom(raw: unknown): ContentSearchOptions {
  const o = (raw ?? {}) as Partial<ContentSearchOptions>;
  const kb = Number(o.maxFileKB);
  return {
    caseSensitive: o.caseSensitive === true,
    wholeWord: o.wholeWord === true,
    regex: o.regex === true,
    folder: typeof o.folder === 'string' ? o.folder : '',
    extensions: typeof o.extensions === 'string' ? o.extensions : DEFAULT_CONTENT_SEARCH.extensions,
    maxFileKB: Number.isFinite(kb) && kb >= 1 ? Math.min(kb, 10240) : DEFAULT_CONTENT_SEARCH.maxFileKB,
    extFtsEnabled: o.extFtsEnabled !== false,
  };
}

/** A page's linked-reference filter: values to require / to hide. */
export interface RefFilter {
  includes: string[];
  excludes: string[];
}

export const DEFAULT_SETTINGS: BlockEditorSettings = {
  excludedFolders: '',
  indexIgnoreBlacklist: [],
  indexIgnoreWhitelist: [],
  saveDebounceMs: 800,
  pythonEnvId: '',
  pythonEnvCustomPath: '',
  takeOverByDefault: true,
  scopeMode: 'all',
  headingNumberEnabled: false,
  headingNumberFormat: 'decimal-hierarchical',
  includedFolders: '',
  journalFolder: '',
  journalFormat: '',
  journalTemplate: '',
  customTemplateVars: '',
  backupsEnabled: true,
  opLogEnabled: true,
  guideLineCollapseLevels: 0,
  guideLineExpandLevels: 0,
  pagePropsEditor: 'logseq',
  refFilters: {},
  shortcuts: { ...DEFAULT_SHORTCUT_OVERRIDES },
  sqliteIndexEnabled: false,
  sqlitePersist: true,
  sqliteAutoSync: true,
  sqliteDbDir: '',
  kernelResident: true,
  kernelTray: false,
  foldEnabled: true,
  tocEnabled: true,
  addBlockAffordance: true,
  addBlockMarks: true,
  hiddenProps: 'collapsed',
  externalCodeWrap: true,
  codeBlockPrewarm: false,
  refsLinkedDefaultCollapsed: false,
  // Unlinked references 是全库线性扫描，大库上每次开页几百 ms~数秒，默认折叠
  // （打开时不跑查询，点标题栏展开才跑）。需要默认展开的在设置里关掉本项。
  refsUnlinkedDefaultCollapsed: true,
  pageReferencesEnabled: false,
  refsDefaultCollapsed: false,
  // 预热的成本是按 8ms 分片让出主线程的后台 CPU，用户几乎无感，换来首次
  // 展开 Unlinked references 也是 ~10ms。不想常驻那点内存的可关掉。
  unlinkedScanPrewarm: true,
  // 代码文件默认纯 Monaco 编辑器(用户 2026-10-18 决策);混合模式(注释区 =
  // Logseq 块编辑器)保留为设置可选,不再作为默认(头部按钮已移除)。
  externalCodeHybrid: false,
  lspEnabled: true,
  lspServers: [],
  thirdPartySuggestsEnabled: true,
  virtualLinksEnabled: true,
  virtualLinksIncludeAliases: true,
  virtualLinksIncludeHeaders: true,
  virtualLinksExcludedKeywords: '',
  virtualLinksExcludedDirectories: '',
  virtualLinksMatchBeginningOfWords: false,
  virtualLinksMatchEndOfWords: false,
  virtualLinksMatchAnyPartsOfWords: false,
  wordCompleteEnabled: true,
  wordCompleteMinChars: 2,
  wordCompleteMaxSuggestions: 8,
  wordCompleteDictionaryPath: '',
  codeThemePref: '',
  iconThemePref: '',
  externalBanner: false,
  defaultReadOnly: true,
  recentFiles: [],
  contentSearch: { ...DEFAULT_CONTENT_SEARCH },
};

export function createBlock(text = '', marker: Marker = null): Block {
  return { kind: 'list', marker, text, props: {}, children: [], parent: null };
}

/** 记录一行原文到块的 srcLines（原文保真用）。 */
export function addSrcLine(b: Block, line: string): void {
  (b.srcLines ??= []).push(line);
}

/** Stable block id (Logseq `id::` property). Empty string when unassigned. */
export function blockId(b: Block): string {
  return b.props['id'] ?? '';
}

export function isCollapsed(b: Block): boolean {
  return b.props['collapsed'] === 'true';
}

export function setCollapsed(b: Block, v: boolean): void {
  if (v) b.props['collapsed'] = 'true';
  else delete b.props['collapsed'];
}

/** Plain-text summary of a block (first line, markers stripped) — for breadcrumbs / previews. */
export function blockSummary(b: Block): string {
  const first = b.text.split('\n')[0] ?? '';
  const s = first.trim();
  return s.length > 42 ? s.slice(0, 42) + '…' : s;
}

/** Generate a random id (uuid v4 via WebCrypto, available in Obsidian & Node >= 19). */
export function genId(): string {
  return globalThis.crypto.randomUUID();
}

/** Parse a comma-separated folder list into normalized vault-relative paths. */
export function parseFolderList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
}

/** True when `file` is the folder itself or lies somewhere under it. */
export function pathInFolders(file: string, folders: string[]): boolean {
  return folders.some((f) => file === f || file.startsWith(f + '/'));
}

/**
 * Decide whether a markdown file should automatically open in the block editor.
 * - take-over off: never.
 * - scope 'all': everywhere except excludedFolders.
 * - scope 'folders': only inside includedFolders (exclusions are not consulted).
 */
export function shouldTakeOver(
  takeOverByDefault: boolean,
  scopeMode: ScopeMode,
  includedFolders: string,
  excludedFolders: string,
  file: string,
): boolean {
  if (!takeOverByDefault) return false;
  if (scopeMode === 'folders') {
    return pathInFolders(file, parseFolderList(includedFolders));
  }
  return !pathInFolders(file, parseFolderList(excludedFolders));
}

/** Normalize one raw property value to an editor choice (unknown → null). */
function editorChoiceValue(raw: unknown): EditorChoice | null {
  const v = String(raw).trim().toLowerCase();
  if (v === 'logseq') return 'logseq';
  if (v === 'native') return 'native';
  return null;
}

/**
 * The per-page default-editor property: `editor:: logseq|native` (Logseq
 * page properties) or `editor: logseq|native` (frontmatter). Key and value
 * match case-insensitively; any other value (or a missing property) means
 * "no override". Non-string values (Obsidian parses frontmatter numbers /
 * booleans natively) are stringified first.
 */
export function editorChoiceFromProps(props: Record<string, unknown> | undefined | null): EditorChoice | null {
  if (!props) return null;
  let raw: unknown;
  for (const [k, v] of Object.entries(props)) {
    if (k.toLowerCase() === 'editor') {
      raw = v;
      break;
    }
  }
  if (raw === undefined || raw === null) return null;
  return editorChoiceValue(raw);
}

/**
 * Take-over decision with the per-page `editor` property applied. The
 * property is the most specific signal and overrides the settings in both
 * directions (logseq forces the block editor even with take-over off;
 * native keeps the native editor even inside included folders); without it
 * the settings decide exactly as before.
 */
export function takeOverForFile(
  choice: EditorChoice | null,
  takeOverByDefault: boolean,
  scopeMode: ScopeMode,
  includedFolders: string,
  excludedFolders: string,
  file: string,
): boolean {
  if (choice === 'logseq') return true;
  if (choice === 'native') return false;
  return shouldTakeOver(takeOverByDefault, scopeMode, includedFolders, excludedFolders, file);
}

/** True when `b` is the props-only page-properties first block (Logseq model). */
export function isPagePropsBlock(b: Block | undefined | null): boolean {
  return !!b && b.kind === 'list' && b.text === '' && !b.frontmatter;
}

/** The Logseq-format page-props record of a parsed document ({} when none). */
export function docPageProps(doc: ParsedDocument): Record<string, string> {
  return isPagePropsBlock(doc.blocks[0]) ? doc.blocks[0].props : {};
}

/** Assign an id to a block if it does not have one. Returns the id. */
export function ensureId(b: Block): string {
  if (!blockId(b)) b.props['id'] = genId();
  return blockId(b);
}

// ---------------------------------------------------------------------------
// Block properties as text (Logseq md parity)
// ---------------------------------------------------------------------------

/** One `key:: value` line — the block-property syntax (matches the parser). */
export const BLOCK_PROP_LINE_RE = /^([A-Za-z][A-Za-z0-9_-]*)::[ \t]*(.*)$/;

/** Props managed by their own UI; never shown or edited as `key:: value`. */
export const STRUCTURAL_PROPS = new Set(['id', 'collapsed', 'style']);

/**
 * Split the TRAILING run of `key:: value` lines off a block body. Only the
 * last consecutive run counts (properties come after content in Logseq); a
 * prop-shaped line in the middle of the text stays text.
 */
export function splitPropLines(text: string): { text: string; props: Record<string, string> } {
  const lines = text.split('\n');
  const props: Record<string, string> = {};
  let end = lines.length;
  while (end > 0) {
    const m = BLOCK_PROP_LINE_RE.exec(lines[end - 1]);
    if (!m) break;
    props[m[1]] = m[2];
    end--;
  }
  if (end === lines.length) return { text, props: {} };
  return { text: lines.slice(0, end).join('\n'), props };
}

/**
 * Sync a frontmatter-sourced props block's props map from its body lines
 * (simple top-level `key: value` entries; YAML lists/comments stay verbatim
 * in the text and are not represented in the map).
 */
export function syncFrontmatterProps(b: Block): void {
  const props: Record<string, string> = {};
  for (const line of b.text.split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (m) props[m[1]] = m[2].replace(/^ /, '');
  }
  b.props = props;
}

/** Replace a block's text-editable props, keeping the structural ones. */
export function applyBlockProps(b: Block, props: Record<string, string>): void {
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.props)) {
    if (STRUCTURAL_PROPS.has(k)) kept[k] = v;
  }
  b.props = { ...kept, ...props };
}

/** The text-editable props of a block (structural ones excluded). */
export function editableProps(b: Block): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.props)) {
    if (!STRUCTURAL_PROPS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * 编辑文档 → {text, props}（提交口径统一入口，2026-10-26 属性块 Enter 链）。
 *
 * 属性块形态（text 空的列表块，编辑文档 = `- key:: v` + 后续属性行）必须
 * **先剥行首符号再切尾随属性段**：`- editor:: x` 带符号的首行会被
 * splitPropLines 的尾随判定拒收，属性掉进 text——预提交/焦点切换再提交/
 * 保存期覆盖三条路径都会中招（实测：props 键序翻转后重挂文档，再提交时
 * status 掉回 text）。先剥符号后，无论 props 键序如何，整条提交链幂等。
 * 普通块维持原序：先切尾随属性段，再对正文剥符号。
 */
export function splitEditorDocForCommit(b: Block, live: string): { text: string; props: Record<string, string> } {
  const propsShaped = b.kind === 'list' && b.text === '';
  if (!propsShaped) {
    const { text, props } = splitPropLines(live);
    const marked = applyEditorMarker(b, text, 0);
    return { text: marked.text, props };
  }
  const marked = applyEditorMarker(b, live, 0);
  const { text, props } = splitPropLines(marked.text);
  return { text, props };
}

export function propsShallowEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/**
 * 编辑器文档:其文本 + 每个可编辑 prop 一行 `key:: value`(Logseq 惯例)。
 *
 * 列表块的行首符号(`- `,任务标记跟在后面)作为**可编辑文本**进文档
 * (用户指定,2026-10-25):圆点即符号的渲染形态,编辑态删掉符号 = 变段落,
 * 段落行首敲出符号 = 变列表;符号写错(`*`/`+`/`1.`)提交时规范化回 `- `。
 */
export const EDITOR_BULLET_RE = /^([-*+]|\d{1,9}[.)])\s+/;
export const EDITOR_TASK_RE = /^(TODO|DOING|DONE)\s+/;

/** 编辑文档里符号段的长度(`- ` + 任务标记),供光标坐标换算。 */
export function editorMarkerLen(b: Block): number {
  if (b.kind !== 'list' || b.bare || b.frontmatter) return 0;
  return 2 + (b.marker ? b.marker.length + 1 : 0);
}

/**
 * 符号即文本(2026-10-25):把编辑文档行首的符号解析进模型——列表块删了
 * 符号 → 退成段落(bare);符号还在 → 规范化回 `- `(写 `*`/`+`/`1.` 也收),
 * 任务标记照旧解析;段落行首出现符号 → 变列表。返回剥掉符号后的正文与
 * 同步偏移(光标坐标换算)。commit 与 keymap 的 Enter/Backspace/Delete
 * 路径共用——所有「编辑文档 → 模型」的写入都必须过这里,否则 `- ` 会漏
 * 进 text(静态多出一个 `-`)。
 */
export function applyEditorMarker(b: Block, text: string, offset: number): { text: string; offset: number } {
  if (b.kind !== 'list' || b.frontmatter) return { text, offset };
  const m = EDITOR_BULLET_RE.exec(text);
  if (m) {
    const afterBullet = text.slice(m[0].length);
    const tm = EDITOR_TASK_RE.exec(afterBullet);
    b.bare = false;
    b.marker = tm ? (tm[1] as Block['marker']) : null;
    const strip = m[0].length + (tm ? tm[0].length : 0);
    const body = afterBullet.slice(tm ? tm[0].length : 0);
    return { text: body, offset: Math.min(Math.max(offset - strip, 0), body.length) };
  }
  if (!b.bare) {
    b.bare = true;
    b.marker = null;
  }
  return { text, offset };
}

export function blockEditorDoc(b: Block): string {
  // Obsidian-format page properties: the editor shows the frontmatter body
  // verbatim (`key: value` lines), never converted to Logseq `key:: value`.
  if (b.frontmatter) return b.text;
  const head = b.kind === 'list' && !b.bare ? `- ${b.marker ? b.marker + ' ' : ''}` : '';
  const entries = Object.entries(b.props).filter(([k]) => !STRUCTURAL_PROPS.has(k));
  if (entries.length === 0) return head + b.text;
  const propLines = entries.map(([k, v]) => `${k}:: ${v}`.trimEnd());
  return head + (b.text ? `${b.text}\n${propLines.join('\n')}` : propLines.join('\n'));
}
