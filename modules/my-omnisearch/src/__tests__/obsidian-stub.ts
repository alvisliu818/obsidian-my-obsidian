// Obsidian API is only available at runtime inside the host app.
// Tests only exercise pure functions, so stub the functions they use.
// The DocumentsRepository / countError tests additionally need Notice
// (to assert "no warning was shown"), normalizePath and TFile — minimal
// stand-ins for exactly what the code under test reads.

type Frontmatter = Record<string, unknown>

export function parseFrontMatterAliases(
  frontmatter: Frontmatter
): string[] | undefined {
  const aliases = frontmatter['aliases']
  if (aliases == null) return undefined
  if (Array.isArray(aliases)) return aliases as string[]
  if (typeof aliases === 'string') {
    return aliases
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
  }
  return undefined
}

/** Records instantiations so tests can assert that no Notice was shown. */
export class Notice {
  static instances: Array<{ message: string; timeout?: number }> = []
  constructor(message: string, timeout?: number) {
    Notice.instances.push({ message, timeout })
  }
}

/** Minimal stand-in for Obsidian's normalizePath. */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

/** Minimal stand-in for TFile: instanceof + path/basename/stat is all the
 * code under test touches. */
export class TFile {
  constructor(
    public path: string,
    public stat: { mtime: number; ctime: number; size: number } = {
      mtime: 0,
      ctime: 0,
      size: 0,
    }
  ) {}
  get name(): string {
    return this.path.split('/').pop() ?? this.path
  }
  get basename(): string {
    const name = this.name
    const dot = name.lastIndexOf('.')
    return dot > 0 ? name.slice(0, dot) : name
  }
  get extension(): string {
    const name = this.name
    const dot = name.lastIndexOf('.')
    return dot > 0 ? name.slice(dot + 1) : ''
  }
}
