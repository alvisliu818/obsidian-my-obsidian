import type { TFile } from 'obsidian'
import { libVersion } from './globals'
import type { CacheLocation, ExtractedText } from './types'
import { makeMD5 } from './utils'

/**
 * 相邻缓存文件的后缀名
 * 当缓存模式为 'adjacent' 时，缓存文件命名为 {原文件名}{ADJACENT_CACHE_SUFFIX}
 */
export const ADJACENT_CACHE_SUFFIX = '.text-extractor.json'

/**
 * 当前缓存位置模式，默认为集中式存储
 * 可通过 setCacheLocation() 修改
 */
let cacheLocation: CacheLocation = 'centralized'

/**
 * 设置缓存文件存放位置模式
 * @param location - 'centralized' 集中式 | 'adjacent' 相邻式
 */
export function setCacheLocation(location: CacheLocation): void {
  cacheLocation = location
}

/**
 * 获取当前缓存位置模式
 * @returns 当前缓存位置模式
 */
export function getCacheLocation(): CacheLocation {
  return cacheLocation
}

/**
 * 获取集中式缓存的基础路径
 * 所有缓存文件统一存放在 .obsidian/plugins/text-extractor/cache/ 目录下
 * @returns 集中式缓存的根目录路径
 */
export function getCacheBasePath(): string {
  return `${app.vault.configDir}/plugins/text-extractor/cache`
}

/**
 * 将旧版缓存路径转换为新格式
 * 旧版缓存按子目录组织，新版统一放在 cache 根目录下，文件名为 MD5 哈希值
 */
export async function convertOldCachePaths(): Promise<void> {
  const cachePath = getCacheBasePath()
  try {
    const paths = await app.vault.adapter.list(cachePath)
    for (const dir of paths.folders) {
      const files = await app.vault.adapter.list(dir)
      for (const file of files.files) {
        const hash = file.split('-').pop()?.split('.').shift()
        if (hash) {
          const newPath = `${cachePath}/${hash}.json`
          await app.vault.adapter.rename(file, newPath)
        }
      }
    }
  } catch (e) {
    // 没有旧路径需要转换，忽略错误
  }
}

/**
 * 获取集中式缓存路径信息
 * 缓存文件名使用文件路径的 MD5 哈希值，存放在集中式缓存根目录下
 * @param file - 需要提取文本的文件
 * @returns 包含文件夹路径、文件名和完整路径的对象
 */
function getCentralizedCachePath(file: TFile): {
  filename: string
  folder: string
  fullpath: string
} {
  const hash = makeMD5(file.path)
  const folder = getCacheBasePath()
  const filename = `${hash}.json`
  return {
    folder,
    filename,
    fullpath: `${folder}/${filename}`,
  }
}

/**
 * 获取相邻式缓存路径信息
 * 缓存文件放在被索引文件的同一目录下，文件名为 {原文件名}.text-extractor.json
 * 例如：对于 photos/image.png，缓存路径为 photos/image.png.text-extractor.json
 * @param file - 需要提取文本的文件
 * @returns 包含文件夹路径、文件名和完整路径的对象
 */
function getAdjacentCachePath(file: TFile): {
  filename: string
  folder: string
  fullpath: string
} {
  const folder = file.parent?.path ?? ''
  const filename = `${file.name}${ADJACENT_CACHE_SUFFIX}`
  return {
    folder,
    filename,
    fullpath: folder ? `${folder}/${filename}` : filename,
  }
}

/**
 * 根据当前缓存位置模式获取缓存路径信息
 * 自动根据 cacheLocation 设置选择集中式或相邻式路径
 * @param file - 需要提取文本的文件
 * @returns 包含文件夹路径、文件名和完整路径的对象
 */
export function getCachePath(file: TFile): {
  filename: string
  folder: string
  fullpath: string
} {
  // if (cacheLocation === 'adjacent') {
  //   return getAdjacentCachePath(file)
  // }
  // return getCentralizedCachePath(file)
  return getAdjacentCachePath(file)
}

/**
 * 读取文件的缓存数据
 * 如果缓存文件存在则返回解析后的 ExtractedText 对象，否则返回 null
 * @param file - 需要读取缓存的文件
 * @returns 缓存的提取文本数据，不存在则返回 null
 */
