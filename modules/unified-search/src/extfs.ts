/**
 * 库外文件读取（Node fs 直读；桌面端专用模块）。
 *
 * 策略沿用白屏修复的纪律（docs/unified-index-design.md / 白屏排查报告）：
 *  - >1MB 只读头部 1MB（openSync/readSync 非致命 UTF-8 截断），尾部不进索引；
 *  - 网盘挂载下文件随时可能被客户端锁定（EBUSY/EPERM）或替换中（ENOENT）——
 *    读取失败返回 null，调用方静默跳过，下次全量扫描重试。
 */

import { openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";

const HEAD_LIMIT = 1_000_000;

/** 读库外文本文件全文；>1MB 读头部。失败（锁定/消失）返回 null */
export function readExternalText(abs: string): { content: string; mtime: number; size: number } | null {
  try {
    const st = statSync(abs);
    const mtime = Math.round(st.mtimeMs);
    const size = st.size;
    if (size > HEAD_LIMIT) {
      const fd = openSync(abs, "r");
      try {
        const buf = Buffer.alloc(HEAD_LIMIT);
        const read = readSync(fd, buf, 0, HEAD_LIMIT, 0);
        return { content: decodeUtf8Lossy(buf, read), mtime, size };
      } finally {
        closeSync(fd);
      }
    }
    return { content: readFileSync(abs, "utf8"), mtime, size };
  } catch {
    return null; // 锁定/消失：静默跳过，下次扫描重试
  }
}

/** 头部读取可能切断多字节 UTF-8 序列——非致命截断（对齐 logseq extFs.readExternalTextHead） */
function decodeUtf8Lossy(buf: Buffer, length: number): string {
  return buf.subarray(0, length).toString("utf8");
}
