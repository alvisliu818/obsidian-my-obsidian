/**
 * CRX3 公钥提取 / manifest.key 固化（2026-11-28 对齐思源 1bd4ee8）。
 *
 * Chromium 给未打包扩展按「目录绝对路径」派生 ID：把扩展数据目录搬到库外，
 * 扩展 ID 随之变化，暴力猴存在该 origin 下的脚本/设置就"消失"了。
 * CRX3 头里带着商店签名公钥；写进 manifest.key 后 ID 由公钥派生，与路径无关。
 *
 * CRX3 布局（components/crx_file/crx3.proto）：
 *   "Cr24" + uint32 version + uint32 headerSize + header + zip
 *   CrxFileHeader.sha256_with_rsa (field 2) → AsymmetricKeyProof.public_key (field 1)
 */

function readVarint(buf: Buffer, pos: number): { value: number; pos: number } {
  let value = 0;
  let shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value, pos };
    shift += 7;
    if (shift > 28) break;
  }
  throw new Error("invalid protobuf varint");
}

interface IProtoField {
  field: number;
  wire: number;
  value?: Buffer;
}

function parseFields(buf: Buffer): IProtoField[] {
  const out: IProtoField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (wire === 2) {
      const len = readVarint(buf, pos);
      pos = len.pos;
      out.push({ field, wire, value: buf.subarray(pos, pos + len.value) });
      pos += len.value;
    } else if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      out.push({ field, wire });
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      break; // group / 非法 wire：停止解析当前层
    }
  }
  return out;
}

/** 从 CRX3 头提取 X.509 SubjectPublicKeyInfo（DER）公钥；非 CRX3 返回 null */
export function extractCrx3PublicKey(buf: Buffer): Buffer | null {
  try {
    if (buf.length < 16 || buf.toString("latin1", 0, 4) !== "Cr24") return null;
    if (buf.readUInt32LE(4) !== 3) return null;
    const headerSize = buf.readUInt32LE(8);
    if (headerSize <= 0 || 12 + headerSize > buf.length) return null;
    const header = buf.subarray(12, 12 + headerSize);
    for (const f of parseFields(header)) {
      // 2 = sha256_with_rsa, 3 = sha256_with_ecdsa
      if ((f.field !== 2 && f.field !== 3) || !f.value) continue;
      for (const proof of parseFields(f.value)) {
        if (proof.field === 1 && proof.value && proof.value.length) return proof.value;
      }
    }
  } catch {
    /* 坏包 */
  }
  return null;
}

/** Chromium 扩展 ID = SHA256(公钥 DER) 前 16 字节，每个 nibble 映射到 a-p */
export function extensionIdFromPublicKey(pub: Buffer, crypto: typeof import("crypto")): string {
  const digest = crypto.createHash("sha256").update(pub).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    const b = digest[i];
    id += String.fromCharCode(97 + ((b >> 4) & 15));
    id += String.fromCharCode(97 + (b & 15));
  }
  return id;
}

/**
 * 生成一对 RSA 密钥，返回 manifest.key 可用的公钥（DER SPKI base64）。
 * 没有原始 CRX 的旧安装靠它把 ID 固定下来；私钥直接丢弃（加载不需要）。
 */
export function generateManifestKey(crypto: typeof import("crypto")): string {
  const pair = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return Buffer.from(pair.publicKey as unknown as Uint8Array).toString("base64");
}

/** 把公钥 base64 写进 manifest.json / manifest.orig.json（值相同则不写） */
export function injectManifestKey(fs: any, path: any, extDir: string, keyBase64: string): boolean {
  let changed = false;
  for (const name of ["manifest.json", "manifest.orig.json"]) {
    const file = path.join(extDir, name);
    try {
      if (!fs.existsSync(file)) continue;
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      if (json.key === keyBase64) continue;
      json.key = keyBase64;
      fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n", "utf8");
      changed = true;
    } catch {
      /* 坏 manifest 跳过 */
    }
  }
  return changed;
}
