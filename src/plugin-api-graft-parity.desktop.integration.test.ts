import { evalInObsidian } from 'obsidian-integration-testing';
import { getTemporaryVault } from 'obsidian-integration-testing/vitest-global-setup-plugin';
import {
  describe,
  expect,
  it
} from 'vitest';

import { findPluginSettingsComponent } from '../scripts/helpers/plugin-settings-component-finder.ts';

/*
 * End-to-end coverage for the two API members that replace the members grafted onto the patched
 * `Vault.getAvailablePathForAttachments`: `getAvailablePathForAttachments` for `extended`, and
 * `isAttachmentUnitFolder` for `checkIsAttachmentUnitFolder`.
 *
 * A library moves from the graft to the API without changing what it computes, so the claim under test is
 * PARITY: asked the same questions in the same vault, the graft and the API answer the same. The questions are
 * chosen so that a member answering with a constant, or with Obsidian's own location, would differ — a note
 * whose folder template is this plugin's, the same question asked as a rename with an old note path (so the
 * context is mapped rather than dropped), and a designated folder beside a plain one.
 */

const PLUGIN_ID = 'obsidian-custom-attachment-location';
const ATTACHMENT_FOLDER_PATH = './_/{{noteFileName}}';
const DESIGNATED_FOLDER_PATH = 'Materials/page_files';
const PLAIN_FOLDER_PATH = 'Materials';

interface ProbeResult {
  readonly apiFound: boolean;
  readonly apiPaths: readonly string[];
  readonly apiUnitFolderAnswers: readonly boolean[];
  readonly graftFound: boolean;
  readonly graftPaths: readonly string[];
  readonly graftUnitFolderAnswers: readonly boolean[];
  readonly settingsFound: boolean;
}

