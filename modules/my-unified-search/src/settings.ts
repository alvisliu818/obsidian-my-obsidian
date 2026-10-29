export interface UnifiedSearchSettings {
	/** Everything（文件名搜索，需 Everything 启用其 HTTP 服务器） */
	everything: {
		enabled: boolean;
		/** 形如 http://127.0.0.1:8080 */
		baseUrl: string;
		username: string;
		password: string;
		limit: number;
	};
	/** AnyTXT（全文内容搜索，ATGUI 进程内 JSON-RPC） */
	anytxt: {
		enabled: boolean;
		/** 形如 http://127.0.0.1:9920 */
		url: string;
		/** 目录过滤，如 E: 或 E:\\notes；留空用服务端默认 */
		filterDir: string;
		/** 扩展名过滤，如 *.md 或 doc;pdf；留空 = * */
		filterExt: string;
		limit: number;
		/** 额外取内容片段（每条一次请求，只对前 5 条做，会慢一些） */
		snippet: boolean;
	};
}

export const DEFAULT_SETTINGS: UnifiedSearchSettings = {
	everything: {
		enabled: false,
		// 端口与 Everything 的 HTTP 服务器设置一致（Everything 默认是 80）
		baseUrl: "http://127.0.0.1:80",
		username: "",
		password: "",
		limit: 20,
	},
	anytxt: {
		enabled: false,
		url: "http://127.0.0.1:9920",
		filterDir: "E:",
		filterExt: "",
		limit: 20,
		snippet: false,
	},
};
