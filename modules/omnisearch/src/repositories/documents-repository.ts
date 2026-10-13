import { normalizePath, TFile } from 'obsidian'
import type { CanvasData } from 'obsidian/canvas'
import type { IndexedDocument } from '../globals'
import type OmnisearchPlugin from '../main'
import { absFromExternalDocPath, isExternalDocPath } from '../tools/externalDocs'
import {
  countError,
  extractHeadingsFromCache,
  getAliasesFromMetadata,
  getTagsFromMetadata,
  isFileCanvas,
  isFileFromDataloom,
  isFileImage,
  isFileOffice,
  isFilePDF,
  logVerbose,
  warnVerbose,
} from '../tools/utils'

export class DocumentsRepository {
  /**
   * The "live cache", containing all indexed vault files
   * in the form of IndexedDocuments
   */
  private documents: Map<string, IndexedDocument> = new Map()
  private errorsCount = 0

  constructor(private plugin: OmnisearchPlugin) {
    this.plugin.registerInterval(
    window.setInterval(() => {
      if (this.errorsCount > 0) {
        --this.errorsCount
        }
      }, 1000)
    )
  }

  /**
   * Set or update the live cache with the content of the given file.
   * @param path
   */
  public async addDocument(path: string): Promise<void> {
    try {
      const doc = await this.getAndMapIndexedDocument(path)
      if (!doc) {
        // 库外文件读不了（被网盘客户端锁定/替换、临时消失等）——静默跳过。
        // 这些是瞬态失败，不是缓存损坏；计入 countError 只会造成
        // 「请清理缓存」的误报（百度盘挂载下每次重启都会凑满阈值）。
        // 文件真正删除由下一轮 reconcile 从索引里清掉。
        this.removeDocument(path)
        return
      }
      if (!doc.path) {
        console.error(
          `Missing .path field in IndexedDocument "${doc.basename}", skipping`
        )
        return
      }
      this.documents.set(path, doc)
      this.plugin.embedsRepository.refreshEmbedsForNote(path)
    } catch (e) {
      console.warn(`Omnisearch: Error while adding "${path}" to live cache`, e)
      // Shouldn't be needed, but...
      this.removeDocument(path)
      countError()
    }
  }

  public removeDocument(path: string): void {
    this.documents.delete(path)
  }

  public async getDocument(path: string): Promise<IndexedDocument> {
    if (this.documents.has(path)) {
      return this.documents.get(path)!
    }
    logVerbose('Generating IndexedDocument from', path)
    await this.addDocument(path)
    const document = this.documents.get(path)

    // 库外瞬态跳过（被锁定/替换中的网盘文件）：给空壳文档，不计错误——
    // 文件下次可读时会被 diff 重新收录。真正的缓存损坏才走 countError。
    if (!document && isExternalDocPath(path)) {
      return {
        basename: '',
        displayTitle: '',
        content: '',
        path,
        mtime: 0,
        tags: [],
        unmarkedTags: [],
        aliases: '',
        headings1: '',
        headings2: '',
        headings3: '',
      }
    }

    // Only happens if the cache is corrupted
    if (!document) {
      console.error('Omnisearch', path, 'cannot be read')
      countError()
    }

    // The document might be undefined, but this shouldn't stop the search from mostly working
    return document!
  }

