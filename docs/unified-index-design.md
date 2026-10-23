# 统一索引本体设计（M1）

> 2026-10-23 定稿。来源：白屏落盘二期（worktree 既有 eb1fad8c/62a9a1f5 之后），
> 经思源 kernel（E:\HOME\Code\siyuan\siyuan）与 logseq og master（DB 版 schema + search.cljs）
> 双参照挖掘 + 四轮设计评审收敛。23 条设计决策全部有依据，见文末清单。
>
> **2026-10-23 修订**：消费层从「omnisearch 挂 sqlite 后端」改为**自研 unified-search
> 模块**（omnisearch 模块原样保留、不再动它）。随之固化的实现决策：
> FTS 同步改 items 触发器自动维护（官方 external-content 触发器模式，应用层禁写
> items_fts）；「MATCH 双跑」取消——查询编译器全权转译，用户输入永不直通 MATCH，
> 注入安全由 fast-check 真库执行属性测试兜底；PRAGMA 增补 busy_timeout=3000。

## 0. 一句话

**node:sqlite（Electron 内置 SQLite 3.53.4，FTS5）+ 万物皆 item 模型 + FTS5 external-content
+ 全域 links 双链 + hash 门增量**。JS 堆常驻 0，磁盘 ~300MB，单文件原子事务。

## 1. 实测选型依据（renderer 内探针，_diag-sqlite-probe.mjs）

- Obsidian 1.14.4 = Electron 43.7.7 / Node 24.21.0，`require('node:sqlite')` 直接可用
- SQLite 3.53.4，编译选项含 ENABLE_FTS5；任意路径磁盘库读写重开删全通
- FTS5 unicode61 不切 CJK（2 字子串 0 命中）；trigram 需 ≥3 字 → 分词留应用侧
- 落选：better-sqlite3（ABI 风险）、wa-sqlite/官方 wasm（桌面无磁盘 VFS，三期工程量，
  WASM 税永久）——wa-sqlite 留给未来移动端后端（OPFS VFS 现成、磁盘-backed 非全内存）

## 2. 数据模型

```
file（账本） ──> item（可检索单元）──link──> item（全域双链）
vault logseq/org 文件 → 每块一个 item（block_id/层级）
vault 普通 md / ext 文件 → 整文件一个 item（block_id 空、层级平）
```

## 3. Schema

```sql
CREATE TABLE files (
  rowid INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,      -- vault 相对 / ext: 绝对
  domain TEXT NOT NULL,           -- 'vault' | 'ext'
  mtime INTEGER, size INTEGER, ext TEXT, title TEXT
);

CREATE TABLE items (
  rowid INTEGER PRIMARY KEY,
  file_rowid INTEGER NOT NULL REFERENCES files(rowid) ON DELETE CASCADE,
  block_id TEXT UNIQUE,           -- logseq ^id；文件级 item 为 NULL
  parent_rowid INTEGER, ord INTEGER,
  content TEXT NOT NULL,          -- 原文
  t_title TEXT, t_headings TEXT, t_tags TEXT, t_content TEXT, -- 分词后文本 = FTS 数据源
  format TEXT NOT NULL,           -- 'md' | 'org'
  content_hash TEXT,              -- item 级变更门（思源 blocks.hash 同款）
  mtime INTEGER                   -- 检索 recency boost 输入
);

-- external-content：FTS 列必须与 items 分词列同名同内容（探针抓过的 bug，勿回退）
CREATE VIRTUAL TABLE items_fts USING fts5(
  t_title, t_headings, t_tags, t_content,
  content='items', content_rowid='rowid',
  tokenize='unicode61', prefix='2,3', detail=full
);

CREATE TABLE links (
  rowid INTEGER PRIMARY KEY,
  src_item INTEGER NOT NULL REFERENCES items(rowid) ON DELETE CASCADE,
  raw TEXT NOT NULL,
  target_path TEXT, target_item INTEGER,
  target_root INTEGER,            -- root 级冗余（思源 refs 表同款，块级聚合免 JOIN）
  anchor TEXT, kind TEXT NOT NULL, -- wiki/md/embed/blockref
  resolved INTEGER NOT NULL
);
CREATE INDEX idx_links_target ON links(target_item);
CREATE INDEX idx_links_tpath ON links(target_path);

-- 名字解析：basename(lower) → item；original 留原文（logseq DB 版双列同款）
CREATE TABLE names (
  name TEXT NOT NULL, original TEXT NOT NULL,
  item_rowid INTEGER NOT NULL, precedence INTEGER NOT NULL  -- vault 0 > ext 1
);
CREATE INDEX idx_names ON names(name, precedence);

-- 同步元数据：mtime 抖动不可靠（同步盘），hash 是真值
CREATE TABLE sync_state (
  path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, indexed_at INTEGER
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- schema_version/配置指纹/健康指标
```

## 4. 同步语义

1. 权威 = 磁盘文件；库是可重建投影。`foreign_keys=ON`（默认关！漏了级联全失效）
2. 增量单位 = 一个文件 = 一个同步事务（删旧 items+links → 插新）；FTS 由 items 的
   AFTER INSERT/DELETE/UPDATE 触发器同事务自动维护，应用层一律不写 items_fts
