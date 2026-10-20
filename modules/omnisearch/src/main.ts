import {
  App,
  type EventRef,
  Notice,
  Platform,
  Plugin,
  type PluginManifest,
  TFile,
} from 'obsidian'
import {
  OmnisearchInFileModal,
  OmnisearchVaultModal,
} from './components/modals'
import {
  getDefaultSettings,
  loadSettings,
  SettingsTab,
  showExcerpt,
} from './settings'
import type { OmnisearchSettings } from './settings/utils'
import { isCacheEnabled } from './settings/utils'
import { saveSettings } from './settings/utils'
import { isPluginDisabled } from './settings/utils'
import {
  eventBus,
  EventNames,
  indexingStep,
  IndexingStepType,
  type TextExtractorApi,
  type AIImageAnalyzerAPI,
} from './globals'
import { notifyOnIndexed, registerAPI } from './tools/api'
import { Database } from './database'
import { SearchEngine } from './search/search-engine'
import { DocumentsRepository } from './repositories/documents-repository'
import { logVerbose } from './tools/utils'
import { NotesIndexer } from './notes-indexer'
import { TextProcessor } from './tools/text-processing'
import { EmbedsRepository } from './repositories/embeds-repository'
import { SearchHistory } from './search/search-history'

export default class OmnisearchPlugin extends Plugin {
  // FIXME: fix the type
  public apiHttpServer: null | any = null
  public settings: OmnisearchSettings = getDefaultSettings(this.app)

  public readonly documentsRepository: DocumentsRepository
  public readonly embedsRepository = new EmbedsRepository(this)
  public readonly database = new Database(this)

  public readonly notesIndexer = new NotesIndexer(this)
  public readonly textProcessor = new TextProcessor(this)
  public readonly searchEngine = new SearchEngine(this)
  public readonly searchHistory = new SearchHistory(this)

