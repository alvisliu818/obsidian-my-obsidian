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
	): Promise<{ bkey: string; path: string; blockId: string; text: string }[]>
	scan(
		pattern: string,
		excludePath?: string,
		limit?: number,
	): Promise<{ bkey: string; path: string; text: string }[]>
	extSearch(
		tokens: string[],
		not?: string[],
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

const VAULT_LIMIT = 30
const EXT_LIMIT = 15
/** scan 交集的单 token 拉取上限：放大给多 token 交集留余量 */
const SCAN_FETCH = 500

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

/**
 * 查询守护进程并转成 ResultNote。任何失败（daemon 未起/超时/协议错）都
 * 返回空数组——调用方把结果原样并进 minisearch，绝不因此阻塞搜索。
 */
export async function searchIndexDaemon(
	plugin: OmnisearchPlugin,
	query: Query,
): Promise<ResultNote[]> {
	const daemon = getIndexDaemon(plugin)
	if (!daemon) return []

	// 正项 = 文本词（含 #tag——块/ext 文本里 tag 就是 "#x" 字面）；负项 = 排除词。
	// omnisearch 的 Query 构造时已按设置做过 diacritics 归一，这里直接复用。
	const tokens = query.query.text.filter(Boolean)
	if (!tokens.length) return []
	const excludes = query.query.exclude.text ?? []

	const out: ResultNote[] = []
	let score = 0

	// ---- vault 域：块级命中（trigram 子串） ----
	try {
		let rows: { bkey: string; path: string; text: string }[]
		if (tokens.every(t => t.length >= 3)) {
			// FTS5 的 NOT 是二元运算符：正项 AND 连接，排除项二目 NOT 追加尾部
			const match =
				tokens.map(quote).join(' AND ') +
				excludes.map(n => ' NOT ' + quote(n)).join('')
			const hits = await daemon.ftsSearch(match, '', VAULT_LIMIT)
			rows = hits.map(h => ({ bkey: h.bkey, path: h.path, text: h.text }))
		} else {
			// trigram 物理限制：<3 字符的 term MATCH 不中（中文两字词极常见）
			// ——整条查询改走 scan/LIKE 逐 token 交集，排除项客户端过滤
			let base: Map<string, { bkey: string; path: string; text: string }> | null =
				null
			for (const t of tokens) {
				const rows = await daemon.scan(t, '', SCAN_FETCH)
				const m = new Map(rows.map(r => [r.bkey, r]))
				if (base === null) base = m
				else for (const k of [...base.keys()]) if (!m.has(k)) base.delete(k)
				if (base.size === 0) break
			}
			rows = [...(base ?? new Map()).values()].filter(
				h => !excludes.some(n => h.text.toLowerCase().includes(n.toLowerCase())),
			)
		}
		// 同文件多块命中只留一条（打开都落在文件级），并按路径过滤
		const seen = new Set<string>()
		for (const row of filterHits(rows, query)) {
			if (seen.has(row.path) || isExternalDocPath(row.path)) continue
			seen.add(row.path)
			out.push(
				toResultNote(plugin, query, row.path, row.text, --score),
			)
			if (out.length >= VAULT_LIMIT) break
		}
	} catch (e) {
		logVerbose('Omnisearch - index daemon vault search failed', e)
	}

	// ---- ext 域：挂载库外文件（daemon 侧整文件一行，token 交集在服务端） ----
	try {
		const hits = await daemon.extSearch(tokens, excludes, EXT_LIMIT)
		let count = 0
		for (const hit of filterHits(hits, query)) {
			// daemon 的 ext 命中 path 是绝对路径 → 转 omnisearch 的 ext: 伪路径
			// （toExternalDocPath 同时把反斜杠归一成斜杠），打开路由
			// （openNote → logseq openExternalEntry）随之复用
			const pseudoPath = toExternalDocPath(hit.path)
			out.push(
				toResultNote(plugin, query, pseudoPath, hit.text, --score),
			)
			if (++count >= EXT_LIMIT) break
		}
	} catch (e) {
		logVerbose('Omnisearch - index daemon ext search failed', e)
	}

	return out
}
