import type {
  PluginConflict,
  PluginGateComponent
} from '@mnaoumov/obsidian-lib/components/plugin-gate-component';
import type { PluginApiDeclaration } from '@mnaoumov/obsidian-lib/plugin/plugin-api';

import { OpenDemoVaultCommandHandler } from '@mnaoumov/obsidian-lib/command-handlers/open-demo-vault-command-handler';
import { PluginConflictSeverity } from '@mnaoumov/obsidian-lib/components/plugin-gate-component';
import { PluginSettingsTabComponent } from '@mnaoumov/obsidian-lib/components/plugin-settings-tab-component';
import { PluginDataHandler } from '@mnaoumov/obsidian-lib/data-handler';
import { PluginBase } from '@mnaoumov/obsidian-lib/plugin/plugin';
import { PluginEventSourceImpl } from '@mnaoumov/obsidian-lib/plugin/plugin-event-source';

import type { RenameDeleteHandlerSettings } from './rename-delete-handler-component.ts';

import { DeleteEmptyFoldersCommandHandler } from './command-handlers/delete-empty-folders-command-handler.ts';
import { FirstLoadNoticeComponent } from './first-load-notice-component.ts';
import { PluginApiImpl } from './plugin-api-impl.ts';
import {
  PLUGIN_API_CONTRACT,
  PLUGIN_API_VERSION
} from './plugin-api.ts';
import { PluginDependentsComponent } from './plugin-dependents-component.ts';
import { PluginSettingsComponent as PluginSettingsComponentImpl } from './plugin-settings-component.ts';
import { PluginSettingsTab } from './plugin-settings-tab.ts';
import { RenameDeleteHandlerComponent } from './rename-delete-handler-component.ts';
import { RescuePathResolver } from './rescue-path-resolver.ts';

/**
 * A plugin that used to own a rename/delete handler of its own.
 */
interface RenameDeleteHandlerOwner {
  /**
   * The first version that no longer registers a handler of its own, and is therefore safe to run alongside
   * this plugin.
   */
  readonly firstSupportedVersion: string;

  /**
   * The plugin id, as listed in Obsidian's community plugin registry.
   */
  readonly pluginId: string;

  /**
   * The display name, used when telling the user what to update.
   */
  readonly pluginName: string;
}

/**
 * The plugins that used to carry a rename/delete handler of their own, and the version of each that gave it
 * up.
 *
 * They shipped that handler, from `obsidian-dev-utils`. Two handlers acting on one rename corrupt
 * links and move attachments twice, and there is no reliable way for this plugin to win that race: the
 * library elects a handler by registry order, but its `runAsyncLinkUpdate` patch sits outside that election,
 * so whichever plugin loaded first keeps a hand on the wheel. Every scheme for seizing control from inside is
 * therefore load-order dependent. So this plugin does not compete — it declares each of them as a BLOCKING
 * conflict and stands aside while one of them is enabled at a version that still owns the handler.
 *
 * 检查表收缩史（2026-11-03）：
 * - `Custom Attachment Location` 与 `Consistent Attachments and Links` 已随单
 *   id 收编退役——CAL 是本 bundle 的共生模块，consistent-attachments-and-links
 *   自 4.1.0 起连 delete-empty-folders 命令都让出（功能被 CAL/ARDH 完全替代），
 *   用户库不存在独立安装形态，检查是死代码，条目删除。
 * - `Frontmatter Markdown Links`（v3.1.0）与 `External Rename Handler`
 *   （v4.1.0）已源码级收编为 bundle 模块，条目随之删除。
 * - 剩余一条（Better Markdown Links）按用户拍板也将源码级收编，收编后表
 *   清空整体退役。
 *
 * TODO: 收编完成后删除本表与 getPluginConflicts。
 */
const RENAME_DELETE_HANDLER_OWNERS: readonly RenameDeleteHandlerOwner[] = [
  {
    firstSupportedVersion: '5.0.0',
    pluginId: 'better-markdown-links',
    pluginName: 'Better Markdown Links'
  }
];

export class Plugin extends PluginBase {
  private pluginApi: null | PluginApiImpl = null;

  /**
   * Declares the API for the base to publish, once `onloadImpl` has built it.
   *
   * Published by the base rather than by hand, so that the handle is revoked with the feature surface and
   * the `plugin-loaded` broadcast carries the contract version — which is what a plugin declaring this one
   * as a dependency waits for. Nothing is declared while a blocking conflict holds, because the feature
   * surface that builds the API never ran.
   *
   * @returns The declaration, or none.
   */
  protected override getPluginApis(): PluginApiDeclaration[] {
    if (!this.pluginApi) {
      return [];
    }

    return [
      {
        api: this.pluginApi,
        apiVersion: PLUGIN_API_VERSION,
        contract: PLUGIN_API_CONTRACT
      }
    ];
  }