  /**
   * This function is responsible for extracting the text from a file and
   * returning it as an `IndexedDocument` object.
   * @param path
   */
  private async getAndMapIndexedDocument(
    path: string
  ): Promise<IndexedDocument> {
    // 库外文件（ext: 伪路径）：读磁盘，不走 vault API。
    if (isExternalDocPath(path)) {
      return this.getExternalIndexedDocument(path)
    }
    path = normalizePath(path)
    const app = this.plugin.app
    const file = app.vault.getAbstractFileByPath(path)
    if (!file) throw new Error(`Invalid file path: "${path}"`)
    if (!(file instanceof TFile)) throw new Error(`Not a TFile: "${path}"`)
    let content: string | null = null

    const extractor = this.plugin.getTextExtractor()
    const aiImageAnalyzer = this.plugin.getAIImageAnalyzer()

    // ** Plain text **
    // Just read the file content
    if (this.plugin.notesIndexer.isFilePlaintext(path)) {
      content = await app.vault.cachedRead(file)
    }

    // ** Canvas **
    // Extract the text fields from the json
    else if (isFileCanvas(path)) {
      const fileContents = await app.vault.cachedRead(file)
      const canvas = fileContents ? JSON.parse(fileContents) as CanvasData : {
        nodes: [],
        edges: [],
      }
      const texts: string[] = []
      // Concatenate text from the canvas fields
      for (const node of canvas.nodes ?? []) {
        if (node.type === 'text') {
          texts.push(node.text)
        } else if (node.type === 'file') {
          texts.push(node.file)
        }
      }
      for (const edge of (canvas.edges ?? []).filter(e => !!e.label)) {
        texts.push(edge.label!)
      }
      content = texts.join('\r\n')
    }

    // ** Dataloom plugin **
    else if (isFileFromDataloom(path)) {
      try {
        const data = JSON.parse(await app.vault.cachedRead(file)) as unknown
        // data is a json object, we recursively iterate the keys
        // and concatenate the values if the key is "markdown"
        const texts: string[] = []
        const iterate = (obj: any) => {
          for (const key in obj) {
            if (typeof obj[key] === 'object') {
              iterate(obj[key])
            } else if (key === 'content') {
              texts.push(obj[key])
            }
          }
        }
        iterate(data)
        content = texts.join('\r\n')
      } catch (e) {
        console.error('Omnisearch: Error while parsing Dataloom file', path)
        console.error(e)
      }
    }

    // ** Image **
    else if (isFileImage(path)) {
      // AI Image Analyzer
      if (
        this.plugin.settings.aiImageIndexing &&
        aiImageAnalyzer?.canBeAnalyzed(file)
      ) {
        content = await aiImageAnalyzer.analyzeImage(file)
      }

      // Text Extractor
      else if (
        this.plugin.settings.imagesIndexing &&
        extractor?.canFileBeExtracted(path)
      ) {
        content = await extractor.extractText(file)
      }
    }
    // ** PDF **
    else if (
      isFilePDF(path) &&
      this.plugin.settings.PDFIndexing &&
      extractor?.canFileBeExtracted(path)
    ) {
      content = await extractor.extractText(file)
    }

    // ** Office document **
    else if (
      isFileOffice(path) &&
      this.plugin.settings.officeIndexing &&
      extractor?.canFileBeExtracted(path)
    ) {
      content = await extractor.extractText(file)
    }

    // ** Unsupported files **
    else if (this.plugin.notesIndexer.isFilenameIndexable(path)) {
      content = file.path
    }

    if (content === null || content === undefined) {
      warnVerbose(`Omnisearch: ${content} content for file`, file.path)
      content = ''
    }

    const metadata = app.metadataCache.getFileCache(file)

    // Look for links that lead to non-existing files,
    // and add them to the index.
    if (metadata) {
      // const nonExisting = getNonExistingNotes(this.plugin.app, file, metadata)
      // for (const name of nonExisting.filter(o => !this.documents.has(o))) {
      //   const doc =
      //     this.plugin.notesIndexer.generateIndexableNonexistingDocument(
      //       name,
      //       file.path
      //     )
      //   // TODO: index non-existing note
      // }

      // EXCALIDRAW
      // Remove the json code
      if (metadata.frontmatter?.['excalidraw-plugin']) {
        const comments =
          metadata.sections?.filter(s => s.type === 'comment') ?? []
        for (const { start, end } of comments.map(c => c.position)) {
          content =
            content.substring(0, start.offset - 1) +
            content.substring(end.offset)
        }
      }
    }
    let displayTitle: string
    if (this.plugin.settings.displayTitle === '#heading') {
      displayTitle = metadata?.headings?.find(h => h.level === 1)?.heading ?? ''
    } else {
      displayTitle =
        metadata?.frontmatter?.[this.plugin.settings.displayTitle] ?? ''
    }
    const tags = getTagsFromMetadata(metadata)
    return {
      basename: file.basename,
      displayTitle,
      content,
      path: file.path,
      mtime: file.stat.mtime,

      tags: tags,
      unmarkedTags: tags.map(t => t.replace('#', '')),
      aliases: getAliasesFromMetadata(metadata).join(''),
      headings1: metadata
        ? extractHeadingsFromCache(metadata, 1).join(' ')
        : '',
      headings2: metadata
        ? extractHeadingsFromCache(metadata, 2).join(' ')
        : '',
      headings3: metadata
        ? extractHeadingsFromCache(metadata, 3).join(' ')
        : '',
    }
  }

  /**
   * 库外文件（虚拟文档树挂载）的 IndexedDocument：Node fs 直读。
   *
   * 没有 metadataCache，所以标签/标题/别名为空；文件名本身参与索引
   * （minisearch 对 basename 有权重），内容按明文读。
   */
  private getExternalIndexedDocument(path: string): IndexedDocument | null {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = eval('require')('fs') as {
      readFileSync(p: string, enc: 'utf8'): string
      statSync(p: string): { mtimeMs?: number }
    }
    const abs = absFromExternalDocPath(path)
    // 百度盘等网盘挂载下，文件随时可能被客户端锁定（EBUSY/EPERM）或正处于
    // 替换中（ENOENT）——读取失败不抛，返回 null 让调用方静默跳过。
    let content: string
    try {
      content = fs.readFileSync(abs, 'utf8')
    } catch {
      return null
    }
    const name = abs.split('/').pop() ?? abs
    const dot = name.lastIndexOf('.')
    let mtime = 0
    try {
      mtime = Math.round(fs.statSync(abs).mtimeMs ?? 0)
    } catch {
      // stat 失败不影响索引，mtime=0 会让下次重建时重读一遍，无害
    }
    return {
      basename: dot > 0 ? name.slice(0, dot) : name,
      displayTitle: '',
      content,
      path,
      mtime,

      tags: [],
      unmarkedTags: [],
      aliases: '',
      headings1: '',
      headings2: '',
      headings3: '',
    }
  }
}
