import { openDB, type DBSchema } from "idb";

interface WasmCache extends DBSchema {
  binaries: {
    key: string;
    value: ArrayBuffer;
  };
}

// A fixed database name allows vaults on the same Obsidian origin to reuse it.
const databaseName = "cm-chs-patch-jieba";
const binaryKey = `jieba-wasm@${__JIEBA_VERSION__}`;

async function openCache() {
  return openDB<WasmCache>(databaseName, 1, {
    upgrade(db) {
      db.createObjectStore("binaries");
    },
  });
}

export async function loadWasm(): Promise<ArrayBuffer | null> {
  const db = await openCache();
  try {
    const cached = (await db.get("binaries", binaryKey)) ?? null;
    if (cached) return cached;
  } finally {
    db.close();
  }
  // 聚合仓适配：IndexedDB 没有用户导入的组件时，回落到构建期内嵌的
  // jieba wasm（esbuild 以 __JIEBA_WASM_B64__ define 注入，与
  // __JIEBA_WASM_SHA256__ 读的是同一份文件，版本必然匹配）——免掉「手动
  // 导入结巴分词组件」的引导流程，装上即用。用户手动导入的仍优先生效。
  return embeddedWasm();
}

function embeddedWasm(): ArrayBuffer | null {
  const b64 = __JIEBA_WASM_B64__;
  if (!b64) return null;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function saveWasm(binary: ArrayBuffer): Promise<void> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", binary));
  const hex = Array.from(hash, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hex !== __JIEBA_WASM_SHA256__) {
    throw new Error(
      `The selected file does not match jieba-wasm ${__JIEBA_VERSION__}.`,
    );
  }
  const db = await openCache();
  try {
    await db.put("binaries", binary, binaryKey);
  } finally {
    db.close();
  }
}

export async function listWasmVersions(): Promise<string[]> {
  const db = await openCache();
  try {
    return await db.getAllKeys("binaries");
  } finally {
    db.close();
  }
}

export async function deleteWasm(key = binaryKey): Promise<boolean> {
  const db = await openCache();
  try {
    const tx = db.transaction("binaries", "readwrite");
    const exists = (await tx.store.count(key)) > 0;
    await tx.store.delete(key);
    await tx.done;
    return exists;
  } finally {
    db.close();
  }
}
