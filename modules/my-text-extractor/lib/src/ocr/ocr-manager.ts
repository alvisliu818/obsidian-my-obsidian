/**
 * OCR 文本提取管理器
 * 使用 Tesseract.js 或 macOS 系统原生 OCR 从图片中提取文本
 * 支持多语言识别、工作池复用、超时控制和缓存机制
 */
import { Platform, TFile } from 'obsidian'
import Tesseract, { createWorker } from 'tesseract.js'
import { getCachePath, readCache, writeCache } from '../cache'
import {
  CANT_EXTRACT_ON_MOBILE,
  FAILED_TO_EXTRACT,
  imagesProcessQueue,
  workerTimeout,
} from '../globals'
import type { OcrOptions } from '../types'
import type { ocrLangs } from './ocr-langs'
import { extractTextByMacOCR } from './ocr-mac'

/**
 * 将语言数组合并为 Tesseract 可识别的格式
 * 语言按字母排序后用 '+' 连接，同时用作缓存键
 * 例如：['fra', 'eng'] => 'eng+fra'
 * @param langs - OCR 语言代码数组
 * @returns 拼接后的语言字符串
 */
function concatLangs(langs: Array<(typeof ocrLangs)[number]>): string {
  return langs.sort().join('+')
}

/**
 * OCR Worker 封装类
 * 管理 Tesseract Worker 的生命周期，支持工作池复用和超时控制
 * Worker 首次使用时需要加载语言包，之后可复用
 */
class OCRWorker {
  /** 工作池，存储所有已创建的 OCRWorker 实例 */
  static #pool: OCRWorker[] = []
  /** 当前 Worker 是否正在执行任务 */
  #running = false
  /** 当前 Worker 是否已完成初始化（加载语言包） */
  #ready = false

  private constructor(private worker: Tesseract.Worker) {}

  /**
   * 获取一个可用的 Worker
   * 优先从池中获取空闲且已就绪的 Worker，如果没有则创建新的
   * @returns 可用的 OCRWorker 实例
   */
  static getWorker(): OCRWorker {
    const free = OCRWorker.#pool.find(w => !w.#running && w.#ready)
    if (free) {
      return free
    }
    const worker = new OCRWorker(
      createWorker({
        cachePath: 'tesseract-' + app.appId,
      })
    )
    OCRWorker.#pool.push(worker)
    return worker
  }

  /**
   * 强制终止所有 Worker 并清空工作池
   * 在设置变更（如语言切换）时调用
   */
  static clearWorkers() {
    OCRWorker.#pool.forEach(w => w.worker.terminate())
    OCRWorker.#pool = []
  }

  /**
   * 销毁指定的 Worker
   * 终止 Worker 线程并从池中移除
   * @param ocrWorker - 需要销毁的 OCRWorker 实例
   */
  static #destroyWorker(ocrWorker: OCRWorker) {
    ocrWorker.worker.terminate()
    OCRWorker.#pool = OCRWorker.#pool.filter(w => w !== ocrWorker)
  }

  /**
   * 向 Worker 发送 OCR 识别任务并等待结果
   * 首次使用时会自动加载和初始化语言包
   * @param msg - 包含图片数据、文件名和 OCR 选项
   * @returns 识别出的文本和使用的语言字符串
   */
  public async run(msg: {
    imageData: Buffer
    name: string
    options: OcrOptions
  }): Promise<{ text: string; langs: string }> {
    return new Promise(async (resolve, reject) => {
      this.#running = true
      const langs = concatLangs(msg.options.langs)

      if (!this.#ready) {
        await this.worker.load()
        await this.worker.loadLanguage(langs)
        await this.worker.initialize(langs)
        this.#ready = true
      }

      const timeout = setTimeout(() => {
        this.worker.terminate()
        console.warn('Text Extractor - OCR Worker timeout for ' + msg.name)
        reject('timeout')
        OCRWorker.#destroyWorker(this)
      }, workerTimeout)

      try {
        const { data } = await this.worker.recognize(msg.imageData)
        clearTimeout(timeout)
        return resolve({ text: data.text, langs })
      } catch (e) {
        console.error('Text Extractor - OCR Worker exception for ' + msg.name)
        console.error(e)
        resolve({ text: '', langs })
      } finally {
        this.#running = false
      }
    })
  }
}

/**
 * OCR 文本提取管理器
 * 负责协调图片文件的文本提取流程：
 * 1. 检查缓存是否已有提取结果
 * 2. 移动端直接返回不可提取提示
 * 3. 桌面端根据设置选择系统 OCR 或 Tesseract 提取文本
 */
class OCRManager {
  /**
   * 提取图片文件的文本内容
   * 通过处理队列控制并发，避免资源耗尽
   * @param file - 需要提取文本的图片文件
   * @param options - OCR 选项配置
   * @returns 提取出的文本内容，提取失败返回空字符串
   */
  public async getImageText(file: TFile, options: OcrOptions): Promise<string> {
    try {
      return (
        (await imagesProcessQueue.add(() =>
          this.#getImageText(file, options)
        )) ?? ''
      )
    } catch (e) {
      console.warn(
        `Text Extractor - Error while extracting text from ${file.basename}`
      )
      console.warn(e)
      return ''
    }
  }

  /**
   * 使用 Tesseract OCR 引擎提取图片文本
   * @param file - 图片文件
   * @param options - OCR 选项
   * @returns 处理后的文本（换行替换为空格，多余空格合并）
   */
  async #ocrByTesseract(file: TFile, options: OcrOptions): Promise<string> {
    const data = new Uint8ClampedArray(await app.vault.readBinary(file))
    const worker = OCRWorker.getWorker()

    const res = await worker.run({
      imageData: Buffer.from(data.buffer),
      name: file.basename,
      options,
    })
    const text = res.text
      .replace(/\n/g, ' ')
      .replace(/ +/g, ' ')
      .trim()
    return text
  }

  /**
   * 实际执行图片文本提取的内部方法
   * 流程：读取缓存 → 移动端检查 → 选择 OCR 引擎提取 → 写入缓存
   * @param file - 图片文件
   * @param options - OCR 选项
   * @returns 提取出的文本内容
   */
  async #getImageText(file: TFile, options: OcrOptions): Promise<string> {
    const cache = await readCache(file)
    if (cache) {
      return cache.text ?? FAILED_TO_EXTRACT
    }

    if (Platform.isMobileApp || !Buffer) {
      return CANT_EXTRACT_ON_MOBILE
    }

    const cachePath = getCachePath(file)

    const useSystemOCR =
      options.useSystemOCR && Platform.isDesktopApp && Platform.isMacOS

    const langs = useSystemOCR ? '' : concatLangs(options.langs)

    return new Promise(async (resolve, reject) => {
      try {
        let text: string
        if (useSystemOCR) {
          text = await extractTextByMacOCR(file)
        } else {
          text = await this.#ocrByTesseract(file, options)
        }

        await writeCache(
          cachePath.folder,
          cachePath.filename,
          text,
          file.path,
          langs
        )
        resolve(text)
      } catch (e) {
        // 提取失败时写入空缓存，避免重复尝试
        await writeCache(
          cachePath.folder,
          cachePath.filename,
          '',
          file.path,
          langs
        )
        resolve('')
      }
    })
  }
}

export const ocrManager = new OCRManager()

/**
 * 清除所有 OCR Worker
 * 在语言设置变更时调用，确保新语言生效
 */
export function clearOCRWorkers() {
  OCRWorker.clearWorkers()
}
