/**
 * my Unified Search — 统一搜索（索引守护进程的查询面）。
 *
 * 2026-10-25 重构（用户指定「新索引迁到 unified-search,旧索引去掉」）：
 * 自研 node:sqlite 索引引擎（SqliteService/IndexWriter/全量扫描/ext 域/
 * 附件域）整体退役,统一搜索改为查询 logseq 模块拉起的**索引守护进程**
 * （better-sqlite3 + FTS5 trigram,独立 node 进程,库文件在
 * E:\HOME\Runtime\unified-index\E__HOME_<库>-<hash>.sqlite）。
 *
 * 本模块现在只有三件事:搜索命令、搜索弹窗（查询编译见 matchBuilder）、
 * Everything/AnyTXT 两个外部源（与本地索引无关,原样保留）。
 * daemon-only:守护进程没起来就没有本地结果,不做任何渲染内兜底。
 */
import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, type UnifiedSearchSettings } from "./settings";
import { UnifiedSearchSettingTab } from "./settings-tab";
import { UnifiedSearchModal } from "./modal";
import type { BlockIndexDaemonClient } from "./daemon/daemonClient";

export class UnifiedSearchPlugin extends Plugin {
	settings: UnifiedSearchSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		const raw = (await this.loadData()) as Partial<UnifiedSearchSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...raw };

		this.addSettingTab(new UnifiedSearchSettingTab(this.app, this));
		// id 不能用 "open"：无 manifest.id 覆盖的模块共用宿主命名空间
		// （obsidian-my-obsidian:open 已被 momentum 占用，vault-explorer 的
		// NOTICE.md 有记录）。open-search 避开。
		this.addCommand({
			id: "open-search",
			name: "统一索引搜索",
			callback: () => new UnifiedSearchModal(this).open(),
		});
	}

	/**
	 * 宿主里 logseq 模块拉起的守护进程索引客户端。
	 * 经宿主 live map 拿（模块间运行时访问面,与 e2e 探针同一条路）;
	 * daemon-only:logseq 侧没拉起/启动失败 → null → 无本地结果。
	 */
	get daemon(): BlockIndexDaemonClient | null {
		const host = (
			this.app as unknown as { plugins?: { plugins?: Record<string, { live?: Map<string, unknown> }> } }
		).plugins?.plugins?.["obsidian-my-obsidian"];
		const lg = host?.live?.get("logseq") as { daemonIndex?: BlockIndexDaemonClient | null } | undefined;
		return lg?.daemonIndex ?? null;
	}
}

export default UnifiedSearchPlugin;
export type { UnifiedSearchSettings } from "./settings";
export { DEFAULT_SETTINGS } from "./settings";