describe('The plugin API answers as the getAvailablePathForAttachments graft does', () => {
  it('gives the same attachment paths and the same unit-folder answers', async () => {
    const result = await evalInObsidian({
      async callback({
        app,
        attachmentFolderPath,
        designatedFolderPath,
        findPluginSettingsComponent: findSettingsComponent,
        plainFolderPath,
        pluginId
      }): Promise<ProbeResult> {
        interface ResolverParams {
          readonly attachmentFileBaseName: string;
          readonly attachmentFileExtension: string;
          readonly context: 'DeleteNote' | 'RenameNote' | 'Unknown';
          readonly notePathOrFile: null | string;
          readonly oldAttachmentPathOrFile: string;
          readonly oldNotePathOrFile?: string;
          readonly readAttachmentFileContent: null;
          readonly shouldSkipGeneratedAttachmentFileName?: boolean;
          readonly shouldSkipMissingAttachmentFolderCreation: boolean;
        }

        interface ApiLike {
          getAvailablePathForAttachments: (params: ResolverParams) => Promise<string>;
          isAttachmentUnitFolder: (params: UnitFolderParams) => boolean;
        }

        interface GraftLike {
          checkIsAttachmentUnitFolder: (folderPath: string) => boolean;
          extended: (params: ResolverParams) => Promise<string>;
        }

        interface ApiRecord {
          readonly api: unknown;
          readonly isRevoked: boolean;
        }

        interface UnitFolderParams {
          readonly folderPath: string;
        }

        interface ObsidianDevUtilsWrapper {
          readonly __obsidianDevUtils: ObsidianDevUtilsState;
        }

        interface ObsidianDevUtilsState {
          readonly pluginApiRegistry?: RegistryWrapper;
        }

        interface RegistryWrapper {
          readonly value?: RegistryValue;
        }

        interface RegistryValue {
          readonly records?: Record<string, ApiRecord[]>;
        }

        interface ParitySettings {
          attachmentFolderPath: string;
          attachmentUnitFolderPaths: string[];
          isAttachmentUnitFolder: (path: string) => boolean;
        }

        const EMPTY: ProbeResult = {
          apiFound: false,
          apiPaths: [],
          apiUnitFolderAnswers: [],
          graftFound: false,
          graftPaths: [],
          graftUnitFolderAnswers: [],
          settingsFound: false
        };

        function isApiLike(value: unknown): value is ApiLike {
          const record = value as null | Record<string, unknown>;
          return typeof value === 'object' && record !== null
            && typeof record['getAvailablePathForAttachments'] === 'function'
            && typeof record['isAttachmentUnitFolder'] === 'function';
        }

        function isGraftLike(value: unknown): value is GraftLike {
          return typeof Reflect.get(value as object, 'extended') === 'function'
            && typeof Reflect.get(value as object, 'checkIsAttachmentUnitFolder') === 'function';
        }

        function isParitySettings(value: unknown): value is ParitySettings {
          const record = value as null | Record<string, unknown>;
          return typeof value === 'object' && record !== null
            && typeof record['attachmentFolderPath'] === 'string'
            && typeof record['isAttachmentUnitFolder'] === 'function';
        }

        const record = (window as Partial<ObsidianDevUtilsWrapper>).__obsidianDevUtils?.pluginApiRegistry?.value?.records?.[pluginId]
          ?.find((candidate) => !candidate.isRevoked);
        const api = record && isApiLike(record.api) ? record.api : null;
        // Read the way a foreign plugin does: off `app.vault` alone.
        const graftCandidate: unknown = app.vault.getAvailablePathForAttachments;
        const graft = isGraftLike(graftCandidate) ? graftCandidate : null;

        if (!api || !graft) {
          return { ...EMPTY, apiFound: api !== null, graftFound: graft !== null };
        }

        const settingsComponent = findSettingsComponent(app.plugins.getPlugin(pluginId), isParitySettings);
        if (!settingsComponent) {
          return { ...EMPTY, apiFound: true, graftFound: true };
        }

        const priorFolderPath = settingsComponent.settings.attachmentFolderPath;
        const priorUnitFolderPaths = settingsComponent.settings.attachmentUnitFolderPaths;
        const stamp = `${Date.now().toString()}-${Math.floor(performance.now()).toString()}`;
        const notePath = `parity-${stamp}.md`;

        const questions: ResolverParams[] = [
          {
            attachmentFileBaseName: 'image',
            attachmentFileExtension: 'png',
            context: 'Unknown',
            notePathOrFile: notePath,
            oldAttachmentPathOrFile: 'image.png',
            readAttachmentFileContent: null,
            shouldSkipGeneratedAttachmentFileName: true,
            shouldSkipMissingAttachmentFolderCreation: true
          },
          {
            attachmentFileBaseName: 'image',
            attachmentFileExtension: 'png',
            context: 'RenameNote',
            notePathOrFile: notePath,
            oldAttachmentPathOrFile: 'image.png',
            oldNotePathOrFile: `parity-old-${stamp}.md`,
            readAttachmentFileContent: null,
            shouldSkipGeneratedAttachmentFileName: true,
            shouldSkipMissingAttachmentFolderCreation: true
          }
        ];
        const folderPaths = [designatedFolderPath, plainFolderPath];

        try {
          await settingsComponent.editAndSave((settings) => {
            settings.attachmentFolderPath = attachmentFolderPath;
            settings.attachmentUnitFolderPaths = [designatedFolderPath];
          });
          await app.vault.create(notePath, '');

          const graftPaths: string[] = [];
          const apiPaths: string[] = [];
          for (const question of questions) {
            graftPaths.push(await graft.extended(question));
            apiPaths.push(await api.getAvailablePathForAttachments(question));
          }

          return {
            apiFound: true,
            apiPaths,
            apiUnitFolderAnswers: folderPaths.map((folderPath) => api.isAttachmentUnitFolder({ folderPath })),
            graftFound: true,
            graftPaths,
            graftUnitFolderAnswers: folderPaths.map((folderPath) => graft.checkIsAttachmentUnitFolder(folderPath)),
            settingsFound: true
          };
        } finally {
          await settingsComponent.editAndSave((settings) => {
            settings.attachmentFolderPath = priorFolderPath;
            settings.attachmentUnitFolderPaths = priorUnitFolderPaths;
          });
          const note = app.vault.getAbstractFileByPath(notePath);
          if (note) {
            await app.fileManager.trashFile(note);
          }
        }
      },
      input: {
        attachmentFolderPath: ATTACHMENT_FOLDER_PATH,
        designatedFolderPath: DESIGNATED_FOLDER_PATH,
        findPluginSettingsComponent,
        plainFolderPath: PLAIN_FOLDER_PATH,
        pluginId: PLUGIN_ID
      },
      vaultPath: getTemporaryVault().path
    });

    expect(result.apiFound).toBe(true);
    expect(result.graftFound).toBe(true);
    expect(result.settingsFound).toBe(true);

    // This plugin's template, not Obsidian's location: a member answering with Obsidian's would not match.
    expect(result.graftPaths[0]).toMatch(/^_\/parity-.*\/image\.png$/);
    expect(result.apiPaths).toEqual(result.graftPaths);

    expect(result.graftUnitFolderAnswers).toEqual([true, false]);
    expect(result.apiUnitFolderAnswers).toEqual(result.graftUnitFolderAnswers);
  }, 120_000);
});
