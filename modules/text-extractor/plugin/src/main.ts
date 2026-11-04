/**
 * Obsidian Text Extractor 插件主入口
 * 提供从 PDF、图片（OCR）和 Office 文件中提取文本的功能
 * 支持右键菜单操作、命令面板命令和 API 接口
 */
import { FileSystemAdapter, MenuItem, Notice, Platform, Plugin, TFile, App } from 'obsidian'
import { loadSettings, settings, TextExtractorSettingsTab } from './settings'
// 懒加载器：lib 2.7MB 拆独立懒包（lazy/text-extract.js），首次触碰才 require。
// 转发包装与 lib 同名，调用点零改动（见 lazyTextExtract.ts 文件头）。
import {
  canFileBeExtracted,
  extractText as _extractTextFn,
  isInCache,
  removeFromCache,
  configureLazyTextExtract,
  clearProcessQueue as clearLazyProcessQueue,
} from './lazyTextExtract'
import { createNote } from './utils'

/**
 * Text Extractor 插件的公开 API 接口
 * 其他插件可以通过此接口调用文本提取功能
 */
export type TextExtractorApi = {
  /** 提取文件文本内容 */
  extractText: (file: TFile) => Promise<string>
  /** 判断文件是否支持文本提取 */
  canFileBeExtracted: (filePath: string) => boolean
  /** 检查文件是否已缓存 */
  isInCache: (file: TFile) => Promise<boolean>
}

/**
 * Text Extractor 插件主类
 * 负责插件的生命周期管理、命令注册、菜单注册和设置管理
 */
export default class TextExtractorPlugin extends Plugin {
  /** 插件公开 API，供其他插件调用 */
  public api: TextExtractorApi = {
    async extractText(file: TFile): Promise<string> {
      const langs = settings.ocrLanguages
      const useSystemOCR = settings.useSystemOCR
      return await _extractTextFn(file, { langs, useSystemOCR })
    },
    canFileBeExtracted,
    isInCache,
  }

  /**
   * 插件加载时调用
   * 初始化设置、转换旧缓存、注册命令和菜单
   */
  async onload() {
    await loadSettings(this)

    // 懒包配置：cacheLocation 记 pending、迁移折进首触序列（见 lazyTextExtract.ts）
    // manifest.dir 是 vault 相对路径——懒包 require 需要绝对路径
		const adapter = this.app.vault.adapter as FileSystemAdapter
		configureLazyTextExtract({
			pluginDir: adapter.getFullPath(this.manifest.dir ?? ''),
			cacheLocation: settings.cacheLocation,
		})
    this.addSettingTab(new TextExtractorSettingsTab(this))

    // 注册命令：提取文本到剪贴板
    this.addCommand({
      id: "extract-to-clipboard",
      name: "Extract text to clipboard",
      callback: () => {
        const file = getActiveFile(this.app)
        if (file != null && canFileBeExtracted(file.path)) {
          extractToClipboard(file);
        }
      },
    });

    // 注册命令：提取文本到新笔记
    this.addCommand({
      id: "extract-to-new-note",
      name: "Extract text into a new note",
      callback: () => {
        const file = getActiveFile(this.app)
        if (file != null && canFileBeExtracted(file.path)) {
          extractToNewNote(file);
        }
      },
    });

    // 注册右键菜单
    this.registerEvent(
      app.workspace.on('file-menu', (menu, file, _source) => {
        if (file instanceof TFile && canFileBeExtracted(file.path)) {
          if (Platform.isDesktopApp) {
            menu.addItem((item: MenuItem) => {
              item.setTitle('Text Extractor')
              const submenu = item.setSubmenu()

              // 复制到剪贴板
              submenu.addItem(item => {
                item
                  .setTitle('Extract Text to clipboard')
                  .setIcon('clipboard-copy')
                  .onClick(async () => {
                    extractToClipboard(file)
                  })
              })

              // 创建新笔记
              submenu.addItem(item => {
                item
                  .setTitle('Extract text into a new note')
                  .setIcon('document')
                  .onClick(async () => {
                    extractToNewNote(file)
                  })
              })

              // 清除缓存
              if (Platform.isDesktopApp) {
                submenu.addSeparator()
                submenu.addItem(item => {
                  item
                    .setTitle('Clear cache for this file')
                    .setIcon('trash')
                    .onClick(async () => {
                      await removeFromCache(file)
                      new Notice(
                        `Text Extractor - Removed ${file.path} from cache`
                      )
                    })
                })
              }
            })
          } else {
            // 移动端只提供创建新笔记选项
            menu.addItem(item => {
              item
                .setTitle('Extract text into a new note')
                .setIcon('document')
                .onClick(async () => {
                  extractToNewNote(file)
                })
            })
          }
        }
      })
    )
  }

  /**
   * 插件卸载时调用
   * 清除所有处理队列中的待处理任务
   */
  onunload() {
    clearLazyProcessQueue()
  }
}

/**
 * 提取文本并显示通知
 * 如果文件未缓存，显示"正在提取"提示
 * @param file - 需要提取文本的文件
 * @returns 提取出的文本内容
 */
async function extractTextWithNotice(file: TFile) {
  if (!(await isInCache(file))) {
    new Notice(
      `Text Extractor - Extracting text from file ${file.path}, please wait...`
    )
  }
  try {
    const langs = settings.ocrLanguages
    const useSystemOCR = settings.useSystemOCR
    return await _extractTextFn(file, { langs, useSystemOCR })
  } catch (e) {
    new Notice(`Text Extractor - Error extracting text from file ${file.path}`)
    throw e
  }
}

/**
 * 提取文本并复制到剪贴板
 * @param file - 需要提取文本的文件
 */
async function extractToClipboard(file: TFile) {
  const { clipboard } = require('electron')
  const text = await extractTextWithNotice(file)
  await clipboard.writeText(text)
  new Notice('Text Extractor - Text copied to clipboard')
}

/**
 * 提取文本并创建新笔记
 * 新笔记包含提取的文本和原文件的嵌入链接
 * @param file - 需要提取文本的文件
 */
async function extractToNewNote(file: TFile) {
  let contents = await extractTextWithNotice(file)
  contents = `${contents}\n\n![[${file.path}]]`
  await createNote(file.path, contents)
}

/**
 * 获取当前活动文件
 * 优先从活动编辑器获取，回退到工作区活动文件
 * @param app - Obsidian App 实例
 * @returns 当前活动文件，不存在则返回 null
 */
function getActiveFile(app: App): TFile | null {
  return app.workspace.activeEditor?.file ?? app.workspace.getActiveFile();
}
