import type { ImportedAttachment } from '@obsidian-typings/obsidian-public-latest';

import type { ArrayBufferMap } from './array-buffer-map.ts';
import type { InsertGesture } from './insert-gesture-tracker-component.ts';

import { isPastedImage } from './pasted-image-classifier.ts';

interface PastedImageMarkerConstructorParams {
  readonly arrayBufferMap: ArrayBufferMap;
  readonly getScreenshotFilePaths: (this: void) => readonly string[];
}

/**
 * Records, for the attachments Obsidian is about to save, the file stats and whether each one is a pasted image.
 *
 * Both are keyed by the attachment's `ArrayBuffer`, which is the one value that reaches `AttachmentSaver` unchanged,
 * so `Only pasted images` does not depend on Obsidian's `Pasted image <timestamp>` naming (issue #31).
 */
export class PastedImageMarker {
  private readonly arrayBufferMap: ArrayBufferMap;
  private readonly getScreenshotFilePaths: (this: void) => readonly string[];

  public constructor(params: PastedImageMarkerConstructorParams) {
    this.arrayBufferMap = params.arrayBufferMap;
    this.getScreenshotFilePaths = params.getScreenshotFilePaths;
  }

  /**
   * Records the attachments.
   *
   * @param importedAttachments - The attachments, as Obsidian collected them from the clipboard or the drop.
   * @param gesture - The gesture that brought them in. The caller reads it before its first `await`, because the
   * tracker clears it once the DOM event has been dispatched.
   */
  public async record(importedAttachments: readonly ImportedAttachment[], gesture: InsertGesture | null): Promise<void> {
    for (const importedAttachment of importedAttachments) {
      // TODO: Drop the widening once obsidian-typings types `ImportedAttachment.data` as nullable. Obsidian sets it
      // to `null` for a folder, and its promise resolves to `null` when the file cannot be read.
      const data: Promise<ArrayBuffer | null> = importedAttachment.data;
      const arrayBuffer = await data;
      if (!arrayBuffer) {
        continue;
      }

      await this.arrayBufferMap.trySetByPath(arrayBuffer, importedAttachment.filepath);
      if (
        isPastedImage({
          extension: importedAttachment.extension,
          filePath: importedAttachment.filepath,
          fileStats: this.arrayBufferMap.getFileStats(arrayBuffer),
          gesture,
          now: Date.now(),
          screenshotFilePaths: this.getScreenshotFilePaths()
        })
      ) {
        this.arrayBufferMap.markAsPastedImage(arrayBuffer);
      }
    }
  }
}
