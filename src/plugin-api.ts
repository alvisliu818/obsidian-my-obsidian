/**
 * @file
 *
 * The runtime half of this plugin's published contract: the registry contract and its version. The contract
 * itself is the repo-root `api-contract.ts`, which a consumer copies beside `api.d.ts`.
 *
 * The TYPES are not declared here. They live in the repo-root `api.d.ts`, which is the file a consumer
 * reads, and are re-exported from it so there is exactly one declaration of each and nothing to drift.
 */

import type { ApiContract } from '@mnaoumov/typescript-lib/api-contract';

import { CUSTOM_ATTACHMENT_LOCATION_API_CONTRACT } from '../api-contract.ts';

export type {
  AttachmentPathContext,
  CollectAttachmentsParams,
  CollectAttachmentUsedByMultipleNotesMode,
  CustomAttachmentLocationApi,
  GetAttachmentFolderPathParams,
  GetAvailablePathForAttachmentsParams,
  GetProperAttachmentPathParams,
  IsAttachmentUnitFolderParams,
  MigratableCollectSettings,
  MigrateSettingsParams,
  MigrateSettingsResult,
  MoveAttachmentToProperFolderUsedByMultipleNotesMode
} from '../api.d.ts';

/**
 * The contract this plugin publishes: the repo-root `api-contract.ts` constant a consumer copies, so the
 * provider and its consumers validate against one definition. Assigning it here is also what checks that the
 * hand-written schemas are Standard Schemas the registry accepts.
 */
export const PLUGIN_API_CONTRACT: ApiContract = CUSTOM_ATTACHMENT_LOCATION_API_CONTRACT;

/**
 * The version of the contract above — independent of the plugin's own version, so a consumer asks for `'^1'`
 * and keeps working across releases that change nothing it depends on.
 *
 * `1.0.0` is the pair of per-note reads. `1.1.0` adds `migrateSettings`, which receives the collect settings
 * `Consistent Attachments and Links` hands over when it stops collecting. That is purely additive, so a consumer
 * of the reads keeps asking for `'^1'`, and a consumer of the migration asks for `'^1.1.0'`. `1.2.0` adds
 * `collectAttachments`, the declared replacement for the plugin instance's `collectAttachmentsInAbstractFiles`,
 * so a consumer of it asks for `'^1.2.0'`. `1.3.0` adds `getAvailablePathForAttachments` and
 * `isAttachmentUnitFolder`, the attachment-path policy a library used to read off members grafted onto
 * `Vault.getAvailablePathForAttachments`, so a consumer of them asks for `'^1.3.0'`.
 */
export const PLUGIN_API_VERSION = '1.3.0';
