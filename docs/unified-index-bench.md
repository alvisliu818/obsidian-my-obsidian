# 统一索引 · 大库查询基准（M2-5）

实测环境：真库 `E:/HOME/Runtime/unified-index/E__HOME_BaiduSyncdisk-9d1843.db`（只读），
node 26 + node:sqlite，`_diag-us-bench.mjs`（5 轮取 median，预热 1 轮）。

## 基线（2026-10-23，指纹 usc1|chs=0，整块降级分词）

| 指标 | 值 |
| --- | --- |
| 库大小 | 3.4 GB（page 4096B，freelist 0） |
| files / items / links | 74,997 / 74,997 / 82,687（resolved 63,738） |
| schema / ANALYZE | v2 / sqlite_stat1 存在 |

| 查询 | median | 命中 |
| --- | --- | --- |
| MATCH 拉丁词（高频词） | 223 ms | 50+ |
| 前缀展开（title/tags） | 30 ms | 50 |
| LIKE 兜底 2 字中文（全表扫） | **5,796 ms** | 2 |
| backlink EXISTS 过滤 | 958 ms | — |

- MATCH 中文 2/4 字 **0 命中**：整块降级分词下 CJK 长块是单 token，2 字子串查不中 →
  每次中文搜索都跌进 LIKE 兜底 → **5.8s 主线程冻结，不可用**。
- 探针确认：2 字窗口 token 仅存在于恰好 2 字的独立词块（与整块 token 重合），
  指纹 `chs=0`（cm-chs-patch 已安装但**未启用**，community-plugins.json 无此项）。

## 结论与修复（85e8960c 之后）

1. **根因**：降级分词「CJK 整块保留」在大库上等于没有中文检索。LIKE 兜底
   5.8s 是全表扫，触发阈值救不了。
2. **修复**：tokenize 内置 **bigram 降级**（无 segmenter 时 2 字滑窗步长 1 +
   整词，全偏移覆盖），指纹 `usc1 → usc2`，旧库下次启动自动重建。
   ≥2 字中文查询全部走 FTS（窗口短语/OR），LIKE 兜底收窄到 ≤2 字（单字
   FTI 不产 token 必漏；2 字兜底仅补索引未入库场景）。
3. **扫描期关兜底**：`plugin.isWriteSession`（首建扫描/flush 进行中）时搜索
   传 `likeThreshold: 0`——部分索引必然落空，兜底只会白扫。
4. 拉丁高频词 223ms 来自 bm25 全命中排序（临时 b-tree），可接受；
   backlink EXISTS 958ms（SCAN items + SEARCH idx_links_src）列为后续优化项。

## 复测

Obsidian 重启完成 usc2 重建后重跑：

```
node _diag-us-bench.mjs
```

预期：MATCH 中文 ≥2 字从 0 命中/5.8s LIKE 变为 ms 级 FTS 命中；库体积因
bigram token（CJK token 量 ≈ 字数）显著增长。
