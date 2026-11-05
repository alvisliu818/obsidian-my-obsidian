/**
 * 统一索引守护进程的查询桥（合并新增）。
 *
 * 守护进程由 logseq 模块拉起（BlockIndexDaemonClient：better-sqlite3 +
 * FTS5 trigram，独立 node 进程），本文件让 omnisearch 成为它的又一个
 * **只读**查询方：把 omnisearch 的 Query 翻译成 daemon 的 tokens/exclude，
 * 拿回 vault 块命中（blocks_fts）与 ext 域命中（ext_fts，挂载库外文件），
 * 转成 ResultNote 去重后并进 minisearch 结果。
 *
 * 为什么值得并：minisearch 对 CJK 是分词级匹配（cm-chs-patch 缺席时整段
 * 中文是一个 token），两字子串搜不到；daemon 的 trigram 天生子串命中，
 * 中文毫秒级。daemon 命中只**补充** minisearch 没返回的文件，不改变引擎
 * 自身的排序语义——纯增益，缺了它（daemon 没起/模块关闭）一切照旧。
 *
 * 分工纪律：unified-search 是 daemon 的设置面与 ext 域**推送方**（setExt
 * 是整表替换）；omnisearch 绝不调 setExt——两处都推会在 daemon 侧互相
 * 覆盖清单。本桥只调查询类 op，daemon 不在时静默返回空。
 */
import type { ResultNote } from '../globals'
import type { Query } from '../search/query'
import type OmnisearchPlugin from '../main'
import { isExternalDocPath, toExternalDocPath } from './externalDocs'
import { logVerbose } from './utils'

/** daemon 客户端的本桥所需最小面（结构化类型，避免跨模块类型耦合）。 */
interface DaemonLike {
	ftsSearch(
		match: string,
		excludePath?: string,
		limit?: number,
		onlyPath?: string,
	): Promise<{ bkey: string; path: string; blockId: string; text: string }[]>
	scan(
		pattern: string,
		excludePath?: string,
		limit?: number,
		onlyPath?: string,
	): Promise<{ bkey: string; path: string; text: string }[]>
	extSearch(
		tokens: string[],
		not?: string[],
		limit?: number,
	): Promise<{ path: string; text: string }[]>
	/** 文件名/标签域:tokens 全子串命中文件路径,tags 反查含标签文件（2026-11-04）。 */
	nameSearch(
		tokens: string[],
		tags?: string[],
		limit?: number,
	): Promise<{ path: string; text: string }[]>
}

/**
 * 取 logseq 模块拉起的守护进程客户端（与 unified-search 的取法同一条路：
 * 宿主 live map → logseq 实例 → daemonIndex）。桌面端专用；不在即 null。
 */
export function getIndexDaemon(plugin: OmnisearchPlugin): DaemonLike | null {
	if (!plugin.app.vault.adapter) return null
	try {
		const host = (
			plugin.app as unknown as {
				plugins?: { plugins?: Record<string, { live?: Map<string, unknown> }> }
			}
		).plugins?.plugins?.['obsidian-my-obsidian']
		const lg = host?.live?.get('logseq') as
			| { daemonIndex?: DaemonLike | null }
			| undefined
		return lg?.daemonIndex ?? null
	} catch {
		return null
	}
}

