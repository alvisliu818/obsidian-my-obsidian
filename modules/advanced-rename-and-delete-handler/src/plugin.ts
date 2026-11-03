import type { PluginGateComponent } from '@mnaoumov/obsidian-lib/components/plugin-gate-component';
import type { PluginApiDeclaration } from '@mnaoumov/obsidian-lib/plugin/plugin-api';

import { OpenDemoVaultCommandHandler } from '@mnaoumov/obsidian-lib/command-handlers/open-demo-vault-command-handler';
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
