import type {
  App,
  WorkspaceLeaf
} from 'obsidian';

import { DUMMY_PATH } from '@mnaoumov/obsidian-lib/attachment-path';
import { AllWindowsEventComponent } from '@mnaoumov/obsidian-lib/components/all-windows-event-component';
import { LayoutReadyComponent } from '@mnaoumov/obsidian-lib/components/layout-ready-component';
import { convertAsyncToSync } from '@mnaoumov/typescript-lib/async';
import { ViewType } from '@obsidian-typings/obsidian-public-latest/implementations';
import { webUtils } from 'electron';
import {
  MarkdownView,
  Menu,
  MenuItem,
  TFile
} from 'obsidian';

import type { ArrayBufferMap } from './array-buffer-map.ts';
import type { AttachmentPathManager } from './attachment-path-manager.ts';
import type { HandedOverSettingsComponent } from './handed-over-settings-component.ts';
import type { ImageSizeMap } from './image-size-map.ts';
import type { MarkdownUrlMap } from './markdown-url-map.ts';

import { ExternallyCreatedAttachmentHandlerComponent } from './externally-created-attachment-handler-component.ts';
import { ClipboardManagerInsertFilesPatchComponent } from './patches/clipboard-manager-insert-files-patch-component.ts';
import { CoreFilesSettingTabPatchComponent } from './patches/core-files-setting-tab-patch-component.ts';
import { FileArrayBufferPatchComponent } from './patches/file-array-buffer-patch-component.ts';
import { FileManagerGenerateMarkdownLinkPatchComponent } from './patches/file-manager-generate-markdown-link-patch-component.ts';
import { ShareReceiverImportFilesPatchComponent } from './patches/share-receiver-import-files-patch-component.ts';
import { VaultCreateBinaryEnsureFolderPatchComponent } from './patches/vault-create-binary-ensure-folder-patch-component.ts';
import { VaultGetAvailablePathForAttachmentsPatchComponent } from './patches/vault-get-available-path-for-attachments-patch-component.ts';
import { VaultGetAvailablePathPatchComponent } from './patches/vault-get-available-path-patch-component.ts';
import { VaultGetConfigPatchComponent } from './patches/vault-get-config-patch-component.ts';
import { WebUtilsGetPathForFilePatchComponent } from './patches/web-utils-get-path-for-file-patch-component.ts';
import { WriteAttributionPatchComponent } from './patches/write-attribution-patch-component.ts';
import { PluginSettingsComponent } from './plugin-settings-component.ts';
import { Substitutions } from './substitutions.ts';
import { ActionContext } from './token-evaluator-context.ts';
import { TokenValidator } from './token-validator.ts';

interface CustomAttachmentLocationComponentConstructorParams {
  readonly app: App;
  readonly arrayBufferMap: ArrayBufferMap;
  readonly attachmentPathManager: AttachmentPathManager;
  readonly handedOverSettingsComponent: HandedOverSettingsComponent;
  readonly imageSizeMap: ImageSizeMap;
  readonly markdownUrlMap: MarkdownUrlMap;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly pluginSettingsComponent: PluginSettingsComponent;
  readonly tokenValidator: TokenValidator;
}

export class CustomAttachmentLocationComponent extends LayoutReadyComponent {
  /**
   * The folder the `getConfig` patch hands Obsidian as its `attachmentFolderPath`, or `null` to leave Obsidian's
   * own value alone.
   *
   * Always `null` while the plugin follows Obsidian's own location. Otherwise the patch would feed Obsidian a
   * value resolved FROM Obsidian's setting back as that very setting — a loop that is easy to write and hard to
   * see. Checked here, at read time, rather than only when a note is opened, so a value cached before the mode
   * was switched on cannot outlive the switch.
   *
   * @returns The resolved folder, or `null`.
   */
  public get currentAttachmentFolderPath(): null | string {
    return this.pluginSettingsComponent.settings.shouldFollowObsidianAttachmentLocation ? null : this._currentAttachmentFolderPath;
  }

  private _currentAttachmentFolderPath: null | string = null;

  private readonly arrayBufferMap: ArrayBufferMap;

