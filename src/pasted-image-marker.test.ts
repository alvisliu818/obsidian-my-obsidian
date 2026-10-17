import type { ImportedAttachment } from '@obsidian-typings/obsidian-public-latest';
import type { FileStats } from 'obsidian';

import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { strictProxy } from '@mnaoumov/typescript-test-toolkit/strict-proxy';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { ArrayBufferMap } from './array-buffer-map.ts';

import { InsertGesture } from './insert-gesture-tracker-component.ts';
import { PastedImageMarker } from './pasted-image-marker.ts';

describe('PastedImageMarker', () => {
  let fileStatsMap: Map<ArrayBuffer, FileStats>;
  let markAsPastedImageMock: ReturnType<typeof vi.fn<ArrayBufferMap['markAsPastedImage']>>;
  let trySetByPathMock: ReturnType<typeof vi.fn<ArrayBufferMap['trySetByPath']>>;
  let marker: PastedImageMarker;

  beforeEach(() => {
    fileStatsMap = new Map();
    markAsPastedImageMock = vi.fn<ArrayBufferMap['markAsPastedImage']>();
    trySetByPathMock = vi.fn<ArrayBufferMap['trySetByPath']>((arrayBuffer, filePath) => {
      if (filePath.includes('old')) {
        fileStatsMap.set(arrayBuffer, { ctime: 0, mtime: 0, size: arrayBuffer.byteLength });
      }
      return Promise.resolve(filePath !== '');
    });
    marker = new PastedImageMarker({
      arrayBufferMap: strictProxy<ArrayBufferMap>({
        getFileStats: (arrayBuffer: ArrayBuffer) => fileStatsMap.get(arrayBuffer),
        markAsPastedImage: markAsPastedImageMock,
        trySetByPath: trySetByPathMock
      }),
      getScreenshotFilePaths: (): readonly string[] => ['/PixPin_/']
    });
  });

  function createAttachment(filepath: string, arrayBuffer: ArrayBuffer | null, extension = 'png'): ImportedAttachment {
    return {
      data: Promise.resolve(castTo<ArrayBuffer>(arrayBuffer)),
      extension,
      filepath,
      name: 'attachment'
    };
  }

  it('should record the stats of every attachment and mark only the pasted images', async () => {
    const blob = new ArrayBuffer(1);
    const screenshot = new ArrayBuffer(2);
    const realFile = new ArrayBuffer(3);
    const pdf = new ArrayBuffer(4);

    await marker.record([
      createAttachment('', blob),
      createAttachment('C:/Temp/PixPin_old.png', screenshot),
      createAttachment('C:/Pictures/old.png', realFile),
      createAttachment('C:/Docs/old.pdf', pdf, 'pdf')
    ], InsertGesture.Paste);

    expect(trySetByPathMock).toHaveBeenCalledTimes(4);
    // Identity rather than `toHaveBeenCalledWith`: zero-filled buffers compare equal structurally.
    const markedBuffers = markAsPastedImageMock.mock.calls.map((call) => call[0]);
    expect(markedBuffers).toHaveLength(2);
    expect(markedBuffers[0]).toBe(blob);
    expect(markedBuffers[1]).toBe(screenshot);
  });

  it('should mark nothing that was dropped with a path', async () => {
    await marker.record([createAttachment('C:/Temp/PixPin_old.png', new ArrayBuffer(2))], InsertGesture.Drop);
    expect(markAsPastedImageMock).not.toHaveBeenCalled();
  });

  it('should skip an attachment with no content, such as a folder', async () => {
    await marker.record([createAttachment('C:/Folder', null)], InsertGesture.Paste);
    expect(trySetByPathMock).not.toHaveBeenCalled();
    expect(markAsPastedImageMock).not.toHaveBeenCalled();
  });
});
