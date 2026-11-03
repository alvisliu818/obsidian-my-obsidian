/**
 * 全局常量和配置
 * 定义库版本号、工作进程数量、处理队列和超时时间等
 */
import { Platform } from 'obsidian'
import data from '../package.json'
import PQueue from 'p-queue'

/** 当前库版本号，从 package.json 读取 */
export const libVersion = data.version

/** 系统 CPU 核心数，移动端固定为 1 */
const cpuCount = Platform.isMobileApp ? 1 : require('os').cpus().length

/** OCR 后台工作进程数量，CPU ≤ 2 时为 1，否则为 2 */
const ocrBackgroundProcesses = cpuCount <= 2 ? 1 : 2

/** Office 文件后台工作进程数量，固定为 1 */
const officeBackgroundProcesses = 1

/**
 * PDF 后台工作进程数量
 * 取 CPU 核心数的 70% 向下取整后减去 OCR 和 Office 进程数，最小为 1
 */
let PdfBackgroundProcess = Math.max(
  1,
  Math.floor(cpuCount * 0.7) - ocrBackgroundProcesses - officeBackgroundProcesses
)
if (PdfBackgroundProcess == cpuCount) {
  PdfBackgroundProcess = 1
}

console.info(
  `Text Extractor - Number of available workers: ${PdfBackgroundProcess} for PDFs, ${ocrBackgroundProcesses} for OCR, ${officeBackgroundProcesses} for Office`
)

/** 工作进程超时时间（毫秒），超时后终止提取任务 */
export const workerTimeout = 120_000

/** PDF 文件处理队列，控制并发数和超时 */
export const pdfProcessQueue = new PQueue({
  concurrency: PdfBackgroundProcess,
  timeout: workerTimeout + 100,
})

/** 图片 OCR 处理队列，控制并发数和超时 */
export const imagesProcessQueue = new PQueue({
  concurrency: ocrBackgroundProcesses,
  timeout: workerTimeout + 100,
})

/** Office 文件处理队列，控制并发数和超时 */
export const officeProcessQueue = new PQueue({
  concurrency: officeBackgroundProcesses,
  timeout: workerTimeout + 100,
})

/** 提取失败时的占位文本 */
export const FAILED_TO_EXTRACT = '[Failed to extract text]'

/** 移动端无法提取时的占位文本 */
export const CANT_EXTRACT_ON_MOBILE = '[Cannot extract text on mobile]'