  private readonly attachmentPathManager: AttachmentPathManager;

  private readonly handedOverSettingsComponent: HandedOverSettingsComponent;
  private readonly imageSizeMap: ImageSizeMap;

  private isMarkdownViewPatched = false;

  private lastOpenFilePath: null | string = null;

  private readonly markdownUrlMap: MarkdownUrlMap;
  private readonly pluginId: string;
  private readonly pluginName: string;
  private readonly pluginSettingsComponent: PluginSettingsComponent;
  private readonly tokenValidator: TokenValidator;

  public constructor(params: CustomAttachmentLocationComponentConstructorParams) {
    super(params.app);
    this.arrayBufferMap = params.arrayBufferMap;
    this.handedOverSettingsComponent = params.handedOverSettingsComponent;
    this.pluginId = params.pluginId;
    this.pluginName = params.pluginName;
    this.pluginSettingsComponent = params.pluginSettingsComponent;
    this.attachmentPathManager = params.attachmentPathManager;
    this.markdownUrlMap = params.markdownUrlMap;
    this.imageSizeMap = params.imageSizeMap;
    this.tokenValidator = params.tokenValidator;
  }

  public override onload(): void {
    super.onload();
    this.registerEvent(this.app.workspace.on('file-open', convertAsyncToSync(this.handleFileOpen.bind(this))));
    this.registerEvent(this.app.vault.on('rename', convertAsyncToSync(this.handleRename.bind(this))));

    this.registerEvent(this.app.workspace.on('receive-text-menu', this.handleReceiveTextMenu.bind(this)));
    this.registerEvent(this.app.workspace.on('receive-files-menu', this.handleReceiveFilesMenu.bind(this)));
  }

  protected override async onLayoutReady(): Promise<void> {
    /*
     * On an enable after layout-ready this runs while the settings component is still reading `data.json`, so
     * `customTokensStr` would still be the default. The reload below is not redundant: the first load validated
     * the stored templates before any custom token existed, so it runs again once they are registered.
     */
    await this.pluginSettingsComponent.whenLoadedFromFile();
    Substitutions.registerCustomTokens(this.pluginSettingsComponent.settings.customTokensStr);
    await this.pluginSettingsComponent.loadFromFile(false);

    this.addChild(
      new VaultGetAvailablePathForAttachmentsPatchComponent({
        attachmentPathManager: this.attachmentPathManager,
        vault: this.app.vault
      })
    );

    this.addChild(
      new VaultCreateBinaryEnsureFolderPatchComponent({
        app: this.app,
        vault: this.app.vault
      })
    );

    /*
     * Before the handler that consumes what it records — and before any foreign write can happen, which is
     * why both live behind layout-ready rather than `onload`.
     */
    this.addChild(
      new WriteAttributionPatchComponent({
        pluginId: this.pluginId,
        pluginSettingsComponent: this.pluginSettingsComponent,
        vault: this.app.vault
      })
    );

    this.addChild(
      new ExternallyCreatedAttachmentHandlerComponent({
        app: this.app,
        attachmentPathManager: this.attachmentPathManager,
        handedOverSettingsComponent: this.handedOverSettingsComponent,
        pluginSettingsComponent: this.pluginSettingsComponent,
        tokenValidator: this.tokenValidator
      })
    );

    this.addChild(
      new VaultGetAvailablePathPatchComponent({
        app: this.app,
        pluginSettingsComponent: this.pluginSettingsComponent,
        vault: this.app.vault
      })
    );

    this.addChild(
      new VaultGetConfigPatchComponent({
        customAttachmentLocationComponent: this,
        vault: this.app.vault
      })
    );

    this.addChild(
      new CoreFilesSettingTabPatchComponent({
        app: this.app,
        pluginId: this.pluginId,
        pluginName: this.pluginName,
        pluginSettingsComponent: this.pluginSettingsComponent
      })
    );

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Actually not available on some platforms.
    if (webUtils) {
      this.addChild(
        new WebUtilsGetPathForFilePatchComponent({
          webUtils
        })
      );
    }

    this.addChild(
      new FileManagerGenerateMarkdownLinkPatchComponent({
        app: this.app,
        fileManager: this.app.fileManager,
        imageSizeMap: this.imageSizeMap,
        markdownUrlMap: this.markdownUrlMap,
        pluginSettingsComponent: this.pluginSettingsComponent
      })
    );

    this.addChild(
      new ShareReceiverImportFilesPatchComponent({
        app: this.app,
        attachmentPathManager: this.attachmentPathManager,
        pluginSettingsComponent: this.pluginSettingsComponent,
        shareReceiver: this.app.shareReceiver,
        tokenValidator: this.tokenValidator
      })
    );

    this.addChild(new AllWindowsEventComponent(this.app)).registerAllDocumentsDomEvent({
      callback: this.handleInputFileChange.bind(this),
      options: { capture: true },
      type: 'change'
    });

    await this.handleActiveLeafChange(this.app.workspace.getLeavesOfType(ViewType.Markdown)[0] ?? null);

    if (!this.isMarkdownViewPatched) {
      this.registerEvent(this.app.workspace.on('active-leaf-change', convertAsyncToSync(this.handleActiveLeafChange.bind(this))));
    }
  }