3. 变更门 = size → mtime → content_hash（FNV-1a 32bit+len，不引依赖）
4. 改名/新增回查 idx_links_tpath 补解析悬空链接；删除留 raw 等 re-resolve
5. 配置指纹（分词器可用性/大小写等）：小差异走迁移（logseq retract-attributes 同款），
   大差异全量重建（思源规则）
6. 坏库即删重建（logseq 容错纪律，#7467 先例）：open/prepare 失败 → unlink → 重建
7. **不做备份**（可重建投影，备份是负资产）

## 5. 查询

- 查询编译器全权转译：解析（短语/排除/title:/tag:/path:/ext:/前缀*）→ 分词 →
  引号短语写回（内部引号转义 ""）。用户输入永不直通 MATCH，无双跑
- 前缀 `tok*` 仅 title/tags 列展开（content 前缀噪音大）
- bm25 列权重：title 6.0 > tags 5.0 > headings 4.0 > content 1.0；recency 查询后 JS 组合
- **LIKE 限域兜底**：MATCH 命中不足且有中文兜底触发词（≤2 字，或降级模式任意中文）时，
  对 items.content `LIKE` 全部正向原文 AND `NOT LIKE` 全部排除原文——兜底结果必须
  满足完整查询语义（探针实证 unicode61 中文 2 字子串必漏；logseq DB 版同款策略）
- 高亮：索引只回命中 token 列表，JS 侧对原文定位
- API 纪律：**列表/命中查询禁取 content 列**（单行可达 1MB），content 按 rowid 单查

## 6. PRAGMA 清单

```sql
PRAGMA foreign_keys=ON;        -- 级联生效前提
PRAGMA journal_mode=WAL;       -- 首建期临时切 MEMORY+OFF，完成后切回（快 2-5×）
PRAGMA synchronous=NORMAL;     -- 首建期 OFF
PRAGMA mmap_size=268435456;    -- 读走 OS 页缓存，进程内存更省
PRAGMA cache_size=-8000;       -- 8MB 页缓存上限
PRAGMA temp_store=MEMORY;
PRAGMA auto_vacuum=INCREMENTAL; -- 高频删插防碎片
-- 首建完成 ANALYZE；prepared statements 连接级缓存（logseq 每次 re-prepare 是反例）
```

## 7. 布局与文件名

- 库文件：`<sqliteDbDir>/<vault-slug>.db`（vault 路径 sanitize，多库互不踩）
- DB **懒打开**（首次索引/搜索操作才 open，避开启动内存峰——白屏高危窗口让路）
- 健康指标进 meta（item/links 数、上次全建/增量时间、指纹）；`fts5vocab` 白嫖索引自检

## 8. 测试与验收

- vitest node 环境（本机 node 22.14 / SQLite 3.47.2；renderer 3.53.4，均 ≥3.45 全特性可用）
- fast-check 属性测试：任意串 → 编译器不抛 + **MATCH 在真库上必可执行**（注入安全，
  200 runs）；tokenizer/parser 纯函数单测
- 集成 golden：灌库 → 检索断言（中英整词/短语有序/排除/过滤/LIKE 兜底/hash 门/删除）
- 分词缺失降级（cm-chs-patch 缺席 → 原文整块）保持可查（整词 + LIKE 兜底）；
  分词器可用性纳入指纹

## 9. 边界与明确不做

- bigram 冗余列 / path-refs 物化闭包（logseq path-refs）——JOIN 成热点再说
- 多线程并行写（单连接单写者）；备份；routine quick_check（O(db) 太慢，靠坏库重建兜底）
- 移动端：repository 接口预留 WasmSqliteBackend 位（wa-sqlite/官方 wasm + OPFS），本次不实现
- logseq BlockIndex 仍内存权威（M2 再议 SQL 权威化）；unified-search 与 logseq 索引不合体
  （块图 vs 文档倒排、权威 vs 可重建、常驻 vs 磁盘——四维不同），只共享 SqliteService；
  omnisearch 模块原样保留（minisearch 路径），不挂 sqlite 后端也不删除

## 10. 设计决策全录（四轮评审 23 条）

存储参数 6（foreign_keys/WAL/mmap/cache/auto_vacuum/ANALYZE，修订增补 busy_timeout）；
查询 4（编译器全权转译取代双跑/前缀限定列/bm25 权重/LIKE 兜底完整语义）；构建 3
（疾速首建/FNV hash/prepared 缓存）；API 纪律 2（per-vault 文件名/列表禁取 content）；
同步 4（单文件原子事务/hash 门/悬空补解析/指纹双轨）；运维 3（懒打开/健康指标/
fts5vocab）；验收 1（fast-check 真库执行取代 oracle diff）；容错 1（坏库即删）。
参采思源：hash 门/refs 冗余/指纹重建/readonly；logseq：LIKE 兜底/坏库即删/
独立派生库/original 双列/retract 迁移；共同印证：items 统一模型（思源 blocks、logseq
"page is a special block"）。