export async function readCache(file: TFile): Promise<ExtractedText | null> {
  const cachePath = getCachePath(file)

  if (await app.vault.adapter.exists(cachePath.fullpath)) {
    const raw = await app.vault.adapter.read(cachePath.fullpath)
    return JSON.parse(raw) as ExtractedText
  }
  return null
}

/**
 * 将提取的文本写入缓存
 * @param folder - 缓存文件所在目录
 * @param filename - 缓存文件名
 * @param text - 提取出的文本内容
 * @param ogPath - 被提取文件的原始路径
 * @param langs - OCR 使用的语言字符串
 */
export async function writeCache(
  folder: string,
  filename: string,
  text: string,
  ogPath: string,
  langs: string
): Promise<void> {
  const path = folder === "/" ? `/${filename}` : `${folder}/${filename}`
  const data: ExtractedText = {
    path: ogPath,
    text,
    libVersion,
    langs,
  }
  return await app.vault.adapter.write(path, JSON.stringify(data))
}

/**
 * 根据索引文件（缓存文件）路径推算出被索引的原始文件路径
 * 仅在相邻缓存模式下有效，通过去除 .text-extractor.json 后缀得到原始文件路径
 * @param indexPath - 索引文件的完整路径，如 "photos/image.png.text-extractor.json"
 * @returns 被索引文件的路径，如 "photos/image.png"；如果不是有效的索引文件路径则返回 null
 */
export function getSourceFilePathFromIndex(indexPath: string): string | null {
  if (!indexPath.endsWith(ADJACENT_CACHE_SUFFIX)) {
    return null
  }
  return indexPath.slice(0, -ADJACENT_CACHE_SUFFIX.length)
}

/**
 * 判断给定路径是否为相邻模式的索引文件
 * @param filePath - 待判断的文件路径
 * @returns 如果是索引文件返回 true，否则返回 false
 */
export function isAdjacentIndexFile(filePath: string): boolean {
  return filePath.endsWith(ADJACENT_CACHE_SUFFIX)
}

/**
 * 搜索指定目录下的所有相邻模式索引文件
 * 递归遍历目录，找出所有 .text-extractor.json 文件
 * @param dirPath - 要搜索的目录路径，默认为 vault 根目录
 * @returns 索引文件路径数组
 */
export async function findAdjacentIndexFiles(
  dirPath?: string
): Promise<string[]> {
  const basePath = dirPath ?? '/'
  const result: string[] = []

  try {
    const listed = await app.vault.adapter.list(basePath)
    for (const file of listed.files) {
      if (isAdjacentIndexFile(file)) {
        result.push(file)
      }
    }
    for (const folder of listed.folders) {
      const subResults = await findAdjacentIndexFiles(folder)
      result.push(...subResults)
    }
  } catch (e) {
    // 目录不存在或无法访问，忽略
  }

  return result
}

/**
 * 根据索引文件搜索并返回被索引文件的路径
 * 在相邻模式下，通过索引文件的相对位置定位被索引文件
 * @param indexPath - 索引文件路径
 * @returns 被索引文件路径，如果索引文件无效或被索引文件不存在则返回 null
 */
export async function findSourceFileByIndex(
  indexPath: string
): Promise<string | null> {
  const sourcePath = getSourceFilePathFromIndex(indexPath)
  if (!sourcePath) {
    return null
  }

  const exists = await app.vault.adapter.exists(sourcePath)
  return exists ? sourcePath : null
}

/**
 * 批量搜索索引文件并返回对应的被索引文件路径映射
 * @param dirPath - 要搜索的目录路径，默认为 vault 根目录
 * @returns 索引文件路径到被索引文件路径的映射
 */
export async function findAllSourceFilesByIndices(
  dirPath?: string
): Promise<Map<string, string>> {
  const indexFiles = await findAdjacentIndexFiles(dirPath)
  const mapping = new Map<string, string>()

  for (const indexPath of indexFiles) {
    const sourcePath = await findSourceFileByIndex(indexPath)
    if (sourcePath) {
      mapping.set(indexPath, sourcePath)
    }
  }

  return mapping
}
