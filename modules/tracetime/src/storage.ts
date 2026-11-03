import { App, normalizePath } from "obsidian";
import { encode, decode } from "@msgpack/msgpack";
import { hashText } from "./hash";
import type { FileRecord } from "./record";

/**
 * 按文件一个 MessagePack 记录文件，文件名 = xxHash64(path)。
 * 写入通过 promise 链串行化：同一文件连续多次写入只保留最新快照，
 * 由调用方在调用 save 前覆盖快照内容实现。
 *
 * 规模超过约 1000 个记录文件后再升级为分片 append-only 日志。
 */
export class Storage {
	private dir: string;
	private chain: Promise<void> = Promise.resolve();

	constructor(private app: App, pluginDir: string) {
		this.dir = normalizePath(`${pluginDir}/records`);
	}

	async ensureDir(): Promise<void> {
		if (!(await this.app.vault.adapter.exists(this.dir))) {
			await this.app.vault.adapter.mkdir(this.dir);
		}
	}

	private recordPath(path: string): string {
		return normalizePath(`${this.dir}/${hashText(path).toString(16).padStart(16, "0")}.msgpack`);
	}

	private backupPath(path: string): string {
		return normalizePath(`${this.dir}/${hashText(path).toString(16).padStart(16, "0")}.bak.msgpack`);
	}

	async load(path: string): Promise<FileRecord | null> {
		return this.loadFrom(this.recordPath(path), path);
	}

	/** 上一代记录（每次写入前自动留的备份），用于误刷时间戳后的回滚 */
	async loadBackup(path: string): Promise<FileRecord | null> {
		return this.loadFrom(this.backupPath(path), path);
	}

	private async loadFrom(p: string, path: string): Promise<FileRecord | null> {
		try {
			if (!(await this.app.vault.adapter.exists(p))) return null;
			const buf = await this.app.vault.adapter.readBinary(p);
			return decode(new Uint8Array(buf)) as FileRecord;
		} catch (e) {
			console.error("TraceTime: failed to load record", path, e);
			return null;
		}
	}

	save(path: string, record: FileRecord): void {
		const p = this.recordPath(path);
		const bak = this.backupPath(path);
		this.enqueue(async () => {
			// 覆盖前先把上一代留档，支持一次回滚
			if (await this.app.vault.adapter.exists(p)) {
				const prev = await this.app.vault.adapter.readBinary(p);
				await this.app.vault.adapter.writeBinary(bak, prev);
			}
			const u8 = encode(record);
			const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
			await this.app.vault.adapter.writeBinary(p, buf);
		});
	}

	remove(path: string): void {
		const files = [this.recordPath(path), this.backupPath(path)];
		this.enqueue(async () => {
			for (const p of files) {
				if (await this.app.vault.adapter.exists(p)) {
					await this.app.vault.adapter.remove(p);
				}
			}
		});
	}

	async move(oldPath: string, newPath: string): Promise<void> {
		const record = await this.load(oldPath);
		const backup = await this.loadBackup(oldPath);
		if (record || backup) {
			this.enqueue(async () => {
				if (record) {
					record.path = newPath;
					const u8 = encode(record);
					const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
					await this.app.vault.adapter.writeBinary(this.recordPath(newPath), buf);
				}
				if (backup) {
					backup.path = newPath;
					const u8 = encode(backup);
					const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
					await this.app.vault.adapter.writeBinary(this.backupPath(newPath), buf);
				}
			});
			this.remove(oldPath);
		}
	}

	private enqueue(task: () => Promise<void>): void {
		this.chain = this.chain.then(task).catch((e) => {
			console.error("TraceTime: storage write failed", e);
		});
	}
}
