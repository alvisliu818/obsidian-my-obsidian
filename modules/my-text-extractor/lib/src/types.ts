import type { ocrLangs } from './ocr/ocr-langs'

/**
 * 提取文本的数据结构，用于缓存存储
 * @property path - 被提取文本的原始文件路径
 * @property text - 提取出的文本内容
 * @property langs - OCR 使用的语言列表（拼接后的字符串）
 * @property libVersion - 提取时使用的库版本号
 */
export type ExtractedText = {
  path: string
  text: string
  langs: string
  libVersion: string
}

/**
 * OCR 选项配置
 * @property langs - OCR 识别使用的语言数组
 * @property useSystemOCR - 是否使用系统原生 OCR（仅 macOS 桌面端支持）
 */
export type OcrOptions = {
  langs: Array<(typeof ocrLangs)[number]>
  useSystemOCR: boolean
}

/**
 * 缓存文件存放位置模式
 * - 'centralized': 集中式存储，所有缓存文件统一放在 .obsidian/plugins/text-extractor/cache/ 目录下（默认）
 * - 'adjacent': 相邻式存储，缓存文件放在被索引文件同一文件夹下，文件名为 {原文件名}.text-extractor.json
 */
export type CacheLocation = 'centralized' | 'adjacent'
