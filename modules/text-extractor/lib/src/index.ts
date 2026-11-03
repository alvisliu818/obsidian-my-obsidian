/**
 * obsidian-text-extract 库的主入口文件
 * 提供从 PDF、图片（OCR）和 Office 文件中提取文本的核心功能
 * 支持缓存机制避免重复提取，并支持集中式和相邻式两种缓存存储模式
 */
import { pdfManager } from './pdf/pdf-manager'
import { officeManager } from './office/office-manager'
import { clearOCRWorkers, ocrManager } from './ocr/ocr-manager'
import { ocrLangs } from './ocr/ocr-langs'
import type { TFile } from 'obsidian'
import type { CacheLocation, OcrOptions } from './types'
import { pdfProcessQueue } from './globals'
import {
  convertOldCachePaths,
  getCacheBasePath,
  getCachePath,
  setCacheLocation,
  getCacheLocation,
  getSourceFilePathFromIndex,
  isAdjacentIndexFile,
  findAdjacentIndexFiles,
  findSourceFileByIndex,
  findAllSourceFilesByIndices,
  ADJACENT_CACHE_SUFFIX,
} from './cache'

/**
 * 从文件中提取文本
 * 根据文件类型自动选择对应的提取器（PDF / OCR / Office）
 * 在移动端，如果文本未缓存则返回空字符串
 * 如果文件类型不支持会抛出错误，调用前应先使用 canFileBeExtracted() 检查
 * @param file - 需要提取文本的 Obsidian 文件对象
 * @param options - OCR 选项配置，包含语言列表和是否使用系统 OCR
 * @returns 提取出的文本内容
 */
function extractText(
  file: TFile,
  options: Partial<OcrOptions>
): Promise<string> {
  const opts = Object.assign(
    {},
    { langs: ['eng'], useSystemOCR: false },
    options
  )

  if (isFilePDF(file.path)) {
    return pdfManager.getPdfText(file)
  } else if (isFileImage(file.path)) {
    return ocrManager.getImageText(file, opts)
  } else if (isFileOffice(file.path)) {
    return officeManager.getOfficeText(file)
  }
  throw new Error('File type not supported')
}

/**
 * 判断文件路径是否为 PDF 文件
 * @param path - 文件路径
 * @returns 是否为 PDF 文件
 */
function isFilePDF(path: string): boolean {
  return path.toLowerCase().endsWith('.pdf')
}

/**
 * 判断文件路径是否为图片文件
 * 支持 png、jpg、jpeg、webp、gif、bmp 格式
 * @param path - 文件路径
 * @returns 是否为图片文件
 */
function isFileImage(path: string): boolean {
  path = path.toLowerCase()
  return (
    path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') ||
    path.endsWith('.webp') || path.endsWith('.gif') || path.endsWith('.bmp')
  )
}

/**
 * 判断文件路径是否为 Office 文件
 * 支持 docx、xlsx 格式
 * @param path - 文件路径
 * @returns 是否为 Office 文件
 */
function isFileOffice(path: string): boolean {
  path = path.toLowerCase()
  return (
    path.endsWith('.docx') || path.endsWith('.xlsx')
  )
}

/**
 * 判断文件路径是否为支持的文件类型
 * @param filePath - 文件路径
 * @returns 是否为可提取文本的文件类型
 */
function canFileBeExtracted(filePath: string): boolean {
  return isFilePDF(filePath) || isFileImage(filePath) || isFileOffice(filePath)
}

/**
 * 获取 OCR 支持的语言列表
 * @returns 语言代码数组的类型
 */
function getOcrLangs(): typeof ocrLangs {
  return ocrLangs
}

/**
 * 清除处理队列
 * 停止所有待处理的文本提取任务
 */
function clearProcessQueue() {
  pdfProcessQueue.clear()
}

/**
 * 检查文件的提取结果是否已存在于缓存中
 * @param file - 需要检查的文件
 * @returns 缓存是否存在
 */
async function isInCache(file: TFile): Promise<boolean> {
  const path = getCachePath(file)
  return app.vault.adapter.exists(path.fullpath)
}

/**
 * 从缓存中移除指定文件的提取结果
 * @param file - 需要移除缓存的文件
 */
async function removeFromCache(file: TFile): Promise<void> {
  const path = getCachePath(file)
  if (await isInCache(file)) {
    return await app.vault.adapter.remove(path.fullpath)
  }
}

export {
  extractText,
  getOcrLangs,
  canFileBeExtracted,
  clearProcessQueue,
  isInCache,
  removeFromCache,
  getCacheBasePath,
  clearOCRWorkers,
  convertOldCachePaths,
  setCacheLocation,
  getCacheLocation,
  getSourceFilePathFromIndex,
  isAdjacentIndexFile,
  findAdjacentIndexFiles,
  findSourceFileByIndex,
  findAllSourceFilesByIndices,
  ADJACENT_CACHE_SUFFIX,
}
export type { CacheLocation }
