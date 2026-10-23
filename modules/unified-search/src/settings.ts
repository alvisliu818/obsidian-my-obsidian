export interface UnifiedSearchSettings {
	/** 索引库存放目录（per-vault 库文件名由 index-core 的 vaultSlug 保证） */
	sqliteDbDir: string;
	/** 拆分 camelCase（索引与查询共用；变更触发指纹重建） */
	splitCamel: boolean;
	/** 收录库外挂载文件（logseq 模块的挂载清单；>1MB 只索引头部，仅全量扫描时刷新） */
	indexExt: boolean;
	/** ext 域周期刷新间隔（分钟，0=关）。stat 门下未变文件免读，开销是清单 stat 一轮。
	 *  默认放宽到 30 分钟：挂载清单动辄上万文件，5 分钟一轮会持续吃磁盘（2026-10-23） */
	extRefreshMinutes: number;
	/** 单轮收录上限：库外挂载文件（最近修改优先；0=不限） */
	maxExtFiles: number;
	/** 收录上限：vault 内可索引文件（md/org，最近修改优先；0=不限）。
	 *  保护性闸门——正常库远达不到，防的是清单异常膨胀把库撑爆 */
	maxVaultFiles: number;
	/** 收录上限：vault 内附件占位行（最近修改优先；0=不限）。
	 *  附件只落元数据行供 embed 解析，超限的老附件会被裁掉（链接退回悬空） */
	maxAttachments: number;
}

export const DEFAULT_SETTINGS: UnifiedSearchSettings = {
	// 统一索引专用子目录：不与 Runtime 根下其他模块的文件混放
	// （SqliteService.ensureOpen 会 recursive mkdir，目录不存在自动建）
	sqliteDbDir: "E:\\HOME\\Runtime\\unified-index",
	splitCamel: false,
	indexExt: true,
	extRefreshMinutes: 30,
	maxExtFiles: 5000,
	maxVaultFiles: 20000,
	maxAttachments: 5000,
};
