/**
 * 工具函数模块
 * 提供 MD5 哈希计算和字符串 slug 化等通用工具函数
 */
import { type BinaryLike } from 'crypto'
import { md5 } from 'pure-md5'

/**
 * 计算数据的 MD5 哈希值
 * 用于生成缓存文件名，确保同一文件路径始终映射到同一哈希值
 * @param data - 需要哈希的数据，支持字符串和二进制数据
 * @returns MD5 哈希字符串
 */
export const makeMD5 = (data: BinaryLike) => typeof data === "string"
  ? md5(data)
  : md5(new TextDecoder().decode(data))

/**
 * 将字符串转换为 URL 友好的 slug 格式
 * 将非字母数字字符替换为连字符，并去除首尾连字符
 * 支持 Unicode 字母和标记字符
 * @param str - 需要转换的字符串
 * @returns slug 化后的字符串
 */
export const slugify = (str: string) => str
  .toLowerCase()
  .replace(/[^\p{Letter}\p{Mark}0-9]/gu, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '')