/** FTS5 MATCH 的安全引用（内部引号转义 ""），用户输入永不直通语法面。 */
function quote(term: string): string {
	return '"' + term.replace(/"/g, '""') + '"'
}

/** 命中行路径过滤：path:/ext: 与 minisearch 侧同语义（子串/扩展名前缀）。 */
function filterHits<T extends { path: string }>(
	hits: T[],
	query: Query,
): T[] {
	let out = hits
	if (query.query.path?.length) {
		const subs = query.query.path.map(p => p.toLowerCase())
		out = out.filter(h => {
			const p = h.path.toLowerCase()
			return subs.every(s => p.includes(s))
		})
	}
	if (query.query.exclude?.path?.length) {
		const subs = query.query.exclude.path.map(p => p.toLowerCase())
		out = out.filter(h => {
			const p = h.path.toLowerCase()
			return !subs.some(s => p.includes(s))
		})
	}
	if (query.query.ext?.length) {
		out = out.filter(h => {
			const ext = '.' + (h.path.split('.').pop() ?? '')
			return query.query.ext?.some(e => ext.startsWith(e.startsWith('.') ? e : '.' + e))
		})
	}
	return out
}

/** 去掉扩展名的文件名（与 minisearch 侧 basename 语义一致）。 */
function basenameOf(path: string): string {
	const name = path.split('/').pop() ?? path
	const dot = name.lastIndexOf('.')
	return dot > 0 ? name.slice(0, dot) : name
}

function toResultNote(
	plugin: OmnisearchPlugin,
	query: Query,
	path: string,
	content: string,
	score: number,
): ResultNote {
	const foundWords = [
		...query.query.text,
		...query.getExactTerms(),
	]
	const matches = plugin.textProcessor.getMatches(content, foundWords, query)
	return {
		score,
		path,
		basename: basenameOf(path),
		displayTitle: '',
		content,
		foundWords,
		matches,
		isEmbed: false,
	}
}

// ---------------------------------------------------------------------------
// 统一索引模式（2026-11-04）:daemon 的磁盘 sqlite 是唯一索引。
//
// useIndexDaemon 打开时,渲染进程不再构建 minisearch/documents（主库 5.5 万
// 文件的全量索引曾耗 1h+ CPU、数百 MB 堆——见 main.ts populateIndex 的同日
// 门控）。搜索全部走本函数:文件名/标签域（nameSearch,强信号排前）+ 内容域
// （trigram 子串,两字符也能查）+ ext 域（挂载库外文件）。
//
// 返回 null 表示 daemon 不可用——调用方落回本地索引路径（统一模式下本地
// 索引为空,即空结果;daemon 由 logseq 模块自动拉起/重启,离线窗口只在
// 启动头几秒）。
// ---------------------------------------------------------------------------
export async function searchIndexDaemonUnified(
	plugin: OmnisearchPlugin,
	query: Query,
	singleFilePath?: string,
): Promise<ResultNote[] | null> {
	const daemon = getIndexDaemon(plugin)
	if (!daemon) return null

	try {
		const tokens = query.query.text.filter(Boolean)
		// '#tag' 形式的词:内容域按字面查（块文本里 tag 就是 "#x"）,文件名域
		// 同时剥前缀走 tags 表反查
		const tagNames = [
			...new Set(
				[...query.getTags(), ...tokens.filter(t => t.startsWith('#'))]
					.map(t => t.replace(/^#/, ''))
					.filter(Boolean),
			),
		]
		const excludes = query.query.exclude.text ?? []

		// ---- 文件内搜索:单文件内容域（daemon 侧 onlyPath 限定） ----
		if (singleFilePath) {
			let rows: { path: string; text: string }[]
			if (tokens.length && tokens.every(t => t.length >= 3)) {
				const match =
					tokens.map(quote).join(' AND ') +
					excludes.map(n => ' NOT ' + quote(n)).join('')
				const hits = await daemon.ftsSearch(match, '', 50, singleFilePath)
				rows = hits.map(h => ({ path: h.path, text: h.text }))
			} else if (tokens.length) {
				// 多 token 单文件:逐 token scan(onlyPath)取交集
				let base: Map<string, { path: string; text: string }> | null = null
				for (const t of tokens) {
					const rowsT = await daemon.scan(t, '', 500, singleFilePath)
					const m = new Map(rowsT.map(r => [r.path, r]))
					if (base === null) base = m
					else for (const k of [...base.keys()]) if (!m.has(k)) base.delete(k)
					if (base.size === 0) break
				}
				rows = [...(base ?? new Map()).values()]
			} else {
				return []
			}
			return rows
				.filter(h => !excludes.some(n => h.text.toLowerCase().includes(n.toLowerCase())))
				.map((h, i) => toResultNote(plugin, query, h.path, h.text, -i))
		}

		if (!tokens.length && !tagNames.length) return []

		const out: ResultNote[] = []
		const seen = new Set<string>()
		const push = (note: ResultNote): boolean => {
			if (seen.has(note.path)) return false
			seen.add(note.path)
			out.push(note)
			return true
		}

		// ---- 文件名/标签域（强信号,排最前） ----
		try {
			const nameHits = filterHits(
				await daemon.nameSearch(tokens.filter(t => !t.startsWith('#')), tagNames, 30),
				query,
			)
			let score = 1000
			for (const hit of nameHits) {
				if (!push(toResultNote(plugin, query, hit.path, hit.text, score--))) continue
				if (out.length >= 30) break
			}
		} catch (e) {
			logVerbose('Omnisearch - unified name search failed', e)
		}

		// ---- 内容域:vault 块级（trigram 子串） ----
		try {
			let rows: { path: string; text: string }[]
			if (tokens.length && tokens.every(t => t.length >= 3)) {
				const match =
					tokens.map(quote).join(' AND ') +
					excludes.map(n => ' NOT ' + quote(n)).join('')
				const hits = await daemon.ftsSearch(match, '', 30)
				rows = hits.map(h => ({ path: h.path, text: h.text }))
			} else if (tokens.length) {
				let base: Map<string, { bkey: string; path: string; text: string }> | null = null
				for (const t of tokens) {
					const rowsT = await daemon.scan(t, '', 500)
					const m = new Map(rowsT.map(r => [r.bkey, r]))
					if (base === null) base = m
					else for (const k of [...base.keys()]) if (!m.has(k)) base.delete(k)
					if (base.size === 0) break
				}
				rows = [...(base ?? new Map()).values()].filter(
					h => !excludes.some(n => h.text.toLowerCase().includes(n.toLowerCase())),
				)
			} else {
				rows = []
			}
			let score = 0
			for (const row of filterHits(rows, query)) {
				if (isExternalDocPath(row.path)) continue
				if (!push(toResultNote(plugin, query, row.path, row.text, --score))) continue
				if (out.length >= 60) break
			}
		} catch (e) {
			logVerbose('Omnisearch - unified content search failed', e)
		}

		// ---- ext 域：挂载库外文件 ----
		try {
			const hits = filterHits(await daemon.extSearch(tokens, excludes, 15), query)
			let count = 0
			for (const hit of hits) {
				const pseudoPath = toExternalDocPath(hit.path)
				if (!push(toResultNote(plugin, query, pseudoPath, hit.text, -100 - count))) continue
				if (++count >= 15) break
			}
		} catch (e) {
			logVerbose('Omnisearch - unified ext search failed', e)
		}

		// hideExcluded:Obsidian 排除文件直接过滤（与 minisearch 侧同语义）
		if (plugin.settings.hideExcluded) {
			const isIgnored = plugin.app.metadataCache.isUserIgnored?.bind(plugin.app.metadataCache)
			if (isIgnored) return out.filter(r => !isIgnored(r.path))
		}
		return out
	} catch (e) {
		logVerbose('Omnisearch - unified index search failed, falling back', e)
		return null
	}
}
