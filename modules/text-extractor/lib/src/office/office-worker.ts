/**
 * Office 文件文本提取 Web Worker
 * 在独立线程中从 docx（Word）和 xlsx（Excel）文件中提取文本
 * docx 使用 mammoth 库提取，xlsx 使用 SheetJS 库提取
 */
import mammoth from "mammoth";
import { utils as sheetUtils, read as xlsxRead } from 'xlsx'

/**
 * Worker 消息处理入口
 * 根据文件扩展名选择对应的提取方法
 */
onmessage = async evt => {
  try {
    let text = ''
    if (evt.data.extension === 'docx') {
      text = await extractWordText(evt.data.data)
    } else if (evt.data.extension === 'xlsx') {
      text = await extractExcelText(evt.data.data)
    }
    self.postMessage({ text })
  } catch (e) {
    console.info('Text Extractor - Could not extract text from ' + evt.data.name)
    self.postMessage({ text: '' })
  }
}

/**
 * 从 Word (docx) 文件中提取纯文本
 * 使用 mammoth 库解析 docx 格式
 * @param arr - docx 文件的二进制数据
 * @returns 提取出的纯文本内容
 */
async function extractWordText(arr: Uint8Array): Promise<string> {
  const result = await mammoth.extractRawText({ arrayBuffer: arr })
  return result.value
}

/**
 * 从 Excel (xlsx) 文件中提取文本
 * 遍历所有工作表，提取每个工作表的名称和内容
 * @param arr - xlsx 文件的二进制数据
 * @returns 拼接后的所有工作表文本内容
 */
async function extractExcelText(arr: Uint8Array): Promise<string> {
  const workbook = xlsxRead(arr, { type: 'buffer' })
  let text = ''
  const sheets = workbook.SheetNames
  for (const sheet of sheets) {
    text += `${sheet} `
    text += sheetUtils.sheet_to_txt(workbook.Sheets[sheet])
  }
  return text
}
