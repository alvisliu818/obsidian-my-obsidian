/**
 * @file
 *
 * Reads back the settings this plugin handed to `Advanced Rename and Delete Handler` in 12.0.0.
 *
 * Handing the rename/delete HANDLER over did not stop this plugin needing the VALUES. Collect attachments
 * cleans up folders it empties, Go to owning note ranks the notes referencing an attachment, `isNoteEx`
 * decides what counts as a note, and every command checks whether a path is ignored — none of which is a
 * rename or a delete. Rather than keep private copies of settings another plugin now owns, this plugin asks
 * for them.
 *
 * Reads are synchronous and uncached. `PluginApiRef.value` is maintained by the registry, so reading it is a
 * field access rather than a lookup, and asking on every call means there is no staleness to invalidate when
 * the user edits a setting in the other plugin's tab. Uncached also sidesteps the revoked-handle trap: the
 * handle is never stored, so a provider that unloads simply makes the next read fall back.
 */

import type { PluginApiRef } from '@mnaoumov/obsidian-lib/plugin/plugin-api';
import type { App } from 'obsidian';

import { ComponentEx } from '@mnaoumov/obsidian-lib/components/component-ex';
import { watchPluginApi } from '@mnaoumov/obsidian-lib/plugin/plugin-api';

import type {
  AdvancedRenameAndDeleteHandlerReadBackApi,
  HandedOverSettings
} from './advanced-rename-and-delete-handler.ts';

import {
  ADVANCED_RENAME_AND_DELETE_HANDLER_API_VERSION_RANGE,
  ADVANCED_RENAME_AND_DELETE_HANDLER_READ_BACK_API_CONTRACT,
  DEFAULT_HANDED_OVER_SETTINGS,
  toHandedOverSettings
} from './advanced-rename-and-delete-handler.ts';

interface HandedOverSettingsComponentConstructorParams {
  readonly app: App;
  /**
   * 单一插件 id（2026-11-03）：ARDH 模块与本插件同 bundle 共生，两个实例的
   * `manifest.id` 都是宿主 id，ARDH publish API 的 registry 键因此是宿主 id
   * 而非上游常量 {@link ADVANCED_RENAME_AND_DELETE_HANDLER_PLUGIN_ID}。
   * watch 若仍用上游常量，`resolveUnavailabilityReason` 在插件表里查不到该 id
   * 会判定 notInstalled，read-back 永远静默走 fallback（excludePaths 与
   * 自定义附件扩展名被无视）。由宿主在构造时传入运行时的 `manifest.id`。
   */
  readonly providerPluginId: string;
}

export class HandedOverSettingsComponent extends ComponentEx {
  /**
   * The handed-over values, or this plugin's own defaults while the other plugin is unavailable.
   */
  public get settings(): HandedOverSettings {
    const api = this.apiRef?.value;
    return api ? toHandedOverSettings(api.getSettings()) : DEFAULT_HANDED_OVER_SETTINGS;
  }

  private apiRef: null | PluginApiRef<AdvancedRenameAndDeleteHandlerReadBackApi> = null;

  private readonly app: App;

  private readonly providerPluginId: string;

  public constructor(params: HandedOverSettingsComponentConstructorParams) {
    super();
    this.app = params.app;
    this.providerPluginId = params.providerPluginId;
  }

  /**
   * Whether a path is one the handler leaves alone entirely.
   *
   * @param path - The vault-relative path.
   * @returns Whether the path is ignored. `false` while the other plugin is unavailable — nothing is
   * configured, so nothing is excluded.
   */
  public isPathIgnored(path: string): boolean {
    return this.apiRef?.value?.isPathIgnored(path) ?? false;
  }

  /**
   * Whether a file is an attachment even though its extension says otherwise.
   *
   * @param path - The vault-relative path.
   * @returns Whether the file is treated as an attachment.
   */
  public isTreatedAsAttachment(path: string): boolean {
    const api = this.apiRef?.value;
    return api ? api.isTreatedAsAttachment(path) : DEFAULT_HANDED_OVER_SETTINGS.treatAsAttachmentExtensions.some((extension) => path.endsWith(extension));
  }

  public override onload(): void {
    // A watch rather than `whenAvailable()`: that wait blocks for ten seconds and then throws when the
    // plugin is simply not installed, which would stall this plugin's load for every user who declined the
    // suggestion. The ref costs nothing while the provider is absent and becomes live the moment it appears.
    this.apiRef = watchPluginApi<AdvancedRenameAndDeleteHandlerReadBackApi>({
      apiVersionRange: ADVANCED_RENAME_AND_DELETE_HANDLER_API_VERSION_RANGE,
      app: this.app,
      component: this,
      contract: ADVANCED_RENAME_AND_DELETE_HANDLER_READ_BACK_API_CONTRACT,
      pluginId: this.providerPluginId
    });
  }
}
