export interface UnifiedSearchSettings {
	/** 索引库存放目录（per-vault 库文件名由 index-core 的 vaultSlug 保证） */
	sqliteDbDir: string;
	/** 拆分 camelCase（索引与查询共用；变更触发指纹重建） */
	splitCamel: boolean;
}

export const DEFAULT_SETTINGS: UnifiedSearchSettings = {
	sqliteDbDir: "E:\\HOME\\Runtime",
	splitCamel: false,
};
