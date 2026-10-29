/**
 * Registry of Logseq-format page properties (file-top `key:: value` lines)
 * per file path. These lines are NOT frontmatter, so Obsidian's metadata
 * cache never sees them — this registry + the metadataCache.getFileCache
 * patch (main.ts) exposes them to other plugins as if they were native page
 * properties, without changing the file format.
 */
const registry = new Map<string, Record<string, string>>();

export function registerLogseqPageProps(path: string, props: Record<string, string>): void {
  if (Object.keys(props).length > 0) registry.set(path, props);
  else registry.delete(path);
}

export function getLogseqPageProps(path: string): Record<string, string> | undefined {
  return registry.get(path);
}

export function clearLogseqPageProps(path: string): void {
  registry.delete(path);
}
