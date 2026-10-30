/**
 * PDF 文本提取 Web Worker
 * 在独立线程中通过 WASM (Rust) 插件从 PDF 文件提取文本
 * 按页提取文本，支持文本规范化处理
 */
import rustPlugin from '../../pkg/obsidian_text_extract_bg.wasm'
import * as plugin from '../../pkg'

/** 解码 WASM 插件的 Base64 数据 */
const decodedPlugin = decodeBase64(rustPlugin as any)

/**
 * 规范化文本内容
 * 将所有空白字符（空格、换行等）替换为单个空格，并去除首尾空白
 * @param text - 原始文本
 * @returns 规范化后的文本
 */
function normalize(text: string) {
  if (text === null || text === undefined) return ''
  else return text.replace(/[ \n]+/g, ' ').trim()
}

/**
 * 从 PDF 数据中提取文本
 * 调用 WASM 插件按页提取，可选规范化处理
 * @param pdf - PDF 文件的二进制数据
 * @param shouldNormalize - 是否规范化文本（合并空白字符）
 * @returns Markdown 格式的文本，每页以标题分隔
 */
function extract(pdf: Uint8Array, shouldNormalize: boolean) {
  let text = plugin.extract_pdf_text_by_pages(pdf)

  if (shouldNormalize) {
    text = text.map(normalize)
  }

  return text
    .map((text, i) => `# Page ${i + 1}^page=${i + 1}\n${text}\n\n`)
    .join('')
}

/**
 * Worker 消息处理入口
 * 接收主线程发送的 PDF 数据，执行文本提取后返回结果
 */
onmessage = async evt => {
  const buffer = Uint8Array.from(decodedPlugin, c => c.charCodeAt(0))
  await plugin.default(Promise.resolve(buffer))

  try {
    const pdf = evt.data.data as Uint8Array
    const shouldNormalize: boolean = !!evt.data.normalize

    const text = extract(pdf, shouldNormalize)

    self.postMessage({ text })
  } catch (e) {
    console.info('Text Extractor - Could not extract text from ' + evt.data.name)
    self.postMessage({ text: '' })
  }
}

/**
 * 解码 Base64 字符串
 * @param data - Base64 编码的字符串
 * @returns 解码后的字符串
 */
function decodeBase64(data: string) {
  return atob(data)
}
