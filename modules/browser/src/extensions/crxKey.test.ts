import { describe, expect, it } from "vitest";
import * as nodeCrypto from "node:crypto";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import * as nodeFs from "node:fs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as nodePath from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionIdFromPublicKey, extractCrx3PublicKey, generateManifestKey, injectManifestKey } from "./crxKey";

/** 造一个只含「公钥」一个字段的 CRX3 头（足够被测函数解析）。 */
function fakeCrx3(publicKey: Buffer): Buffer {
  const varint = (n: number): Buffer => {
    const out: number[] = [];
    let v = n;
    while (v > 0x7f) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v);
    return Buffer.from(out);
  };
  const field = (num: number, payload: Buffer): Buffer =>
    Buffer.concat([varint(num * 8 + 2), varint(payload.length), payload]);
  const proof = field(1, publicKey); // AsymmetricKeyProof.public_key
  const header = field(2, proof); // CrxFileHeader.sha256_with_rsa
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "latin1");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, Buffer.from("PK\x03\x04", "latin1")]);
}

describe("crxKey", () => {
  it("extracts the CRX3 public key and derives the store-style extension id", () => {
    const { publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    const pub = Buffer.from(publicKey as unknown as Uint8Array);
    const crx = fakeCrx3(pub);

    const extracted = extractCrx3PublicKey(crx);
    expect(extracted?.equals(pub)).toBe(true);

    const id = extensionIdFromPublicKey(pub, nodeCrypto);
    expect(id).toMatch(/^[a-p]{32}$/);

    // 与 Chromium 的算法一致：SHA256 前 16 字节，nibble 映射 a-p
    const digest = createHash("sha256").update(pub).digest();
    const expected = Array.from(digest.subarray(0, 16))
      .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
      .join("");
    expect(id).toBe(expected);
  });

  it("rejects non-CRX input", () => {
    expect(extractCrx3PublicKey(Buffer.from("PK\x03\x04not-a-crx", "latin1"))).toBeNull();
  });

  it("generates a usable manifest key (valid SPKI DER)", () => {
    const key = generateManifestKey(nodeCrypto);
    const pub = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
    expect(pub.asymmetricKeyType).toBe("rsa");
    // 私钥不随 key 下发：只有公钥
    expect(() => createPrivateKey({ key: Buffer.from(key, "base64"), format: "der", type: "pkcs8" })).toThrow();
  });

  it("injects the key into manifest.json and manifest.orig.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-crxkey-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "x", version: "1" }));
    const key = "QUJD";
    expect(injectManifestKey(nodeFs, nodePath, dir, key)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).key).toBe(key);
    // 没有 manifest.orig.json 时不凭空创建
    expect(() => readFileSync(join(dir, "manifest.orig.json"), "utf8")).toThrow();
    // 幂等
    expect(injectManifestKey(nodeFs, nodePath, dir, key)).toBe(false);
  });
});
