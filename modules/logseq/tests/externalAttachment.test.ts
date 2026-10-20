import { describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import {
  relativeAttachmentLink,
  resolveExternalAttachmentDir,
} from '../src/features/externalAttachment';

/**
 * 只测纯函数（路径解析）：落盘要 Node fs，交给 e2e/手测。
 * `resolveExternalAttachmentDir` 只读宿主设置切片，不碰 fs，故可单测。
 */

function fakeApp(cal?: {
  enabled?: boolean;
  attachmentFolderPath?: string;
  shouldFollowObsidianAttachmentLocation?: boolean;
}): App {
  const modules: Record<string, unknown> = {};
  if (cal) {
    modules['custom-attachment-location'] = {
      enabled: cal.enabled !== false,
      data: {
        attachmentFolderPath: cal.attachmentFolderPath ?? '',
        shouldFollowObsidianAttachmentLocation:
          cal.shouldFollowObsidianAttachmentLocation !== false,
      },
    };
  }
  return {
    plugins: { plugins: { 'obsidian-my-obsidian': { settings: { modules } } } },
  } as unknown as App;
}

describe('relativeAttachmentLink', () => {
  it('同目录只给文件名', () => {
    expect(
      relativeAttachmentLink('E:/m/sub/note.md', 'E:/m/sub/a.png'),
    ).toBe('a.png');
  });

  it('子目录给相对路径', () => {
    expect(
      relativeAttachmentLink('E:/m/sub/note.md', 'E:/m/sub/assets/note/a.png'),
    ).toBe('assets/note/a.png');
  });

  it('上级目录用 .. 回退', () => {
    expect(
      relativeAttachmentLink('E:/m/sub/note.md', 'E:/m/shared/a.png'),
    ).toBe('../shared/a.png');
  });

  it('跨盘退化为文件名（相对路径无意义）', () => {
    expect(relativeAttachmentLink('E:/m/note.md', 'F:/x/a.png')).toBe('a.png');
  });
});

describe('resolveExternalAttachmentDir', () => {
  const note = 'E:/mount/sub/note.md';

  it('CAL 未启用 → 笔记同目录', () => {
    expect(resolveExternalAttachmentDir(fakeApp(), { noteAbs: note })).toBe(
      'E:/mount/sub',
    );
  });

  it('CAL 启用但跟随 Obsidian 附件位置 → 笔记同目录', () => {
    expect(
      resolveExternalAttachmentDir(
        fakeApp({ attachmentFolderPath: './assets/{{noteFileName}}' }),
        { noteAbs: note },
      ),
    ).toBe('E:/mount/sub');
  });

  it('模板 ./ 相对笔记目录，token 求值', () => {
    expect(
      resolveExternalAttachmentDir(
        fakeApp({
          attachmentFolderPath: './assets/{{noteFileName}}',
          shouldFollowObsidianAttachmentLocation: false,
        }),
        { noteAbs: note },
      ),
    ).toBe('E:/mount/sub/assets/note');
  });

  it('模板 / 相对挂载根', () => {
    expect(
      resolveExternalAttachmentDir(
        fakeApp({
          attachmentFolderPath: '/attachments',
          shouldFollowObsidianAttachmentLocation: false,
        }),
        { noteAbs: note, mountRoot: 'E:/mount' },
      ),
    ).toBe('E:/mount/attachments');
  });

  it('noteFolderPath 是相对挂载根的路径', () => {
    expect(
      resolveExternalAttachmentDir(
        fakeApp({
          attachmentFolderPath: './{{noteFolderPath}}',
          shouldFollowObsidianAttachmentLocation: false,
        }),
        { noteAbs: note, mountRoot: 'E:/mount' },
      ),
    ).toBe('E:/mount/sub/sub');
  });

  it('不认识的 token 求值为空串，不抛异常', () => {
    expect(
      resolveExternalAttachmentDir(
        fakeApp({
          attachmentFolderPath: './x/{{nope}}',
          shouldFollowObsidianAttachmentLocation: false,
        }),
        { noteAbs: note },
      ),
    ).toBe('E:/mount/sub/x');
  });
});
