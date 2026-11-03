import type { TAbstractFile } from 'obsidian'
import type OmnisearchPlugin from './main'
import { removeAnchors } from './tools/notes'
import type { IndexedDocument } from './globals'
import { absFromExternalDocPath, isExternalDocPath } from './tools/externalDocs'
import {
  isFileCanvas,
  isFileBase,
  isFileFromDataloom,
  isFileImage,
  isFilePDF,
  logVerbose,
} from './tools/utils'

export class NotesIndexer {
  private notesToReindex = new Set<TAbstractFile>()

  constructor(private plugin: OmnisearchPlugin) {}

  /**
   * Updated notes are not reindexed immediately for performance reasons.
   * They're added to a list, and reindex is done the next time we open Omnisearch.
   */
  public flagNoteForReindex(note: TAbstractFile): void {
    this.notesToReindex.add(note)
  }

  public async refreshIndex(): Promise<void> {
    const queued = [...this.notesToReindex]

    // A note can be deleted after being flagged for reindexing. Skip those,
    // and make sure their stale path is removed from the search index.
    const existing = queued.filter(file =>
      this.plugin.app.vault.getAbstractFileByPath(file.path)
    )
    for (const file of existing) {
      logVerbose('Updating file', file.path)
      await this.plugin.documentsRepository.addDocument(file.path)
    }

    const existingPaths = existing.map(file => file.path)
    if (existingPaths.length) {
      this.plugin.searchEngine.removeFromPaths(existingPaths)
      await this.plugin.searchEngine.addFromPaths(existingPaths)
    }

    const deletedPaths = queued
      .filter(file => !existing.includes(file))
      .map(file => file.path)
    if (deletedPaths.length) {
      this.plugin.searchEngine.removeFromPaths(deletedPaths)
    }

    this.notesToReindex.clear()
  }

  public isFileIndexable(path: string): boolean {
    // 路径级白/黑名单优先。库外文件按真实绝对路径匹配（去掉 ext: 前缀），
    // 这样 `node_modules` 之类的规则对库内和库外两边都生效。
    const filterPath = isExternalDocPath(path) ? absFromExternalDocPath(path) : path
    if (!this.isPathAllowed(filterPath)) return false

    // 库外文件（ext: 伪路径）：按真实扩展名走明文索引那条路。
    if (isExternalDocPath(path)) return this.isFilePlaintext(path)

    // Skip excluded files when hideExcluded is enabled
    if (
      this.plugin.settings.hideExcluded &&
      this.plugin.app.metadataCache.isUserIgnored &&
      this.plugin.app.metadataCache.isUserIgnored(path)
    ) {
      return false
    }

    return this.isFilenameIndexable(path) || this.isContentIndexable(path)
  }

  public isContentIndexable(path: string): boolean {
    const settings = this.plugin.settings
    const hasTextExtractor = !!this.plugin.getTextExtractor()
    const hasAIImageAnalyzer = !!this.plugin.getAIImageAnalyzer()
    const canIndexPDF = hasTextExtractor && settings.PDFIndexing
    const canIndexImages = hasTextExtractor && settings.imagesIndexing
    const canIndexImagesAI = hasAIImageAnalyzer && settings.aiImageIndexing
    return (
      this.isFilePlaintext(path) ||
      isFileCanvas(path) ||
      isFileFromDataloom(path) ||
      (canIndexPDF && isFilePDF(path)) ||
      (canIndexImages && isFileImage(path)) ||
      (canIndexImagesAI && isFileImage(path))
    )
  }

  public isFilenameIndexable(path: string): boolean {
    return (
      this.canIndexUnsupportedFiles() ||
      this.isFilePlaintext(path) ||
      isFileCanvas(path) ||
      isFileBase(path) ||
      isFileFromDataloom(path)
    )
  }

  public canIndexUnsupportedFiles(): boolean {
    return (
      this.plugin.settings.unsupportedFilesIndexing === 'yes' ||
      (this.plugin.settings.unsupportedFilesIndexing === 'default' &&
        !!this.plugin.app.vault.getConfig('showUnsupportedFiles'))
    )
  }

  /**
   * Index a non-existing note.
   * Useful to find internal links that lead (yet) to nowhere
   * @param name
   * @param parent The note referencing the
   */
  public generateIndexableNonexistingDocument(
    name: string,
    parent: string
  ): IndexedDocument {
    name = removeAnchors(name)
    const filename = name + (name.endsWith('.md') ? '' : '.md')

    return {
      path: filename,
      basename: name,
      displayTitle: '',
      mtime: 0,

      content: '',
      tags: [],
      unmarkedTags: [],
      aliases: '',
      headings1: '',
      headings2: '',
      headings3: '',

      doesNotExist: true,
      parent,
    }
  }

  /** 已知二进制扩展名：即便开了「所有纯文本文件」也不按明文索引（svg 是文本，不在内）。 */
  private static readonly BINARY_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'heic', 'avif',
    'pdf', 'psd', 'ai', 'eps', 'sketch',
    'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a',
    'mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v',
    'zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'xz', 'jar',
    'exe', 'dll', 'so', 'dylib', 'bin',
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    'db', 'sqlite', 'sqlite3',
  ])

  /**
   * 路径正则白/黑名单。黑名单优先；两者都可留空（= 不限制）。
   * 坏正则不致命——该规则当作不存在，绝不因此炸掉索引。
   */
  public isPathAllowed(path: string): boolean {
    const settings = this.plugin.settings
    const test = (pattern: string): boolean | null => {
      const p = (pattern ?? '').trim()
      if (!p) return null
      try {
        return new RegExp(p).test(path)
      } catch {
        console.warn('Omnisearch: invalid path filter regex, ignoring:', p)
        return null
      }
    }
    if (test(settings.pathBlacklist) === true) return false
    if (test(settings.pathWhitelist) === false) return false
    return true
  }

  public isFilePlaintext(path: string): boolean {
    if (
      [...this.plugin.settings.indexedFileTypes, 'md'].some(t =>
        path.endsWith(`.${t}`)
      ) ||
      (this.plugin.settings.indexFilesWithoutExtension && !path.includes('.'))
    ) {
      return true
    }
    // 「所有纯文本文件」：除已知二进制扩展名外一律按明文索引，
    // 让 .ts/.json/.yaml/.csv/.log 这类都能进索引。
    if (this.plugin.settings.indexAllPlaintext) {
      const match = path.match(/\.([^./\\]+)$/)
      const ext = match ? match[1].toLowerCase() : ''
      if (!ext || !NotesIndexer.BINARY_EXTENSIONS.has(ext)) return true
    }
    return false
  }
}
