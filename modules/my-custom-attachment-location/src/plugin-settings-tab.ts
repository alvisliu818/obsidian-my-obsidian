import type { PluginGateComponent } from '@mnaoumov/obsidian-lib/components/plugin-gate-component';
import type {
  BindOptionsExtended,
  PluginSettingsTabBaseConstructorParams
} from '@mnaoumov/obsidian-lib/plugin/plugin-settings-tab';
import type {
  SettingDefinitionItem,
  SettingDefinitionRender,
  TextComponent
} from 'obsidian';
import type { ConditionalKeys } from 'type-fest';

import { appendCodeBlock } from '@mnaoumov/obsidian-lib/html-element';
import { t } from '@mnaoumov/obsidian-lib/i18n/i18n';
import { confirm } from '@mnaoumov/obsidian-lib/modals/confirm';
import { PluginSettingsTabBase } from '@mnaoumov/obsidian-lib/plugin/plugin-settings-tab';
import {
  convertAsyncToSync,
  invokeAsyncSafely
} from '@mnaoumov/typescript-lib/async';
import {
  debounce,
  normalizePath
} from 'obsidian';

import type { PluginSettingsComponent } from './plugin-settings-component.ts';
import type { PluginSettings } from './plugin-settings.ts';

import {
  AttachmentRenameMode,
  CollectAttachmentUsedByMultipleNotesMode,
  ConvertImagesToJpegMode,
  DefaultImageSizeDimension,
  MoveAttachmentToProperFolderUsedByMultipleNotesMode,
  OrphanAttachmentScanMode,
  RenameAttachmentsCreatedByOtherPluginsMode,
  SAMPLE_CUSTOM_TOKENS
} from './plugin-settings.ts';
import { Substitutions } from './substitutions.ts';
import { TOKENIZED_STRING_LANGUAGE } from './tokenized-string-language.ts';

const VISIBLE_SPACE_CHARACTER = '␣';
const JPEG_QUALITY_PRECISION = 2;
const REGISTER_CUSTOM_TOKENS_DEBOUNCE_IN_MILLISECONDS = 2000;

const bindOptionsWithTrim: BindOptionsExtended<PluginSettings, string, ConditionalKeys<PluginSettings, string>> = {
  componentToPluginSettingsValueConverter(uiValue: string): string {
    return normalizePath(uiValue.trimEnd());
  },
  pluginSettingsToComponentValueConverter(pluginSettingsValue: string): string {
    return pluginSettingsValue.trimEnd();
  },
  shouldResetSettingWhenComponentIsEmpty: true,
  shouldShowPlaceholderForDefaultValues: false
};

interface PluginSettingsTabConstructorParams extends PluginSettingsTabBaseConstructorParams<PluginSettings> {
  /**
   * Reaches the plugin's gate, LAZILY.
   *
   * A function rather than the component itself, because there is no component to hand over yet when this
   * tab is built: the base assigns `pluginGateComponent` only after the gate has loaded, and the gate loads
   * the feature surface — `onloadImpl`, where this tab is constructed — as it loads. Reading it eagerly
   * therefore throws. By the time a row renders, the assignment has long since happened.
   *
   * @returns The plugin gate component.
   */
  readonly getPluginGateComponent: (this: void) => PluginGateComponent;
  readonly pluginSettingsComponent: PluginSettingsComponent;
}

export class PluginSettingsTab extends PluginSettingsTabBase<PluginSettings> {
  private readonly getPluginGateComponent: (this: void) => PluginGateComponent;
  // Kept so this plugin can leave ITSELF out of the plugin picker; the base class does not expose `plugin`.
  private readonly ownPluginId: string;
  private readonly pluginSettingsComponent2: PluginSettingsComponent;

  public constructor(params: PluginSettingsTabConstructorParams) {
    super(params);
    this.getPluginGateComponent = params.getPluginGateComponent;
    this.ownPluginId = params.plugin.manifest.id;
    this.pluginSettingsComponent2 = params.pluginSettingsComponent;
  }

  public override hide(): void {
    super.hide();
    this.pluginSettingsComponent2.shouldDebounceCustomTokensValidation = false;
    // Closing cancels a pending debounced registration, so tokens typed just before closing are registered here.
    invokeAsyncSafely(async () => {
      await this.pluginSettingsComponent2.revalidate();
    });
  }

  protected override getSettingDefinitionItems(): SettingDefinitionItem[] {
    return [
      // The overlap banner has to travel as a ROW: Obsidian renders the declarative definitions and never
      // calls `display()` once `getSettingDefinitions()` is non-empty, so there is no container to write into
      // otherwise. The row body is emptied first, leaving the Setting element as a bare host for the banner.
      // The row exists only while a warning conflict holds, since the library renders nothing otherwise and an
      // empty row is still a divider and a block of padding.
      //
      // There is no row for `Advanced Rename and Delete Handler`: it is a declared dependency, so while it is
      // missing this tab is never registered at all and the library's own blocked tab explains what to install.
      this.settingEx({
        name: '',
        render: (setting) => {
          setting.settingEl.empty();
          this.getPluginGateComponent().renderConflictWarningBanner(setting.settingEl);
        },
        searchable: false,
        visible: () => this.getPluginGateComponent().hasActiveWarningConflicts()
      }),
      this.settingGroupEx({
        heading: t(($: any) => $.pluginSettingsTab.groups.core),
        items: this.getCoreItems()
      }),
      {
        desc: t(($: any) => $.pluginSettingsTab.pages.moveRenames.description),
        items: this.getMoveRenamesItems(),
        name: t(($: any) => $.pluginSettingsTab.groups.moveRenames),
        type: 'page'
      },
      {
        desc: t(($: any) => $.pluginSettingsTab.pages.specialCharacters.description),
        items: this.getSpecialCharactersItems(),
        name: t(($: any) => $.pluginSettingsTab.groups.specialCharacters),
        type: 'page'
      },
      {
        desc: t(($: any) => $.pluginSettingsTab.pages.collectedAttachments.description),
        items: this.getCollectedAttachmentsItems(),
        name: t(($: any) => $.pluginSettingsTab.groups.collectedAttachments),
        type: 'page'
      },
      {
        desc: t(($: any) => $.pluginSettingsTab.pages.images.description),
        items: this.getImagesItems(),
        name: t(($: any) => $.pluginSettingsTab.groups.images),
        type: 'page'
      },
      {
        desc: t(($: any) => $.pluginSettingsTab.pages.path.description),
        items: this.getPathItems(),
        name: t(($: any) => $.pluginSettingsTab.groups.path),
        type: 'page'
      },
      {
        desc: t(($: any) => $.pluginSettingsTab.pages.customTokens.description),
        items: this.getCustomTokensItems(),
        name: t(($: any) => $.pluginSettingsTab.groups.customTokens),
        type: 'page'
      },
      {
        desc: t(($: any) => $.pluginSettingsTab.pages.advanced.description),
        items: this.getAdvancedItems(),
        name: t(($: any) => $.pluginSettingsTab.groups.advanced),
        type: 'page'
      }
    ];
  }

