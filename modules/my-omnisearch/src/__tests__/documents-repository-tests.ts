import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Notice, TFile } from './obsidian-stub'
import type * as ObsidianStub from './obsidian-stub'
import { DocumentsRepository } from '../repositories/documents-repository'

// getExternalIndexedDocument 用 eval('require')('fs') 读盘。vitest 的 ESM
// 环境里没有 require（Obsidian 渲染进程里本来就有），补一个全局的。
const requireFn = createRequire(import.meta.url)
;(globalThis as { require?: unknown }).require ??= requireFn

type FakeEntry = { content?: string; readError?: Error }

/** 造一个只带 DocumentsRepository 所需最小面的 plugin。 */
function makeRepository(entries: Map<string, FakeEntry>): DocumentsRepository {
  const vault = {
    getAbstractFileByPath(path: string): TFile | null {
      return entries.has(path)
        ? new TFile(path, { mtime: 1, ctime: 1, size: 1 })
        : null
    },
    async cachedRead(file: TFile): Promise<string> {
      const entry = entries.get(file.path)
      if (!entry) {
        throw Object.assign(
          new Error(`ENOENT: no such file, open '${file.path}'`),
          { code: 'ENOENT' }
        )
      }
      if (entry.readError) throw entry.readError
      return entry.content ?? ''
    },
  }
  const plugin = {
    app: {
      vault,
      metadataCache: { getFileCache: () => null },
    },
    embedsRepository: { refreshEmbedsForNote: () => {} },
    notesIndexer: { isFilePlaintext: (path: string) => path.endsWith('.md') },
    settings: { displayTitle: '' },
    getTextExtractor: () => undefined,
    getAIImageAnalyzer: () => undefined,
  }
  return new DocumentsRepository(
    plugin as unknown as ConstructorParameters<typeof DocumentsRepository>[0]
  )
}

describe('DocumentsRepository', () => {
  beforeEach(() => {
    Notice.instances.length = 0
  })

  it('indexes a readable vault file', async () => {
    // Arrange
    const repo = makeRepository(
      new Map([['notes/a.md', { content: 'hello world' }]])
    )

    // Act
    const doc = await repo.getDocument('notes/a.md')

    // Assert
    expect(doc.path).toBe('notes/a.md')
    expect(doc.content).toBe('hello world')
    expect(Notice.instances).toHaveLength(0)
  })

  it('skips a vanished vault file (stale index entry) without any warning', async () => {
    // 库外进程静默删除（adapter.remove 绕过 vault 事件）留下的陈旧条目：
    // getAbstractFileByPath 返回 null，应静默自愈，不能计 countError。
    const repo = makeRepository(new Map())

    const doc = await repo.getDocument('notes/gone.md')

    expect(doc).toBeUndefined()
    expect(Notice.instances).toHaveLength(0)
  })

  it('skips a transiently locked vault file (EBUSY) without any warning', async () => {
    // 百度盘等网盘挂载下，客户端锁定/替换文件会让 cachedRead 抛
    // EBUSY/EPERM/ENOENT——瞬态故障，同样不能计 countError。
    const busy = Object.assign(new Error('EBUSY: resource busy or locked'), {
      code: 'EBUSY',
    })
    const repo = makeRepository(
      new Map([['notes/locked.md', { readError: busy }]])
    )

    const doc = await repo.getDocument('notes/locked.md')

    expect(doc).toBeUndefined()
    expect(Notice.instances).toHaveLength(0)
  })

  it('does not accumulate the cache warning across many failures in one session', async () => {
    // 回归「修改未保存→关标签页→弹 Omnisearch 缓存告警」：
    // 旧实现里每次失败双计（addDocument catch + getDocument 各一次），
    // 且计数器只衰减一次——会话内攒够 5 次就误报。
    const entries = new Map<string, FakeEntry>()
    for (let i = 0; i < 8; i++) {
      entries.set(`notes/gone-${i}.md`, { readError: new Error('EPERM') })
    }
    const repo = makeRepository(entries)

    for (let i = 0; i < 8; i++) {
      expect(await repo.getDocument(`notes/gone-${i}.md`)).toBeUndefined()
    }

    expect(Notice.instances).toHaveLength(0)
  })

  it('keeps the empty-shell contract for unreadable external files', async () => {
    // ext: 库外文件读不到时给空壳文档（既有契约，防止搜索整体崩掉）。
    const repo = makeRepository(new Map())

    const doc = await repo.getDocument('ext:/no/such/dir/locked.md')

    expect(doc).toBeDefined()
    expect(doc.path).toBe('ext:/no/such/dir/locked.md')
    expect(doc.content).toBe('')
    expect(Notice.instances).toHaveLength(0)
  })

  it('indexes a readable external file', async () => {
    const dir = join(tmpdir(), `omnisearch-ext-test-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    const abs = join(dir, 'outside.md')
    writeFileSync(abs, 'external content', 'utf8')
    try {
      const repo = makeRepository(new Map())

      const doc = await repo.getDocument(`ext:${abs.replace(/\\/g, '/')}`)

      expect(doc.content).toBe('external content')
      expect(Notice.instances).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('countError', () => {
  it('does not warn when failures are spread out over time', async () => {
    // 回归：旧实现的 setTimeout 只跑一次（计数器全程最多减 1），
    // 「1 秒内 3 次错误」的语义退化成「整个会话累计 5 次」——
    // 每秒 1 次的瞬态失败攒够数就弹「请清理缓存」。改为每秒衰减后
    // 这种速率永远凑不满阈值。
    vi.resetModules()
    vi.useFakeTimers()
    try {
      const obsidian = (await import('obsidian')) as unknown as typeof ObsidianStub
      const { countError } = await import('../tools/utils')
      for (let i = 0; i < 12; i++) {
        countError()
        vi.advanceTimersByTime(1100)
      }
      expect(obsidian.Notice.instances).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('warns when 5 failures happen within the same second', async () => {
    // 真正的突发错误（1 秒内 5 次）仍然要告警——安全网不能丢。
    vi.resetModules()
    const obsidian = (await import('obsidian')) as unknown as typeof ObsidianStub
    const { countError } = await import('../tools/utils')

    for (let i = 0; i < 5; i++) countError()

    expect(obsidian.Notice.instances).toHaveLength(1)
    expect(obsidian.Notice.instances[0].message).toContain(
      'There might be an issue with your cache'
    )
  })
})