  private ribbonButton?: HTMLElement
  private refreshIndexCallback?: (ev: FocusEvent) => any

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest)
    this.documentsRepository = new DocumentsRepository(this)
  }

  async onload(): Promise<void> {
    const bootlog = ((window as unknown as { __bootlog?: string[] }).__bootlog ??= []);
    bootlog.push('omnisearch: onload start');
    this.settings = await loadSettings(this)
    bootlog.push('omnisearch: settings loaded')
    this.addSettingTab(new SettingsTab(this))

    if (!Platform.isMobile) {
      import('./tools/api-server')
        .then(m => (this.apiHttpServer = m.getServer(this)))
        .catch(e => {
          console.error('Omnisearch - Failed to load API server', e)
        })
    }

    if (isPluginDisabled(this.app)) {
      console.debug('Plugin disabled')
      return
    }

    bootlog.push('omnisearch: cleaning cache files')
    await cleanOldCacheFiles(this.app)
    bootlog.push('omnisearch: cache cleaned; clearing old dbs')
    await this.database.clearOldDatabases()
    bootlog.push('omnisearch: old dbs cleared')

    registerAPI(this)

    const settings = this.settings
    if (settings.ribbonIcon) {
      this.addRibbonButton()
    }

    eventBus.disable('vault')
    eventBus.disable('infile')
    eventBus.on('global', EventNames.ToggleExcerpts, () => {
      showExcerpt.set(!settings.showExcerpt)
    })

    // Commands to display Omnisearch modals
    this.addCommand({
      id: 'show-modal',
      name: 'Vault search',
      callback: () => {
        new OmnisearchVaultModal(this).open()
      },
    })

    this.addCommand({
      id: 'show-modal-infile',
      name: 'In-file search',
      editorCallback: (_editor, view) => {
        if (view.file) {
          new OmnisearchInFileModal(this, view.file).open()
        }
      },
    })

    const searchEngine = this.searchEngine

    this.app.workspace.onLayoutReady(async () => {
      // Listeners to keep the search index up-to-date
      this.registerEvent(
        this.app.vault.on('create', async file => {
          if (!(file instanceof TFile)) return
          if (this.notesIndexer.isFileIndexable(file.path)) {
            logVerbose('Indexing new file', file.path)
            try {
              await searchEngine.addFromPaths([file.path])
            } catch (e) {
              console.error('Omnisearch - Error indexing new file', e)
            }
            this.embedsRepository.refreshEmbedsForNote(file.path)
          }
        })
      )
      this.registerEvent(
        this.app.vault.on('delete', file => {
          if (!(file instanceof TFile)) return
          logVerbose('Removing file', file.path)
          this.documentsRepository.removeDocument(file.path)
          searchEngine.removeFromPaths([file.path])
          this.embedsRepository.removeFile(file.path)
        })
      )
      this.registerEvent(
        this.app.vault.on('modify', async file => {
          if (!(file instanceof TFile)) return
          if (this.notesIndexer.isFileIndexable(file.path)) {
            this.notesIndexer.flagNoteForReindex(file)
          }
          this.embedsRepository.refreshEmbedsForNote(file.path)
        })
      )
      this.registerEvent(
        this.app.vault.on('rename', async (file, oldPath) => {
          if (!(file instanceof TFile)) return
          if (this.notesIndexer.isFileIndexable(file.path)) {
            logVerbose('Renaming file', file.path)
            this.documentsRepository.removeDocument(oldPath)
            await this.documentsRepository.addDocument(file.path)

            searchEngine.removeFromPaths([oldPath])
            await searchEngine.addFromPaths([file.path])

            this.embedsRepository.renameFile(oldPath, file.path)
          }
        })
      )

      this.refreshIndexCallback = this.notesIndexer.refreshIndex.bind(
        this.notesIndexer
      )
      addEventListener('blur', this.refreshIndexCallback!)

      await this.executeFirstLaunchTasks()
      await this.populateIndex()

      // 库外文件（虚拟文档树挂载）：初始索引后立刻重索引一次，并订阅 logseq
      // 的挂载刷新广播——否则会话中新增/删除的库外文件不会进索引。
      void this.reindexExternalFiles()
      // 自定义事件名不在 obsidian.d.ts 的 on() 重载里（那里只列举内置事件），
      // 故走一次窄化的 any 通道；registerEvent 仍负责卸载时注销。
      const ws = this.app.workspace as unknown as {
        on(name: string, cb: () => void): EventRef
      }
      this.registerEvent(
        ws.on('logseq:external-mounts-refreshed', () => this.scheduleExternalReindex()),
      )

      if (this.apiHttpServer && settings.httpApiEnabled) {
        this.apiHttpServer.listen(settings.httpApiPort)
      }
    })
  }

  async executeFirstLaunchTasks(): Promise<void> {
    const code = '1.21.0'
    // if (settings.welcomeMessage !== code && getTextExtractor()) {
    //   const welcome = new DocumentFragment()
    //   welcome.createSpan({}, span => {
    //     span.innerHTML = `🔎 Omnisearch can now index .docx and .xlsx documents. Don't forget to update Text Extractor and enable the toggle in Omnisearch settings.`
    //   })
    //   new Notice(welcome, 20_000)
    // }
    this.settings.welcomeMessage = code
    await this.saveData(this.settings)
  }

  async onunload(): Promise<void> {
    // @ts-ignore
    delete globalThis['omnisearch']

    if (this.refreshIndexCallback) {
      removeEventListener('blur', this.refreshIndexCallback)
    }

    // Clear cache when disabling Omnisearch
    if (process.env.NODE_ENV === 'production') {
      await this.database.clearCache()
    }
    this.apiHttpServer.close()
  }

  addRibbonButton(): void {
    this.ribbonButton = this.addRibbonIcon('search', 'Omnisearch', _evt => {
      new OmnisearchVaultModal(this).open()
    })
  }

  removeRibbonButton(): void {
    if (this.ribbonButton) {
      this.ribbonButton.parentNode?.removeChild(this.ribbonButton)
    }
  }

  /**
   * Plugin dependency - Chs Patch for Chinese word segmentation
   * @returns
   */
  public getChsSegmenter(): any | undefined {
    return (this.app as any).plugins?.plugins?.['cm-chs-patch']
  }

  /**
   * Plugin dependency - Text Extractor
   * @returns
   */
  public getTextExtractor(): TextExtractorApi | undefined {
    return (this.app as any).plugins?.plugins?.['text-extractor']?.api
  }

  /**
   * Plugin dependency - Ai Image Analyzer
   * @returns
   */
  public getAIImageAnalyzer(): AIImageAnalyzerAPI | undefined {
    return (this.app as any).plugins?.plugins?.['ai-image-analyzer']?.api
  }

  /**
   * 合并新增：库外文件（虚拟文档树挂载）的索引清单。
   *
   * 通过 logseq 模块（宿主别名 obsidian-logseq）的全深度扫描拿文件清单，
   * 转成 ext: 伪路径。logseq 模块不在（未启用）时返回空——库外支持是
   * 纯增益，缺了它 omnisearch 照常工作。
   */
  private getExternalIndexableFiles(): Array<{ path: string; mtime: number }> {
    try {
      const logseq = (this.app as any).plugins?.plugins?.['obsidian-logseq'] as
        | { listExternalSearchFiles?: () => Array<{ abs: string; name: string; mtime: number }> }
        | undefined
      const files = logseq?.listExternalSearchFiles?.() ?? []
      return files
        .filter(f => this.notesIndexer.isFileIndexable(`ext:${f.abs.replace(/\\/g, '/')}`))
        .map(f => ({ path: `ext:${f.abs.replace(/\\/g, '/')}`, mtime: f.mtime }))
    } catch (e) {
      console.warn('Omnisearch: listing external files failed', e)
      return []
    }
  }

  /**
   * 合并新增：重索引库外文件（logseq 的 refreshMounts 在挂载变化后调用）。
   *
   * 增删差集只在 ext: 范围内求——绝不能把「只有 ext 的清单」喂给
   * getDocumentsToReindex，那会把「不在清单里的所有库内文档」都判成已删除
   * 而清掉整个库内索引（e2e 的金丝雀探针逮到过）。
   */
  /**
   * 挂载刷新广播可能很频繁（logseq 的 refreshSeconds 定时轮询），
   * 防抖后再重扫——每次全量列举挂载树在大目录上不便宜。
   */
  private externalReindexTimer: number | null = null;
  private scheduleExternalReindex(): void {
    if (this.externalReindexTimer !== null) {
      window.clearTimeout(this.externalReindexTimer);
    }
    this.externalReindexTimer = window.setTimeout(() => {
      this.externalReindexTimer = null;
      void this.reindexExternalFiles();
    }, 2000);
  }

  public async reindexExternalFiles(): Promise<void> {
    try {
      const ext = this.getExternalIndexableFiles()
      const next = new Map(ext.map(f => [f.path, f.mtime]))
      const current = this.searchEngine.getExternalIndexedDocs()
      const currentMap = new Map(current.map(d => [d.path, d.mtime]))
      const toAdd = ext.filter(f => currentMap.get(f.path) !== f.mtime)
      const toRemove = current.filter(d => !next.has(d.path)).map(d => d.path)
      if (toRemove.length) this.searchEngine.removeFromPaths(toRemove)
      if (toAdd.length) await this.searchEngine.addFromPaths(toAdd.map(f => f.path))
      if (toRemove.length || toAdd.length) {
        console.debug(
          `Omnisearch: external reindex +${toAdd.length} -${toRemove.length}`
        )
      }
    } catch (e) {
      console.warn('Omnisearch: external reindex failed', e)
    }
  }

  private async populateIndex(): Promise<void> {
    console.time('Indexing total time')
    indexingStep.set(IndexingStepType.ReadingFiles)
    // 库外文件（虚拟文档树挂载）：ext: 伪路径与库内文件一起进 diff/索引。
    const extFiles = this.getExternalIndexableFiles()
    const files = [
      ...this.app.vault
        .getFiles()
        .filter(f => this.notesIndexer.isFileIndexable(f.path))
        .map(f => ({ path: f.path, mtime: f.stat.mtime })),
      ...extFiles,
    ].filter(f => this.notesIndexer.isFileIndexable(f.path))
    console.debug(`${files.length} files total (${extFiles.length} external)`)
    console.debug(`Cache is ${isCacheEnabled() ? 'enabled' : 'disabled'}`)
    // Map documents in the background
    // Promise.all(files.map(f => cacheManager.addToLiveCache(f.path)))

    const searchEngine = this.searchEngine
    if (isCacheEnabled()) {
      console.time('Loading index from cache')
      indexingStep.set(IndexingStepType.LoadingCache)
      const hasCache = await searchEngine.loadCache()
      if (hasCache) {
        console.timeEnd('Loading index from cache')
      }
    }

    const diff = searchEngine.getDocumentsToReindex(files)

    if (isCacheEnabled()) {
      if (diff.toAdd.length) {
        console.debug(
          'Total number of files to add/update: ' + diff.toAdd.length
        )
      }
      if (diff.toRemove.length) {
        console.debug(
          'Total number of files to remove: ' + diff.toRemove.length
        )
      }
    }

    if (diff.toAdd.length >= 1000 && isCacheEnabled()) {
      new Notice(
        `${diff.toAdd.length} files need to be indexed. Obsidian may experience stutters and freezes during the process`,
        10_000
      )
    }

    indexingStep.set(IndexingStepType.IndexingFiles)
    searchEngine.removeFromPaths(diff.toRemove.map(o => o.path))
    await searchEngine.addFromPaths(diff.toAdd.map(o => o.path))

    if ((diff.toRemove.length || diff.toAdd.length) && isCacheEnabled()) {
      indexingStep.set(IndexingStepType.WritingCache)

      // Disable settings.useCache while writing the cache, in case it freezes
      const cacheEnabled = this.settings.useCache
      if (cacheEnabled && !this.settings.DANGER_forceSaveCache) {
        this.settings.useCache = false
        await saveSettings(this)
      }

      // Write the cache
      await this.database.writeMinisearchCache()
      await this.embedsRepository.writeToCache()

      // Re-enable settings.caching
      if (cacheEnabled) {
        this.settings.useCache = true
        await saveSettings(this)
      }
    }

    console.timeEnd('Indexing total time')
    if (diff.toAdd.length >= 1000 && isCacheEnabled()) {
      new Notice(`Your files have been indexed.`)
    }
    indexingStep.set(IndexingStepType.Done)
    notifyOnIndexed()
  }
}

/**
 * Read the files and feed them to Minisearch
 */

async function cleanOldCacheFiles(app: App) {
  const toDelete = [
    `${app.vault.configDir}/plugins/omnisearch/searchIndex.json`,
    `${app.vault.configDir}/plugins/omnisearch/notesCache.json`,
    `${app.vault.configDir}/plugins/omnisearch/notesCache.data`,
    `${app.vault.configDir}/plugins/omnisearch/searchIndex.data`,
    `${app.vault.configDir}/plugins/omnisearch/historyCache.json`,
    `${app.vault.configDir}/plugins/omnisearch/pdfCache.data`,
  ]
  for (const item of toDelete) {
    if (await app.vault.adapter.exists(item)) {
      try {
        await app.vault.adapter.remove(item)
      } catch (e) {}
    }
  }
}
