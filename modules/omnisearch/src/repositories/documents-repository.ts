import { normalizePath, TFile } from 'obsidian'
import type { CanvasData } from 'obsidian/canvas'
import type { IndexedDocument } from '../globals'
import type OmnisearchPlugin from '../main'
import { absFromExternalDocPath, isExternalDocPath } from '../tools/externalDocs'
import {
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

/**
 * Read at most `limit` bytes from the head of `abs`, decoded as UTF-8.
 * A truncated read may split one code point at the boundary — non-fatal
 * decoding degrades the tail to a replacement char, irrelevant for search.
 */
function readHeadUtf8(
  fs: {
    openSync(p: string, flags: string): number
    readSync(
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ): number
    closeSync(fd: number): void
  },
  abs: string,
  limit: number,
): string {
  const buf = new Uint8Array(limit)
  let fd = -1
  try {
    fd = fs.openSync(abs, 'r')
    const n = fs.readSync(fd, buf, 0, limit, 0)
    return new TextDecoder('utf8', { fatal: false }).decode(buf.subarray(0, n))
  } finally {
    try {
      if (fd >= 0) fs.closeSync(fd)
    } catch {
      // close failure must not mask the read result
    }
  }
}

export class DocumentsRepository {
  /**
   * The "live cache", containing all indexed vault files
   * in the form of IndexedDocuments
   */
  private documents: Map<string, IndexedDocument> = new Map()

  constructor(private plugin: OmnisearchPlugin) {}

  /**
   * Set or update the live cache with the content of the given file.
   * @param path
   */
  public async addDocument(path: string): Promise<void> {
    try {
      const doc = await this.getAndMapIndexedDocument(path)
      if (!doc) {
        // 读不到内容：库外文件被网盘客户端锁定/替换（getExternalIndexedDocument
        // 返回 null），或库内文件已被静默删除 / 读取瞬态失败。都是瞬态或可自愈
        // 场景，不是缓存损坏——摘掉 live cache 条目即可，不计 countError
        // （计入只会造成「请清理缓存」的误报，百度盘挂载下每次重启都凑满阈值）。
        // 文件下次可读时会被 diff / refreshIndex 重新收录。
        logVerbose('Omnisearch: no readable content for', path, '- skipping')
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
      // getAndMapIndexedDocument 抛错只剩两类，都不是「缓存损坏」：
      // ① 文件已不存在——库外进程静默删除/改名（Obsidian 没发 delete 事件）
      //    留下的陈旧条目，自愈摘除即可；
      // ② 读取抛错——网盘客户端锁定/替换（EBUSY/EPERM/ENOENT）等瞬态故障，
      //    或 canvas 解析失败这类文件级问题。清理缓存都解决不了这些问题，
      //    计 countError 只会造成「请清理缓存」的误报（百度盘挂载下每次
      //    重启都凑满阈值）。改为 verbose 日志：默认不刷屏，排查时打开
      //    verboseLogging 即能看到。文件下次可读时会被 diff / refreshIndex
      //    重新收录。
      logVerbose(`Omnisearch: skipping "${path}"`, e)
      // Shouldn't be needed, but...
      this.removeDocument(path)
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

    // 库外瞬态读失败（被锁定/替换中的网盘文件）：给空壳文档——文件下次
    // 可读时会被 diff 重新收录，搜索结果暂时少一条，不计任何错误。
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

    // 库内文件取不到：陈旧条目（调用方按「文件已不存在」自愈摘除）或
    // 瞬态读失败（下次 refresh/search 重试）。两者都不是「缓存损坏」——
    // 原先这里在 addDocument 已计过一次之后又计一次（同一失败双计），
    // 且 console.error 每刷一次搜索结果就刷一遍，一并去掉。
    return document!
  }

  /**
   * This function is responsible for extracting the text from a file and
   * returning it as an `IndexedDocument` object.
   * @param path
   */
  private async getAndMapIndexedDocument(
    path: string
  ): Promise<IndexedDocument | null> {
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
      statSync(p: string): { mtimeMs?: number; size?: number }
      openSync?(p: string, flags: string): number
      readSync?(
        fd: number,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number | null,
      ): number
      closeSync?(fd: number): void
    }
    const abs = absFromExternalDocPath(path)
    // 大文件读头部 1MB 而非全文：外部挂载目录（实测有人挂整个盘/代码目录）
    // 里混着大 md 时，启动期逐个 readFileSync 把 renderer 堆顶崩（readFileSync
    // + toString 累计分配 ~380MB）。搜索覆盖头部 1MB 正文，尾部不进索引。
    const HEAD_LIMIT = 1_000_000
    // 百度盘等网盘挂载下，文件随时可能被客户端锁定（EBUSY/EPERM）或正处于
    // 替换中（ENOENT）——读取失败不抛，返回 null 让调用方静默跳过。
    let content: string
    try {
      const size = fs.statSync(abs).size ?? 0
      if (size > HEAD_LIMIT && fs.openSync && fs.readSync && fs.closeSync) {
        content = readHeadUtf8(
          { openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync },
          abs,
          HEAD_LIMIT,
        )
      } else {
        content = fs.readFileSync(abs, 'utf8')
      }
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
