/* eslint-disable @typescript-eslint/no-explicit-any */
import JSZip from "jszip";

/**
 * CRX = a header blob followed by a plain ZIP. Instead of parsing the CRX2/CRX3
 * header fields (two incompatible layouts), locate the first ZIP local-file
 * magic and slice from there — the same shortcut the SiYuan plugin uses, and
 * it survives both versions plus a bare .zip dropped in by a user.
 */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function findZipOffset(buf: Uint8Array): number {
  const limit = Math.min(buf.length - 4, 4096); // the header never gets bigger
  for (let i = 0; i <= limit; i++) {
    if (buf[i] === ZIP_MAGIC[0] && buf[i + 1] === ZIP_MAGIC[1] && buf[i + 2] === ZIP_MAGIC[2] && buf[i + 3] === ZIP_MAGIC[3]) {
      return i;
    }
  }
  return -1;
}

export interface ExtractedFile {
  /** Path relative to the archive root, always with forward slashes. */
  path: string;
  data: Uint8Array;
}

export async function extractExtensionArchive(buffer: ArrayBuffer): Promise<ExtractedFile[]> {
  const bytes = new Uint8Array(buffer);
  const offset = findZipOffset(bytes);
  if (offset < 0) throw new Error("不是有效的 CRX / ZIP 文件");

  const zip = await JSZip.loadAsync(bytes.subarray(offset));
  const out: ExtractedFile[] = [];
  const names = Object.keys(zip.files);
  for (const name of names) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    // Strip a leading folder (CRXs usually wrap everything in one top dir).
    const data = await entry.async("uint8array");
    out.push({ path: normalizeEntryPath(name, names), data });
  }
  return out;
}

/** Drop the common top-level directory so manifest.json ends up at the root. */
function normalizeEntryPath(name: string, all: string[]): string {
  const clean = name.replace(/^\/+/, "");
  const seg = clean.split("/");
  if (seg.length < 2) return clean;
  const top = seg[0];
  const everyHasTop = all.every((n) => n === top || n.startsWith(top + "/"));
  if (everyHasTop && all.some((n) => n === top + "/manifest.json")) return seg.slice(1).join("/");
  return clean;
}