  private async handleActiveLeafChange(leaf: null | WorkspaceLeaf): Promise<void> {
    if (this.isMarkdownViewPatched || leaf?.view.getViewType() !== ViewType.Markdown) {
      return;
    }

    await leaf.loadIfDeferred();

    const markdownView = leaf.view as MarkdownView;

    this.addChild(
      new ClipboardManagerInsertFilesPatchComponent({
        arrayBufferMap: this.arrayBufferMap,
        clipboardManager: markdownView.editMode.clipboardManager
      })
    );

    this.isMarkdownViewPatched = true;
  }

  private async handleFileOpen(file: null | TFile): Promise<void> {
    if (
      file === null || this.handedOverSettingsComponent.isPathIgnored(file.path)
      || this.pluginSettingsComponent.settings.shouldFollowObsidianAttachmentLocation
    ) {
      this._currentAttachmentFolderPath = null;
      this.lastOpenFilePath = null;
      return;
    }

    if (file.path === this.lastOpenFilePath) {
      return;
    }

    this.lastOpenFilePath = file.path;
    this._currentAttachmentFolderPath = await this.attachmentPathManager.getAttachmentFolderFullPathForPath({
      actionContext: ActionContext.OpenFile,
      attachmentFileName: DUMMY_PATH,
      notePath: file.path
    });
  }

  private handleInputFileChange($event: Event): void {
    if (!($event.target instanceof HTMLInputElement) || $event.target.type !== 'file') {
      return;
    }

    for (const file of $event.target.files ?? []) {
      this.addChild(
        new FileArrayBufferPatchComponent({
          app: this.app,
          arrayBufferMap: this.arrayBufferMap,
          file
        })
      );
    }
  }

  private handleReceiveFilesMenu(menu: Menu, attachmentFiles: TFile[]): void {
    this.handleReceiveMenuItemClick(menu, (noteFile) => {
      const linkTexts = attachmentFiles.map((attachmentFile) => this.app.fileManager.generateMarkdownLink(attachmentFile, noteFile.path));
      return linkTexts.join('\n');
    });
  }

  private handleReceiveMenuItemClick(menu: Menu, prepareTextFunction: (noteFile: TFile) => string): void {
    const app = this.app;
    const menuItem = menu.items.find((item) => item instanceof MenuItem && !!item.iconEl.querySelector('.lucide-file')) as MenuItem | undefined;
    if (menuItem) {
      menuItem.callback = callback;
    }

    function callback(): void {
      const markdownView = app.workspace.getActiveViewOfType(MarkdownView);
      if (!markdownView?.file) {
        return;
      }

      const text = prepareTextFunction(markdownView.file);
      markdownView.editor.replaceSelection(text);
    }
  }

  private handleReceiveTextMenu(menu: Menu, text: string): void {
    this.handleReceiveMenuItemClick(menu, () => text);
  }

  private async handleRename(): Promise<void> {
    await this.handleFileOpen(this.app.workspace.getActiveFile());
  }
}