  private getAdvancedItems(): SettingDefinitionRender[] {
    return [
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.markdownUrlFormat.description.part1));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.markdownUrlFormat.description.part2));
          f.appendText(' ');
          f.createEl('a', {
            href: 'https://github.com/mnaoumov/obsidian-custom-attachment-location?tab=readme-ov-file#tokens',
            text: t(($: any) => $.pluginSettingsTab.markdownUrlFormat.description.part3)
          });
          f.appendText('.');
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.markdownUrlFormat.description.part4));
        }),
        name: t(($: any) => $.pluginSettingsTab.markdownUrlFormat.name),
        render: (setting) => {
          setting.addCodeHighlighter((codeHighlighter) => {
            codeHighlighter.setLanguage(TOKENIZED_STRING_LANGUAGE);
            codeHighlighter.inputEl.addClass('tokenized-string-setting-control');
            this.bind({
              propertyName: 'markdownUrlFormat',
              valueComponent: codeHighlighter,
              ...bindOptionsWithTrim
            });
          });
        }
      }),
      this.settingEx({
        desc: t(($: any) => $.pluginSettingsTab.shouldSetLinkDisplayTextToAttachmentFileName.description),
        name: t(($: any) => $.pluginSettingsTab.shouldSetLinkDisplayTextToAttachmentFileName.name),
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldSetLinkDisplayTextToAttachmentFileName',
              valueComponent: toggle
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.timeoutInSeconds.description.part1));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.timeoutInSeconds.description.part2));
          f.appendText(' ');
          appendCodeBlock(f, '0');
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.timeoutInSeconds.description.part3));
        }),
        name: t(($: any) => $.pluginSettingsTab.timeoutInSeconds.name),
        render: (setting) => {
          setting.addNumber((number) => {
            number.setMin(0);
            this.bind({
              propertyName: 'timeoutInSeconds',
              valueComponent: number
            });
          });
        }
      })
    ];
  }

  private getCollectedAttachmentsItems(): SettingDefinitionRender[] {
    return [
      this.settingEx({
        desc: t(($: any) => $.pluginSettingsTab.downloadNetworkImages.description),
        name: t(($: any) => $.pluginSettingsTab.downloadNetworkImages.name),
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              onChanged: () => {
                // Only the timeout row below reads this value, through its `visible` predicate.
                this.refreshDomState();
              },
              propertyName: 'downloadNetworkImages',
              valueComponent: toggle
            });
          });
        }
      }),
      this.settingEx({
        desc: t(($: any) => $.pluginSettingsTab.networkImageDownloadTimeoutInSeconds.description),
        name: t(($: any) => $.pluginSettingsTab.networkImageDownloadTimeoutInSeconds.name),
        render: (setting) => {
          setting.addNumber((number) => {
            number.setMin(1);
            this.bind({
              propertyName: 'networkImageDownloadTimeoutInSeconds',
              valueComponent: number
            });
          });
        },
        visible: () => this.pluginSettingsComponent.settings.downloadNetworkImages
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.shouldRenameCollectedAttachments.description.part1));
          f.appendText(' ');
          appendCodeBlock(f, t(($: any) => $.pluginSettingsTab.shouldRenameCollectedAttachments.description.part2));
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.shouldRenameCollectedAttachments.description.part3));
          f.appendText(' ');
          appendCodeBlock(f, t(($: any) => $.pluginSettingsTab.collectedAttachmentFileName.name));
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.shouldRenameCollectedAttachments.description.part4));
        }),
        name: t(($: any) => $.pluginSettingsTab.shouldRenameCollectedAttachments.name),
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldRenameCollectedAttachments',
              valueComponent: toggle
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.collectedAttachmentFileName.description.part1));
          f.appendText(' ');
          f.createEl('a', {
            href: 'https://github.com/mnaoumov/obsidian-custom-attachment-location?tab=readme-ov-file#tokens',
            text: t(($: any) => $.pluginSettingsTab.collectedAttachmentFileName.description.part2)
          });
          f.appendText('.');
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.collectedAttachmentFileName.description.part3));
        }),
        name: t(($: any) => $.pluginSettingsTab.collectedAttachmentFileName.name),
        render: (setting) => {
          setting.addCodeHighlighter((codeHighlighter) => {
            codeHighlighter.setLanguage(TOKENIZED_STRING_LANGUAGE);
            codeHighlighter.inputEl.addClass('tokenized-string-setting-control');
            this.bind({
              propertyName: 'collectedAttachmentFileName',
              valueComponent: codeHighlighter,
              ...bindOptionsWithTrim
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.collectedAttachmentFolderPath.description.part1));
          f.appendText(' ');
          appendCodeBlock(f, t(($: any) => $.pluginSettingsTab.collectedAttachmentFolderPath.description.part2));
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.collectedAttachmentFolderPath.description.part3));
          f.appendText(' ');
          appendCodeBlock(f, './');
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.collectedAttachmentFolderPath.description.part4));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.collectedAttachmentFolderPath.description.part5));
          f.appendText(' ');
          f.createEl('a', {
            href: 'https://github.com/mnaoumov/obsidian-custom-attachment-location?tab=readme-ov-file#tokens',
            text: t(($: any) => $.pluginSettingsTab.collectedAttachmentFolderPath.description.part6)
          });
          f.appendText('.');
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.collectedAttachmentFolderPath.description.part7));
        }),
        name: t(($: any) => $.pluginSettingsTab.collectedAttachmentFolderPath.name),
        render: (setting) => {
          setting.addCodeHighlighter((codeHighlighter) => {
            codeHighlighter.setLanguage(TOKENIZED_STRING_LANGUAGE);
            codeHighlighter.inputEl.addClass('tokenized-string-setting-control');
            this.bind({
              propertyName: 'collectedAttachmentFolderPath',
              valueComponent: codeHighlighter,
              ...bindOptionsWithTrim
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.collectAttachmentUsedByMultipleNotesMode.description.part1));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.skip.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.skip.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.move.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.move.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.copy.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.copy.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.cancel.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.cancel.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.prompt.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.prompt.description));
        }),
        name: t(($: any) => $.pluginSettingsTab.collectAttachmentUsedByMultipleNotesMode.name),
        render: (setting) => {
          setting.addDropdown((dropdown) => {
            dropdown.addOptions({
              /* eslint-disable perfectionist/sort-objects -- Need to keep enum order. */
              [CollectAttachmentUsedByMultipleNotesMode.Skip]: t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.skip.displayText),
              [CollectAttachmentUsedByMultipleNotesMode.Move]: t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.move.displayText),
              [CollectAttachmentUsedByMultipleNotesMode.Copy]: t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.copy.displayText),
              [CollectAttachmentUsedByMultipleNotesMode.Cancel]: t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.cancel.displayText),
              [CollectAttachmentUsedByMultipleNotesMode.Prompt]: t(($: any) => $.pluginSettings.collectAttachmentUsedByMultipleNotesMode.prompt.displayText)
              /* eslint-enable perfectionist/sort-objects -- Need to keep enum order. */
            });
            this.bind({
              propertyName: 'collectAttachmentUsedByMultipleNotesMode',
              valueComponent: dropdown
            });
          });
        }
      }),
      this.settingEx({
        desc: t(($: any) => $.pluginSettingsTab.shouldSkipCollectingAttachmentsReferencedByRawPath.description),
        name: t(($: any) => $.pluginSettingsTab.shouldSkipCollectingAttachmentsReferencedByRawPath.name),
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldSkipCollectingAttachmentsReferencedByRawPath',
              valueComponent: toggle
            });
          });
        }
      }),
      this.settingEx({
        desc: t(($: any) => $.pluginSettingsTab.shouldCollectAttachmentsAutomatically.description),
        name: t(($: any) => $.pluginSettingsTab.shouldCollectAttachmentsAutomatically.name),
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldCollectAttachmentsAutomatically',
              valueComponent: toggle
            });
          });
        }
      })
    ];
  }

  private getCoreItems(): SettingDefinitionRender[] {
    return [
      this.settingEx({
        desc: t(($: any) => $.pluginSettingsTab.shouldFollowObsidianAttachmentLocation.description),
        name: t(($: any) => $.pluginSettingsTab.shouldFollowObsidianAttachmentLocation.name),
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              onChanged: () => {
                // Only the template row below reads this value, through its `visible` predicate.
                this.refreshDomState();
              },
              propertyName: 'shouldFollowObsidianAttachmentLocation',
              valueComponent: toggle
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.locationForNewAttachments.description.part1));
          f.appendText(' ');
          appendCodeBlock(f, '.');
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.locationForNewAttachments.description.part2));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.locationForNewAttachments.description.part3));
          f.appendText(' ');
          f.createEl('a', {
            href: 'https://github.com/mnaoumov/obsidian-custom-attachment-location?tab=readme-ov-file#tokens',
            text: t(($: any) => $.pluginSettingsTab.locationForNewAttachments.description.part4)
          });
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.locationForNewAttachments.description.part5));
          f.appendText(' ');
          appendCodeBlock(f, '.attachments');
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.locationForNewAttachments.description.part6));
          f.appendText(' ');
          f.createEl('a', { href: 'https://community.obsidian.md/plugins/unhide', text: 'Unhide' });
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.locationForNewAttachments.description.part7));
        }),
        name: t(($: any) => $.pluginSettingsTab.locationForNewAttachments.name),
        render: (setting) => {
          setting.addCodeHighlighter((codeHighlighter) => {
            codeHighlighter.setLanguage(TOKENIZED_STRING_LANGUAGE);
            codeHighlighter.inputEl.addClass('tokenized-string-setting-control');
            this.bind({
              propertyName: 'attachmentFolderPath',
              valueComponent: codeHighlighter,
              ...bindOptionsWithTrim
            });
          });
        },
        visible: () => !this.pluginSettingsComponent.settings.shouldFollowObsidianAttachmentLocation
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.generatedAttachmentFileName.description.part1));
          f.appendText(' ');
          f.createEl('a', {
            href: 'https://github.com/mnaoumov/obsidian-custom-attachment-location?tab=readme-ov-file#tokens',
            text: t(($: any) => $.pluginSettingsTab.generatedAttachmentFileName.description.part2)
          });
          f.appendText('.');
        }),
        name: t(($: any) => $.pluginSettingsTab.generatedAttachmentFileName.name),
        render: (setting) => {
          setting.addCodeHighlighter((codeHighlighter) => {
            codeHighlighter.setLanguage(TOKENIZED_STRING_LANGUAGE);
            codeHighlighter.inputEl.addClass('tokenized-string-setting-control');
            this.bind({
              propertyName: 'generatedAttachmentFileName',
              valueComponent: codeHighlighter,
              ...bindOptionsWithTrim
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          appendCodeBlock(f, '{{originalAttachmentFileName}}');
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.shouldWarnWhenOriginalAttachmentNameIsUnknown.description.part1));
          f.appendText(' ');
          appendCodeBlock(f, '{{attachmentFileName}}');
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.shouldWarnWhenOriginalAttachmentNameIsUnknown.description.part2));
        }),
        name: t(($: any) => $.pluginSettingsTab.shouldWarnWhenOriginalAttachmentNameIsUnknown.name),
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldWarnWhenOriginalAttachmentNameIsUnknown',
              valueComponent: toggle
            });
          });
        }
      })
    ];
  }

  private getCustomTokensItems(): SettingDefinitionRender[] {
    return [
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.customTokens.description.part1));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.customTokens.description.part2));
          f.appendText(' ');
          f.createEl('a', {
            href: 'https://github.com/mnaoumov/obsidian-custom-attachment-location?tab=readme-ov-file#custom-tokens',
            text: t(($: any) => $.pluginSettingsTab.customTokens.description.part3)
          });
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.customTokens.description.part4));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.customTokens.description.part5));
        }),
        name: t(($: any) => $.pluginSettingsTab.customTokens.name),
        render: (setting) => {
          // Render-time setup: the builder must stay pure, because Obsidian calls it at plugin load to
          // index the settings for search. `hide()` clears the flag again.
          this.pluginSettingsComponent2.shouldDebounceCustomTokensValidation = true;
          // eslint-disable-next-line unicorn/name-replacements -- `customTokensStr` is a persisted `data.json` settings key; renaming it would silently drop the user's custom tokens.
          const registerCustomTokensDebounced = debounce((customTokensStr: string) => {
            invokeAsyncSafely(async () => {
              Substitutions.registerCustomTokens(customTokensStr);
              await this.revalidate();
            });
          }, REGISTER_CUSTOM_TOKENS_DEBOUNCE_IN_MILLISECONDS);

          setting.addCodeHighlighter((codeHighlighter) => {
            codeHighlighter.setLanguage('javascript');
            codeHighlighter.inputEl.addClass('custom-tokens-setting-control');
            this.bind({
              onChanged: (newValue) => {
                registerCustomTokensDebounced(newValue);
              },
              propertyName: 'customTokensStr',
              valueComponent: codeHighlighter
            });
          });

          return () => {
            registerCustomTokensDebounced.cancel();
          };
        }
      }),
      this.settingEx({
        name: '',
        render: (setting) => {
          setting.addButton((button) => {
            button.setButtonText(t(($: any) => $.pluginSettingsTab.resetToSampleCustomTokens.title));
            button.setDestructive();
            button.onClick(convertAsyncToSync(async () => {
              if (
                (this.pluginSettingsComponent.settings.customTokensStr === SAMPLE_CUSTOM_TOKENS) || (this.pluginSettingsComponent.settings.customTokensStr !== '' && !await confirm({
                  app: this.app,
                  cancelButtonText: t(($: any) => $.obsidianDevUtils.buttons.cancel),
                  message: t(($: any) => $.pluginSettingsTab.resetToSampleCustomTokens.message),
                  okButtonText: t(($: any) => $.obsidianDevUtils.buttons.ok),
                  title: t(($: any) => $.pluginSettingsTab.resetToSampleCustomTokens.title)
                }))
              ) {
                return;
              }

              await this.pluginSettingsComponent.editAndSave((settings) => {
                // eslint-disable-next-line unicorn/name-replacements -- `customTokensStr` is a persisted `data.json` settings key; renaming it would silently drop the user's custom tokens.
                settings.customTokensStr = SAMPLE_CUSTOM_TOKENS;
              });
              this.refresh();
            }));
          });
        },
        // The row is a bare action button with no name, so there is nothing to match on.
        searchable: false
      })
    ];
  }

  private getImagesItems(): SettingDefinitionRender[] {
    return [
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.defaultImageSize.description.part1));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.defaultImageSize.description.part2));
          f.appendText(' (');
          appendCodeBlock(f, '300px');
          f.appendText(') ');
          f.appendText(t(($: any) => $.pluginSettingsTab.defaultImageSize.description.part3));
          f.appendText(' (');
          appendCodeBlock(f, '50%');
          f.appendText(').');
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.defaultImageSize.description.part4));
        }),
        name: t(($: any) => $.pluginSettingsTab.defaultImageSize.name),
        render: (setting) => {
          setting
            .addText((text) => {
              this.bind({
                propertyName: 'defaultImageSize',
                valueComponent: text
              });
            })
            .addDropdown((dropdown) => {
              dropdown.selectEl.addClass('default-image-size-dimension-setting-control');
              dropdown.addOptions({
                /* eslint-disable perfectionist/sort-objects -- Need to keep enum order. */
                [DefaultImageSizeDimension.Width]: t(($: any) => $.pluginSettings.defaultImageSizeDimension.width),
                [DefaultImageSizeDimension.Height]: t(($: any) => $.pluginSettings.defaultImageSizeDimension.height)
                /* eslint-enable perfectionist/sort-objects -- Need to keep enum order. */
              });
              this.bind({
                propertyName: 'defaultImageSizeDimension',
                valueComponent: dropdown
              });
            });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.convertImagesToJpegMode.description.part1));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.convertImagesToJpegMode.none.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.convertImagesToJpegMode.none.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.convertImagesToJpegMode.onlyPastedClipboardPngImages.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.convertImagesToJpegMode.onlyPastedClipboardPngImages.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.convertImagesToJpegMode.allImagesExceptAlreadyJpeg.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.convertImagesToJpegMode.allImagesExceptAlreadyJpeg.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.convertImagesToJpegMode.allImages.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.convertImagesToJpegMode.allImages.description));
        }),
        name: t(($: any) => $.pluginSettingsTab.convertImagesToJpegMode.name),
        render: (setting) => {
          setting.addDropdown((dropdown) => {
            dropdown.addOptions({
              /* eslint-disable perfectionist/sort-objects -- Need to keep enum order. */
              [ConvertImagesToJpegMode.None]: t(($: any) => $.pluginSettings.convertImagesToJpegMode.none.displayText),
              [ConvertImagesToJpegMode.OnlyPastedClipboardPngImages]: t(($: any) => $.pluginSettings.convertImagesToJpegMode.onlyPastedClipboardPngImages.displayText),
              [ConvertImagesToJpegMode.AllImagesExceptAlreadyJpegFiles]: t(($: any) => $.pluginSettings.convertImagesToJpegMode.allImagesExceptAlreadyJpeg.displayText),
              [ConvertImagesToJpegMode.AllImages]: t(($: any) => $.pluginSettings.convertImagesToJpegMode.allImages.displayText)
              /* eslint-enable perfectionist/sort-objects -- Need to keep enum order. */
            });
            this.bind({
              onChanged: () => {
                // The metadata row below only reads this value through its `disabled` predicate.
                this.refreshDomState();
              },
              propertyName: 'convertImagesToJpegMode',
              valueComponent: dropdown
            });
          });
        }
      }),
      this.settingEx({
        desc: t(($: any) => $.pluginSettingsTab.jpegQuality.description),
        name: t(($: any) => $.pluginSettingsTab.jpegQuality.name),
        render: (setting) => {
          setting.addDropdown((dropDown) => {
            dropDown.addOptions(generateJpegQualityOptions());
            this.bind({
              componentToPluginSettingsValueConverter: Number,
              pluginSettingsToComponentValueConverter: (value) => value.toPrecision(JPEG_QUALITY_PRECISION),
              propertyName: 'jpegQuality',
              valueComponent: dropDown
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.shouldPreserveImageMetadata.description.part1));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.shouldPreserveImageMetadata.description.part2));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.shouldPreserveImageMetadata.description.part3));
        }),
        disabled: () => this.pluginSettingsComponent.settings.convertImagesToJpegMode === ConvertImagesToJpegMode.None,
        name: t(($: any) => $.pluginSettingsTab.shouldPreserveImageMetadata.name),
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldPreserveImageMetadata',
              valueComponent: toggle
            });
          });
        }
      })
    ];
  }

  private getMoveRenamesItems(): SettingDefinitionRender[] {
    return [
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.duplicateNameSeparator.description.part1));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.duplicateNameSeparator.description.part2));
          f.appendText(' ');
          appendCodeBlock(f, 'existingFile.pdf');
          f.appendText(t(($: any) => $.pluginSettingsTab.duplicateNameSeparator.description.part3));
          f.appendText(' ');
          appendCodeBlock(f, 'existingFile 1.pdf');
          f.appendText(', ');
          appendCodeBlock(f, 'existingFile 2.pdf');
          f.appendText(t(($: any) => $.pluginSettingsTab.duplicateNameSeparator.description.part4));
        }),
        name: t(($: any) => $.pluginSettingsTab.duplicateNameSeparator.name),
        render: (setting) => {
          setting.addText((text) => {
            this.bind({
              componentToPluginSettingsValueConverter: restoreSpaceCharacter,
              pluginSettingsToComponentValueConverter: showSpaceCharacter,
              propertyName: 'duplicateNameSeparator',
              valueComponent: text
            });

            handleWhitespace(text);
          });
        }
      }),
      this.settingEx({
        desc: t(($: any) => $.pluginSettingsTab.shouldDeduplicateIdenticalAttachments.description),
        name: t(($: any) => $.pluginSettingsTab.shouldDeduplicateIdenticalAttachments.name),
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldDeduplicateIdenticalAttachments',
              valueComponent: toggle
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.attachmentRenameMode.description.part1));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.attachmentRenameMode.none.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.attachmentRenameMode.none.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.attachmentRenameMode.onlyPastedImages.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.attachmentRenameMode.onlyPastedImages.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.attachmentRenameMode.all.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.attachmentRenameMode.all.description));
        }),
        name: t(($: any) => $.pluginSettingsTab.attachmentRenameMode.name),
        render: (setting) => {
          setting.addDropdown((dropdown) => {
            dropdown.addOptions({
              /* eslint-disable perfectionist/sort-objects -- Need to keep enum order. */
              [AttachmentRenameMode.None]: t(($: any) => $.pluginSettings.attachmentRenameMode.none.displayText),
              [AttachmentRenameMode.OnlyPastedImages]: t(($: any) => $.pluginSettings.attachmentRenameMode.onlyPastedImages.displayText),
              [AttachmentRenameMode.All]: t(($: any) => $.pluginSettings.attachmentRenameMode.all.displayText)
              /* eslint-enable perfectionist/sort-objects -- Need to keep enum order. */
            });
            this.bind({
              propertyName: 'attachmentRenameMode',
              valueComponent: dropdown
            });
          });
        }
      }),
      this.settingEx({
        desc: t(($: any) => $.pluginSettingsTab.shouldKeepNamesOfPastedNonScreenshotFiles.description),
        name: t(($: any) => $.pluginSettingsTab.shouldKeepNamesOfPastedNonScreenshotFiles.name),
        render: (setting) => {
          setting.addToggle((toggle) => {
            this.bind({
              propertyName: 'shouldKeepNamesOfPastedNonScreenshotFiles',
              valueComponent: toggle
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.screenshotFilePaths.description.part1));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.screenshotFilePaths.description.part2));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.screenshotFilePaths.description.part3));
          f.appendText(' ');
          appendCodeBlock(f, t(($: any) => $.regularExpression));
          f.appendText('.');
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.screenshotFilePaths.description.part4));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.screenshotFilePaths.description.part5));
        }),
        name: t(($: any) => $.pluginSettingsTab.screenshotFilePaths.name),
        render: (setting) => {
          setting.addMultipleText((multipleText) => {
            this.bind({
              propertyName: 'screenshotFilePaths',
              valueComponent: multipleText
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.renameAttachmentsCreatedByOtherPluginsMode.description.part1));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.renameAttachmentsCreatedByOtherPluginsMode.description.part2));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.renameAttachmentsCreatedByOtherPluginsMode.description.part3));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.renameAttachmentsCreatedByOtherPluginsMode.none.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.renameAttachmentsCreatedByOtherPluginsMode.none.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.renameAttachmentsCreatedByOtherPluginsMode.all.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.renameAttachmentsCreatedByOtherPluginsMode.all.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.renameAttachmentsCreatedByOtherPluginsMode.onlyListedPlugins.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.renameAttachmentsCreatedByOtherPluginsMode.onlyListedPlugins.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.renameAttachmentsCreatedByOtherPluginsMode.allExceptListedPlugins.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.renameAttachmentsCreatedByOtherPluginsMode.allExceptListedPlugins.description));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.renameAttachmentsCreatedByOtherPluginsMode.description.part4));
        }),
        name: t(($: any) => $.pluginSettingsTab.renameAttachmentsCreatedByOtherPluginsMode.name),
        render: (setting) => {
          setting.addDropdown((dropdown) => {
            dropdown.addOptions({
              /* eslint-disable perfectionist/sort-objects -- Need to keep enum order. */
              [RenameAttachmentsCreatedByOtherPluginsMode.None]: t(($: any) => $.pluginSettings.renameAttachmentsCreatedByOtherPluginsMode.none.displayText),
              [RenameAttachmentsCreatedByOtherPluginsMode.All]: t(($: any) => $.pluginSettings.renameAttachmentsCreatedByOtherPluginsMode.all.displayText),
              [RenameAttachmentsCreatedByOtherPluginsMode.OnlyListedPlugins]: t(($: any) => $.pluginSettings.renameAttachmentsCreatedByOtherPluginsMode.onlyListedPlugins.displayText),
              [RenameAttachmentsCreatedByOtherPluginsMode.AllExceptListedPlugins]: t(($: any) => $.pluginSettings.renameAttachmentsCreatedByOtherPluginsMode.allExceptListedPlugins.displayText)
              /* eslint-enable perfectionist/sort-objects -- Need to keep enum order. */
            });
            this.bind({
              onChanged: () => {
                // The plugin list below is only shown for the two list modes, via its `visible` predicate.
                this.refreshDomState();
              },
              propertyName: 'renameAttachmentsCreatedByOtherPluginsMode',
              valueComponent: dropdown
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.otherPluginIdsForAttachmentRename.description.part1));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.otherPluginIdsForAttachmentRename.description.part2));
        }),
        name: t(($: any) => $.pluginSettingsTab.otherPluginIdsForAttachmentRename.name),
        render: (setting) => {
          setting.addMultipleDropdown((multipleDropdown) => {
            multipleDropdown.addOptions(this.getSelectablePluginOptions());
            this.bind({
              propertyName: 'otherPluginIdsForAttachmentRename',
              valueComponent: multipleDropdown
            });
          });
        },
        visible: () => this.pluginSettingsComponent.settings.needsCreatingPluginAttribution()
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.renamedAttachmentFileName.description.part1));
          f.appendText(' ');
          f.createEl('a', {
            href: 'https://github.com/mnaoumov/obsidian-custom-attachment-location?tab=readme-ov-file#tokens',
            text: t(($: any) => $.pluginSettingsTab.renamedAttachmentFileName.description.part2)
          });
          f.appendText('.');
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.renamedAttachmentFileName.description.part3));
        }),
        name: t(($: any) => $.pluginSettingsTab.renamedAttachmentFileName.name),
        render: (setting) => {
          setting.addCodeHighlighter((codeHighlighter) => {
            codeHighlighter.setLanguage(TOKENIZED_STRING_LANGUAGE);
            codeHighlighter.inputEl.addClass('tokenized-string-setting-control');
            this.bind({
              propertyName: 'renamedAttachmentFileName',
              valueComponent: codeHighlighter,
              ...bindOptionsWithTrim
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.moveAttachmentToProperFolderUsedByMultipleNotesMode.description.part1));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.moveAttachmentToProperFolderUsedByMultipleNotesMode.skip.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.moveAttachmentToProperFolderUsedByMultipleNotesMode.skip.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.moveAttachmentToProperFolderUsedByMultipleNotesMode.copyAll.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.moveAttachmentToProperFolderUsedByMultipleNotesMode.copyAll.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.moveAttachmentToProperFolderUsedByMultipleNotesMode.cancel.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.moveAttachmentToProperFolderUsedByMultipleNotesMode.cancel.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.moveAttachmentToProperFolderUsedByMultipleNotesMode.prompt.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.moveAttachmentToProperFolderUsedByMultipleNotesMode.prompt.description));
        }),
        name: t(($: any) => $.pluginSettingsTab.moveAttachmentToProperFolderUsedByMultipleNotesMode.name),
        render: (setting) => {
          setting.addDropdown((dropdown) => {
            dropdown.addOptions({
              /* eslint-disable perfectionist/sort-objects -- Need to keep enum order. */
              [MoveAttachmentToProperFolderUsedByMultipleNotesMode.Skip]: t(($: any) => $.pluginSettings.moveAttachmentToProperFolderUsedByMultipleNotesMode.skip.displayText),
              [MoveAttachmentToProperFolderUsedByMultipleNotesMode.CopyAll]: t(($: any) => $.pluginSettings.moveAttachmentToProperFolderUsedByMultipleNotesMode.copyAll.displayText),
              [MoveAttachmentToProperFolderUsedByMultipleNotesMode.Cancel]: t(($: any) => $.pluginSettings.moveAttachmentToProperFolderUsedByMultipleNotesMode.cancel.displayText),
              [MoveAttachmentToProperFolderUsedByMultipleNotesMode.Prompt]: t(($: any) => $.pluginSettings.moveAttachmentToProperFolderUsedByMultipleNotesMode.prompt.displayText)
              /* eslint-enable perfectionist/sort-objects -- Need to keep enum order. */
            });
            this.bind({
              propertyName: 'moveAttachmentToProperFolderUsedByMultipleNotesMode',
              valueComponent: dropdown
            });
          });
        }
      })
    ];
  }

  private getPathItems(): SettingDefinitionRender[] {
    return [
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.attachmentUnitFolderPaths.description.part1));
          f.appendText(' ');
          appendCodeBlock(f, t(($: any) => $.pluginSettingsTab.attachmentUnitFolderPaths.description.part2));
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.attachmentUnitFolderPaths.description.part3));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.attachmentUnitFolderPaths.description.part4));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.attachmentUnitFolderPaths.description.part5));
          f.createEl('br');
          appendPathEntrySyntax(f);
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.attachmentUnitFolderPaths.description.part8));
        }),
        name: t(($: any) => $.pluginSettingsTab.attachmentUnitFolderPaths.name),
        render: (setting) => {
          setting.addMultipleText((multipleText) => {
            this.bind({
              propertyName: 'attachmentUnitFolderPaths',
              valueComponent: multipleText
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.excludePathsFromAttachmentCollecting.description.part1));
          f.appendText(' ');
          appendCodeBlock(f, t(($: any) => $.pluginSettingsTab.excludePathsFromAttachmentCollecting.description.part2));
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.excludePathsFromAttachmentCollecting.description.part3));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.excludePathsFromAttachmentCollecting.description.part4));
          f.createEl('br');
          appendPathEntrySyntax(f);
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.excludePathsFromAttachmentCollecting.description.part6));
        }),
        name: t(($: any) => $.pluginSettingsTab.excludePathsFromAttachmentCollecting.name),
        render: (setting) => {
          setting.addMultipleText((multipleText) => {
            this.bind({
              propertyName: 'excludePathsFromAttachmentCollecting',
              valueComponent: multipleText
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.excludeExtensionsFromMultipleNotesCheck.description.part1));
          f.appendText(' ');
          appendCodeBlock(f, t(($: any) => $.pluginSettingsTab.excludeExtensionsFromMultipleNotesCheck.description.part2));
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.excludeExtensionsFromMultipleNotesCheck.description.part3));
          f.appendText(' ');
          appendCodeBlock(f, t(($: any) => $.pluginSettingsTab.excludeExtensionsFromMultipleNotesCheck.description.part4));
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.excludeExtensionsFromMultipleNotesCheck.description.part5));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.excludeExtensionsFromMultipleNotesCheck.description.part6));
          f.appendText(' ');
          appendCodeBlock(f, t(($: any) => $.pluginSettingsTab.excludeExtensionsFromMultipleNotesCheck.description.part7));
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.excludeExtensionsFromMultipleNotesCheck.description.part8));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.excludeExtensionsFromMultipleNotesCheck.description.part9));
        }),
        name: t(($: any) => $.pluginSettingsTab.excludeExtensionsFromMultipleNotesCheck.name),
        render: (setting) => {
          setting.addMultipleText((multipleText) => {
            this.bind({
              propertyName: 'excludeExtensionsFromMultipleNotesCheck',
              valueComponent: multipleText
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.excludePathsFromMultipleNotesCheck.description.part1));
          f.appendText(' ');
          appendCodeBlock(f, t(($: any) => $.pluginSettingsTab.excludePathsFromMultipleNotesCheck.description.part2));
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.excludePathsFromMultipleNotesCheck.description.part3));
          f.appendText(' ');
          appendCodeBlock(f, t(($: any) => $.pluginSettingsTab.excludePathsFromMultipleNotesCheck.description.part4));
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.excludePathsFromMultipleNotesCheck.description.part5));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.excludePathsFromMultipleNotesCheck.description.part6));
          f.createEl('br');
          appendPathEntrySyntax(f);
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.excludePathsFromMultipleNotesCheck.description.part8));
        }),
        name: t(($: any) => $.pluginSettingsTab.excludePathsFromMultipleNotesCheck.name),
        render: (setting) => {
          setting.addMultipleText((multipleText) => {
            this.bind({
              propertyName: 'excludePathsFromMultipleNotesCheck',
              valueComponent: multipleText
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.orphanAttachmentScanMode.description.part1));
          f.appendText(' ');
          appendCodeBlock(f, t(($: any) => $.pluginSettingsTab.orphanAttachmentScanMode.description.part2));
          f.appendText(' ');
          f.appendText(t(($: any) => $.pluginSettingsTab.orphanAttachmentScanMode.description.part3));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.orphanAttachmentScanMode.description.part4));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.orphanAttachmentScanMode.description.part5));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.orphanAttachmentScanMode.none.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.orphanAttachmentScanMode.none.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.orphanAttachmentScanMode.listedPaths.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.orphanAttachmentScanMode.listedPaths.description));
          f.createEl('br');
          appendCodeBlock(f, t(($: any) => $.pluginSettings.orphanAttachmentScanMode.entireVault.displayText));
          f.appendText(' - ');
          f.appendText(t(($: any) => $.pluginSettings.orphanAttachmentScanMode.entireVault.description));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.orphanAttachmentScanMode.description.part6));
        }),
        name: t(($: any) => $.pluginSettingsTab.orphanAttachmentScanMode.name),
        render: (setting) => {
          setting.addDropdown((dropdown) => {
            dropdown.addOptions({
              /* eslint-disable perfectionist/sort-objects -- Need to keep enum order. */
              [OrphanAttachmentScanMode.None]: t(($: any) => $.pluginSettings.orphanAttachmentScanMode.none.displayText),
              [OrphanAttachmentScanMode.ListedPaths]: t(($: any) => $.pluginSettings.orphanAttachmentScanMode.listedPaths.displayText),
              [OrphanAttachmentScanMode.EntireVault]: t(($: any) => $.pluginSettings.orphanAttachmentScanMode.entireVault.displayText)
              /* eslint-enable perfectionist/sort-objects -- Need to keep enum order. */
            });
            this.bind({
              onChanged: () => {
                // The path list below is only shown for the listed-paths mode, via its `visible` predicate.
                this.refreshDomState();
              },
              propertyName: 'orphanAttachmentScanMode',
              valueComponent: dropdown
            });
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.orphanAttachmentScanPaths.description.part1));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.orphanAttachmentScanPaths.description.part2));
          f.createEl('br');
          appendPathEntrySyntax(f);
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.orphanAttachmentScanPaths.description.part5));
        }),
        name: t(($: any) => $.pluginSettingsTab.orphanAttachmentScanPaths.name),
        render: (setting) => {
          setting.addMultipleText((multipleText) => {
            this.bind({
              propertyName: 'orphanAttachmentScanPaths',
              valueComponent: multipleText
            });
          });
        },
        visible: () => this.pluginSettingsComponent.settings.needsOrphanAttachmentScanPaths()
      })
    ];
  }

  /**
   * The plugins offered in the picker, as plugin id -> display name.
   *
   * Built from the installed manifests so the user picks a plugin by NAME — the id is a folder name under
   * `.obsidian/plugins` that the Obsidian UI never shows, so asking for it by hand would be guesswork.
   *
   * Any id already stored is added back even when its plugin is currently disabled or no longer installed,
   * listed under the bare id since there is no manifest to name it. Without that, merely opening this tab
   * would drop the entry — the picker cannot hold a value it has no option for.
   *
   * @returns The options for the plugin picker.
   */
  private getSelectablePluginOptions(): Record<string, string> {
    const options: Record<string, string> = {};

    for (const manifest of Object.values(this.app.plugins.manifests)) {
      if (manifest.id === this.ownPluginId) {
        continue;
      }

      options[manifest.id] = manifest.name;
    }

    for (const pluginId of this.pluginSettingsComponent.settings.otherPluginIdsForAttachmentRename) {
      options[pluginId] ??= pluginId;
    }

    return options;
  }

  private getSpecialCharactersItems(): SettingDefinitionRender[] {
    return [
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.specialCharacters.description.part1));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.specialCharacters.description.part2));
        }),
        name: t(($: any) => $.pluginSettingsTab.specialCharacters.name),
        render: (setting) => {
          setting.addText((text) => {
            this.bind({
              componentToPluginSettingsValueConverter: restoreSpaceCharacter,
              pluginSettingsToComponentValueConverter: showSpaceCharacter,
              propertyName: 'specialCharacters',
              shouldResetSettingWhenComponentIsEmpty: false,
              shouldShowPlaceholderForDefaultValues: false,
              valueComponent: text
            });

            handleWhitespace(text);
          });
        }
      }),
      this.settingEx({
        desc: createFragment((f) => {
          f.appendText(t(($: any) => $.pluginSettingsTab.specialCharactersReplacement.description.part1));
          f.createEl('br');
          f.appendText(t(($: any) => $.pluginSettingsTab.specialCharactersReplacement.description.part2));
        }),
        name: t(($: any) => $.pluginSettingsTab.specialCharactersReplacement.name),
        render: (setting) => {
          setting.addText((text) => {
            this.bind({
              componentToPluginSettingsValueConverter: restoreSpaceCharacter,
              pluginSettingsToComponentValueConverter: showSpaceCharacter,
              propertyName: 'specialCharactersReplacement',
              shouldResetSettingWhenComponentIsEmpty: false,
              shouldShowPlaceholderForDefaultValues: false,
              valueComponent: text
            });
          });
        }
      })
    ];
  }
}

