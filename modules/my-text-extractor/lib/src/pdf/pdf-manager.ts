/**
 * PDF 文本提取管理器
 * 使用 Web Worker + WASM (Rust) 从 PDF 文件中提取文本内容
 * 支持工作池复用、超时控制和缓存机制
 */
import { Platform, TFile } from 'obsidian'
import WebWorker from 'web-worker:./pdf-worker.ts'
import {
  CANT_EXTRACT_ON_MOBILE,
  FAILED_TO_EXTRACT,
  pdfProcessQueue,
  workerTimeout,
} from '../globals'
import { getCachePath, readCache, writeCache } from '../cache'

/**
 * PDF Worker 封装类
 * 管理 Web Worker 的生命周期，支持工作池复用和超时控制
 * 使用静态池模式，按需创建 Worker，空闲时复用
 */
class PDFWorker {
  /** 工作池，存储所有已创建的 PDFWorker 实例 */
  static #pool: PDFWorker[] = []
  /** 当前 Worker 是否正在执行任务 */
  #running = false

  private constructor(private worker: Worker) {}

  /**
   * 获取一个可用的 Worker
   * 优先从池中获取空闲 Worker，如果没有则创建新的
   * @returns 可用的 PDFWorker 实例
   */
  static getWorker(): PDFWorker {
    const free = PDFWorker.#pool.find(w => !w.#running)
    if (free) {
      return free
    }
    const worker = new PDFWorker(new WebWorker({ name: 'PDF Text Extractor' }))
    PDFWorker.#pool.push(worker)
    return worker
  }

  /**
   * 销毁指定的 Worker
   * 终止 Worker 线程并从池中移除
   * @param pdfWorker - 需要销毁的 PDFWorker 实例
   */
  static #destroyWorker(pdfWorker: PDFWorker) {
    pdfWorker.worker.terminate()
    PDFWorker.#pool = PDFWorker.#pool.filter(w => w !== pdfWorker)
  }

  /**
   * 向 Worker 发送提取任务并等待结果
   * @param msg - 包含 PDF 数据、文件名和是否规范化文本的标志
   * @returns Worker 返回的提取结果
   */
  public async run(msg: {
    data: Uint8Array
    name: string
    normalize: boolean
  }): Promise<any> {
    return new Promise((resolve, reject) => {
      this.#running = true

      const timeout = setTimeout(() => {
        console.warn('Text Extractor - PDF Worker timeout for ', msg.name)
        reject('timeout')
        PDFWorker.#destroyWorker(this)
      }, workerTimeout)

      this.worker.postMessage(msg)
      this.worker.onmessage = evt => {
        clearTimeout(timeout)
        resolve(evt)
        this.#running = false
      }
    })
  }
}

/**
 * PDF 文本提取管理器
 * 负责协调 PDF 文件的文本提取流程：
 * 1. 检查缓存是否已有提取结果
 * 2. 移动端直接返回不可提取提示
 * 3. 桌面端使用 Worker 提取文本并写入缓存
 */
class PDFManager {
  /**
   * 提取 PDF 文件的文本内容
   * 通过处理队列控制并发，避免资源耗尽
   * @param file - 需要提取文本的 PDF 文件
   * @returns 提取出的文本内容，提取失败返回空字符串
   */
  public async getPdfText(file: TFile): Promise<string> {
    try {
      return await pdfProcessQueue.add(() => this.#getPdfText(file)) ?? ''
    } catch (e) {
      console.warn(
        `Text Extractor - Error while extracting text from ${file.basename}`
      )
      console.warn(e)
      return ''
    }
  }

  /**
   * 实际执行 PDF 文本提取的内部方法
   * 流程：读取缓存 → 移动端检查 → Worker 提取 → 写入缓存
   * @param file - 需要提取文本的 PDF 文件
   * @returns 提取出的文本内容
   */
  async #getPdfText(file: TFile): Promise<string> {
    const cache = await readCache(file)
    if (cache) {
      return cache.text ?? FAILED_TO_EXTRACT
    }

    if (Platform.isMobileApp) {
      return CANT_EXTRACT_ON_MOBILE
    }

    const cachePath = getCachePath(file)
    const data = new Uint8Array(await app.vault.readBinary(file))
    const worker = PDFWorker.getWorker()

    return new Promise(async (resolve, reject) => {
      try {
        const res = await worker.run({
          data,
          name: file.basename,
          normalize: true,
        })
        const text = res.data.text as string

        await writeCache(cachePath.folder, cachePath.filename, text, file.path, '')
        resolve(text)
      } catch (e) {
        // 提取失败（PDF 不可读或超时）时写入空缓存，避免重复尝试
        await writeCache(cachePath.folder, cachePath.filename, '', file.path, '')
        resolve('')
      }
    })
  }
}

export const pdfManager = new PDFManager()
