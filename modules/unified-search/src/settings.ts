export interface UnifiedSearchSettings {
	/** 索引库存放目录（per-vault 库文件名由 index-core 的 vaultSlug 保证） */
	sqliteDbDir: string;
	/** 拆分 camelCase（索引与查询共用；变更触发指纹重建） */
	splitCamel: boolean;
	/** 收录库外挂载文件（logseq 模块的挂载清单；>1MB 只索引头部，仅全量扫描时刷新） */
	indexExt: boolean;
}

export const DEFAULT_SETTINGS: UnifiedSearchSettings = {
	// 统一索引专用子目录：不与 Runtime 根下其他模块的文件混放
	// （SqliteService.ensureOpen 会 recursive mkdir，目录不存在自动建）
	sqliteDbDir: "E:\\HOME\\Runtime\\unified-index",
	splitCamel: false,
	indexExt: true,
};