/**
 * Explains the entry syntax every vault path list shares, which is `@mnaoumov/obsidian-lib`'s `PathSettings`.
 *
 * One helper for the four lists, so their descriptions cannot drift from each other or from what the library matches.
 *
 * @param f - The description fragment to append to.
 */
function appendPathEntrySyntax(f: DocumentFragment): void {
  f.appendText(t(($: any) => $.pluginSettingsTab.pathEntrySyntax.intro));
  f.createEl('br');
  appendCodeBlock(f, 'Archive/Old');
  f.appendText(' ');
  f.appendText(t(($: any) => $.pluginSettingsTab.pathEntrySyntax.plainPath));
  f.createEl('br');
  appendCodeBlock(f, '*.pdf');
  f.appendText(', ');
  appendCodeBlock(f, 'Archive/**/*.png');
  f.appendText(', ');
  appendCodeBlock(f, '*_files/');
  f.appendText(' ');
  f.appendText(t(($: any) => $.pluginSettingsTab.pathEntrySyntax.glob));
  f.createEl('br');
  appendCodeBlock(f, String.raw`/^Archive\/\d{4}\//`);
  f.appendText(' ');
  f.appendText(t(($: any) => $.pluginSettingsTab.pathEntrySyntax.regularExpression));
  f.createEl('br');
  f.appendText(t(($: any) => $.pluginSettingsTab.pathEntrySyntax.escape));
}

function generateJpegQualityOptions(): Record<string, string> {
  const MAX_QUALITY = 20;
  const ans: Record<string, string> = {};
  for (let index = 1; index <= MAX_QUALITY; index++) {
    const valueString = (index / MAX_QUALITY).toFixed(JPEG_QUALITY_PRECISION);
    ans[valueString] = valueString;
  }

  return ans;
}

function handleWhitespace(text: TextComponent): void {
  text.inputEl.addEventListener('input', () => {
    const start = text.inputEl.selectionStart ?? 0;
    const end = text.inputEl.selectionEnd ?? 0;
    text.inputEl.value = showSpaceCharacter(text.inputEl.value);
    text.inputEl.setSelectionRange(start, end);
  });
}

function restoreSpaceCharacter($string: string): string {
  return $string.replaceAll(VISIBLE_SPACE_CHARACTER, ' ');
}

function showSpaceCharacter($string: string): string {
  return $string.replaceAll(' ', () => VISIBLE_SPACE_CHARACTER);
}
