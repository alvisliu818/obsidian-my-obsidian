/**
 * Text Extractor 插件设置模块
 * 管理 OCR 语言、缓存位置、右键菜单等配置项
 * 提供设置界面和持久化存储功能
 */
import TextExtractorPlugin from './main'
import { writable } from 'svelte/store'
import { Notice, Platform, PluginSettingTab, Setting } from 'obsidian'
import LangSelector from './components/LangSelector.svelte'
import {
  getOcrLangs,
  clearOCRWorkers,
  setCacheLocation,
} from './lazyTextExtract'
import type { CacheLocation } from 'obsidian-text-extract'

/**
 * 插件设置项类型定义
 * @property ocrLanguages - OCR 识别使用的语言列表
 * @property rightClickMenu - 是否在右键菜单中显示 Text Extractor 选项
 * @property useSystemOCR - 是否使用系统原生 OCR（仅 macOS 支持）
 * @property cacheLocation - 缓存文件存放位置模式：'centralized' 集中式 | 'adjacent' 相邻式
 */
interface TextExtractorSettings {
  ocrLanguages: ReturnType<typeof getOcrLangs>[number][]
  rightClickMenu: boolean
  useSystemOCR: boolean
  cacheLocation: CacheLocation
}

/**
 * 插件设置界面
 * 提供 OCR 语言选择、缓存位置切换、右键菜单开关等配置界面
 */
export class TextExtractorSettingsTab extends PluginSettingTab {
  plugin: TextExtractorPlugin

  constructor(plugin: TextExtractorPlugin) {
    super(app, plugin)
    this.plugin = plugin

    // 语言选择变更时自动保存设置
    selectedLanguages.subscribe(async value => {
      settings.ocrLanguages = value
      clearOCRWorkers()
      await saveSettings(this.plugin)
    })
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    containerEl.createEl('h2', { text: 'Text Extractor - Settings' })

    // macOS 系统 OCR 开关
    if (Platform.isDesktopApp && Platform.isMacOS) {
      new Setting(containerEl)
        .setName('Use system OCR')
        .setDesc(
          'If enabled, Text Extractor will use the system OCR instead of Tesseract. The OCR language will be detected automatically.'
        )
        .addToggle(toggle => {
          toggle.setValue(settings.useSystemOCR).onChange(async v => {
            settings.useSystemOCR = v
            if (v) {
              clearOCRWorkers()
            }
            await saveSettings(this.plugin)
          })
        })
    }

    // OCR 语言选择器
    const container = containerEl.createEl('div', {
      cls: 'setting-item',
    })
    const info = container.createDiv({ cls: 'setting-item-info' })
    info.createDiv({ cls: 'setting-item-name', text: 'OCR Languages' })
    info.createDiv({
      cls: 'setting-item-description',
      text: `A list of languages to use for OCR. e.g. if your vault contains documents in English and French, you'd want to add 'eng' and 'fra' here.
        This setting only applies to images, not PDFs. You may have to clear the cache after changing this setting.`,
    })

    new LangSelector({
      target: container.createDiv({ cls: 'setting-item-control' }),
    })

    // 右键菜单开关
    new Setting(containerEl)
      .setName('Right click menu')
      .setDesc(
        'Add "Text Extractor" actions to the right click menu in the file explorer.'
      )
      .addToggle(toggle => {
        toggle.setValue(settings.rightClickMenu).onChange(async v => {
          settings.rightClickMenu = v
          await saveSettings(this.plugin)
        })
      })

    // 缓存位置设置
    new Setting(containerEl)
      .setName('Cache location')
      .setDesc(
        'Choose where to store extracted text cache files. ' +
        '"Centralized" stores all cache files in the plugin folder (.obsidian/plugins/text-extractor/cache/). ' +
        '"Adjacent" stores cache files next to the original file (e.g. image.png.text-extractor.json next to image.png). ' +
        'Changing this setting will not migrate existing cache files.'
      )
      .addDropdown(dropdown => {
        dropdown
          .addOption('centralized', 'Centralized (plugin folder)')
          .addOption('adjacent', 'Adjacent (same folder as file)')
          .setValue(settings.cacheLocation)
          .onChange(async (value: string) => {
            settings.cacheLocation = value as CacheLocation
            setCacheLocation(settings.cacheLocation)
            await saveSettings(this.plugin)
          })
      })

    //#region 危险操作区域
    new Setting(containerEl).setName('Danger Zone').setHeading()

    const resetCacheDesc = new DocumentFragment()
    resetCacheDesc.createSpan({}, span => {
      span.innerHTML = `Erase all Text Extractor cache data. Use this if you want to re-extract all your files, e.g after a change in language settings.<br>
        Be careful that re-extracting all your files can take a long time.`
    })
    new Setting(containerEl)
      .setName('Clear cache data')
      .setDesc(resetCacheDesc)
      .addButton(cb => {
        cb.setButtonText('Clear cache')
        cb.onClick(async () => {
          // await app.vault.adapter.rmdir(getCacheBasePath(), true)
          new Notice('Text Extract - Cache cleared.')
        })
      })
    //#endregion
  }
}

/** 默认设置值 */
const DEFAULT_SETTINGS: TextExtractorSettings = {
  ocrLanguages: ['eng'],
  rightClickMenu: true,
  useSystemOCR: false,
  cacheLocation: 'centralized',
}

/** 已选择的语言 Svelte store，用于语言选择器组件 */
export const selectedLanguages = writable(DEFAULT_SETTINGS.ocrLanguages)

/** 当前设置对象，加载后与持久化数据合并 */
export let settings = Object.assign(
  {},
  DEFAULT_SETTINGS
) as TextExtractorSettings

/**
 * 从插件数据中加载设置
 * 与默认设置合并，确保新增设置项有默认值
 * @param plugin - 插件实例
 */
export async function loadSettings(plugin: TextExtractorPlugin): Promise<void> {
  settings = Object.assign({}, DEFAULT_SETTINGS, await plugin.loadData())
  if (settings.ocrLanguages.length === 0) {
    settings.ocrLanguages = DEFAULT_SETTINGS.ocrLanguages
  }
  selectedLanguages.set(settings.ocrLanguages)
}

/**
 * 保存当前设置到插件数据
 * @param plugin - 插件实例
 */
export async function saveSettings(plugin: TextExtractorPlugin): Promise<void> {
  await plugin.saveData(settings)
}
