import type { ResultNote } from '../globals'
import { Query } from '../search/query'
import type OmnisearchPlugin from '../main'
import { OmnisearchVaultModal } from '../components/modals'

type ResultNoteApi = {
  score: number
  vault: string
  path: string
  basename: string
  foundWords: string[]
  matches: SearchMatchApi[]
  excerpt: string
}

export type SearchMatchApi = {
  match: string
  offset: number
}

let notified = false

/**
 * Callbacks to be called when the search index is ready
 */
let onIndexedCallbacks: Array<() => void> = []

function mapResults(
  plugin: OmnisearchPlugin,
  results: ResultNote[]
): ResultNoteApi[] {
  return results.map(result => {
    const { score, path, basename, foundWords, matches, content } = result

    const excerpt = plugin.textProcessor.makeExcerpt(
      content,
      matches[0]?.offset ?? -1
    )

    const res: ResultNoteApi = {
      score,
      vault: plugin.app.vault.getName(),
      path,
      basename,
      foundWords,
      matches: matches.map(match => {
        return {
          match: match.match,
          offset: match.offset,
        }
      }),
      excerpt: excerpt,
    }

    return res
  })
}

export function notifyOnIndexed(): void {
  notified = true
  onIndexedCallbacks.forEach(cb => cb())
}

let registed = false

export function registerAPI(plugin: OmnisearchPlugin): void {
  if (registed) {
    return
  }
  registed = true

  // Url scheme for obsidian://omnisearch?query=foobar
  plugin.registerObsidianProtocolHandler('omnisearch', params => {
    new OmnisearchVaultModal(plugin, params.query).open()
  })

  const api = getApi(plugin)

  // Public api
  // @ts-ignore
  globalThis['omnisearch'] = api
  // 合并进 obsidian-my-obsidian 后的时序坑：宿主要把旧插件 id 挂回
  // plugins.plugins，但那发生在 onload **完成之后**，而这里在 onload 中间——
  // 此刻 plugins.plugins.omnisearch 还不存在，直接赋值会 TypeError（且模块级
  // 的 registed 已置位，重试也救不回来）。api 挂在插件实例上：宿主别名挂回的
  // 正是这个实例，`plugins.plugins.omnisearch.api` 随之可读；独立插件场景下
  // 表里本来就有自己，直接挂。
  const self = plugin as unknown as { api?: unknown }
  self.api = api
  const table = (plugin.app as unknown as { plugins?: { plugins?: Record<string, { api?: unknown }> } })
    .plugins?.plugins
  if (table?.omnisearch) {
    table.omnisearch.api = api
  }
}

export function getApi(plugin: OmnisearchPlugin) {
  return {
    async search(q: string): Promise<ResultNoteApi[]> {
      const query = new Query(q, {
        ignoreDiacritics: plugin.settings.ignoreDiacritics,
        ignoreArabicDiacritics: plugin.settings.ignoreArabicDiacritics,
      })
      const raw = await plugin.searchEngine.getSuggestions(query)
      return mapResults(plugin, raw)
    },
    registerOnIndexed(cb: () => void): void {
      onIndexedCallbacks.push(cb)
      // Immediately call the callback if the indexing is already ready done
      if (notified) {
        cb()
      }
    },
    unregisterOnIndexed(cb: () => void): void {
      onIndexedCallbacks = onIndexedCallbacks.filter(o => o !== cb)
    },
    refreshIndex: plugin.notesIndexer.refreshIndex,
  }
}
