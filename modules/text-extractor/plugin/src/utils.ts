/**
 * 插件工具函数模块
 * 提供创建新笔记等辅助功能
 */
import { Notice } from 'obsidian'

/**
 * 创建新的 Markdown 笔记并打开
 * 根据用户 Obsidian 设置确定新文件的存放位置（当前文件夹/指定文件夹/根目录）
 * 如果文件已存在，自动在文件名后追加编号
 * @param name - 新笔记的文件名（不含扩展名）
 * @param contents - 新笔记的初始内容
 */
export async function createNote(name: string, contents = ''): Promise<void> {
  try {
    let path = `${name}`

    // 检查文件是否已存在，存在则追加编号
    if (app.vault.getAbstractFileByPath(`${path}.md`)) {
      let i = 1
      while (await app.vault.getAbstractFileByPath(`${path} ${i}.md`)) {
        i++
      }
      path += ` ${i}`
    }

    await app.vault.create(`${path}.md`, contents)
    await app.workspace.openLinkText(path, '')
  } catch (e) {
    new Notice('Text Extract - Could not create note: ' + (e as any).message)
    throw e
  }
}
