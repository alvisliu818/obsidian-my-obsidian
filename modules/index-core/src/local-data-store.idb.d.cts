/**
 * local-data-store.idb.cjs 的类型面：上游 @mnaoumov/obsidian-lib 的
 * local-data-store.ts 编译产物（IDB 实现，原样保留的本地拷贝）。这里只声明
 * plugin-kv-shim 用到的接口（与 vendor 的 LocalDataStore 同签名）。
 */
export declare class LocalDataStore {
	private constructor();
	static open(params: {
		factory?: unknown;
		pluginId: string;
		storeId: string;
		vaultId: string;
	}): Promise<LocalDataStore>;
	get(key: string): Promise<unknown>;
	entries(): Promise<Array<[string, unknown]>>;
	commit(params: {
		entries: Array<readonly [string, unknown]>;
		removedKeys?: string[];
		shouldClear?: boolean;
	}): Promise<void>;
	delete(key: string): Promise<void>;
	exclusive<T>(callback: () => Promise<T>): Promise<T>;
	clear(): Promise<void>;
	getOrCreate(key: string, value: unknown): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	close(): void;
}