  /**
   * Declares what this plugin refuses to run beside, and what it merely warns about.
   *
   * The two severities are not two mechanisms: a plugin that still owns a rename/delete handler corrupts
   * links when it acts on the same rename as this one, so it BLOCKS; a plugin that merely duplicates the
   * Delete empty folders command costs the user a second palette entry, so it WARNS and both keep running.
   *
   * Blocked means enabled-but-inert. This plugin stays in the user's enabled list, says what it is waiting
   * for in its settings tab, and comes back the moment the conflict lifts — with no restart, and with
   * nothing to switch back on by hand.
   *
   * @returns The declared conflicts, blocking ones first.
   */
  protected override getPluginConflicts(): PluginConflict[] {
    return RENAME_DELETE_HANDLER_OWNERS.map((owner) => ({
      conflictingVersionRange: `<${owner.firstSupportedVersion}`,
      pluginId: owner.pluginId,
      pluginName: owner.pluginName,
      reason: `This plugin is waiting for ${owner.pluginName} ${owner.firstSupportedVersion} or newer.`
        + ' Until then that plugin handles renames and deletes itself, and two handlers acting on one'
        + ' rename corrupt links between them. Update it and this plugin picks the work back up on its'
        + ' own, with no restart and nothing here to switch back on.',
      severity: PluginConflictSeverity.Block
    }));
  }

  protected override async onloadImpl(): Promise<void> {
    const pluginSettingsComponent = this.addChild(
      new PluginSettingsComponentImpl({
        app: this.app,
        dataHandler: new PluginDataHandler(this),
        pluginEventSource: new PluginEventSourceImpl(this)
      })
    );
    this.pluginSettingsComponent = pluginSettingsComponent;

    this.addChild(
      new FirstLoadNoticeComponent({
        app: this.app,
        pluginId: this.manifest.id,
        pluginNoticeComponent: this.pluginNoticeComponent,
        pluginSettingsComponent
      })
    );

    // Subscribed here, before `getPluginApis()` publishes the API a dependent's gate waits for — so no
    // dependent can finish loading, and announce it, before this is listening.
    const pluginDependentsComponent = this.addChild(
      new PluginDependentsComponent({
        app: this.app,
        pluginId: this.manifest.id
      })
    );

    this.addChild(
      new PluginSettingsTabComponent({
        plugin: this,
        pluginSettingsTab: new PluginSettingsTab({
          // Deliberately lazy: the gate is what loads this method, so the base has not assigned it yet.
          getPluginGateComponent: (): PluginGateComponent => this.pluginGateComponent,
          plugin: this,
          pluginDependentsComponent,
          pluginSettingsComponent
        })
      })
    );

    this.pluginApi = new PluginApiImpl({
      app: this.app,
      pluginSettingsComponent
    });

    const rescuePathResolver = new RescuePathResolver({
      app: this.app,
      pluginSettingsComponent
    });

    this.addChild(
      new RenameDeleteHandlerComponent({
        abortSignalComponent: this.abortSignalComponent,
        app: this.app,
        pluginNoticeComponent: this.pluginNoticeComponent,
        resourceLockComponent: this.resourceLockComponent,
        settingsBuilder: (): Partial<RenameDeleteHandlerSettings> => {
          const settings = pluginSettingsComponent.settings;
          return {
            emptyFolderBehavior: settings.emptyFolderBehavior,
            getRescuePath: async (params) => await rescuePathResolver.getRescuePath(params),
            isNote: (path: string): boolean => pluginSettingsComponent.isNoteEx(path),
            isPathIgnored: (path: string): boolean => settings.isPathIgnored(path),
            shouldDeleteConflictingAttachments: settings.shouldDeleteConflictingAttachments,
            shouldDeleteEmptyNoteFolders: settings.shouldDeleteEmptyNoteFolders,
            shouldHandleDeletions: settings.shouldHandleDeletions,
            shouldHandleRenames: settings.shouldHandleRenames,
            shouldRenameAttachmentFiles: settings.shouldRenameAttachmentFiles,
            shouldRenameAttachmentFolder: settings.shouldRenameAttachmentFolder,
            shouldUpdateFileNameAliases: settings.shouldUpdateFileNameAliases
          };
        }
      })
    );

    await this.commandHandlerComponent.registerCommandHandlers(() => [
      new DeleteEmptyFoldersCommandHandler({
        abortSignal: this.abortSignalComponent.abortSignal,
        app: this.app,
        pluginNoticeComponent: this.pluginNoticeComponent,
        pluginSettingsComponent
      }),
      new OpenDemoVaultCommandHandler({
        app: this.app,
        pluginId: this.manifest.id,
        pluginNoticeComponent: this.pluginNoticeComponent,
        pluginVersion: this.manifest.version
      })
    ]);
  }
}
