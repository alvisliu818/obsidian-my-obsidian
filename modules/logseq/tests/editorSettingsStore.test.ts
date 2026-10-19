/**
 * 「VS Code 编辑器设置」存取层测试(settings.json 读写)。
 *
 * fs 走 extFs 的 __setFsForTest 注入(内存 Map),不碰真实磁盘;
 * 'obsidian' 由 vitest.config 的 alias 解析到 obsidian-stub.js(Notice 等)。
 *
 * 覆盖:缺失即创建默认文件 / 已有文件读取清洗 / JSON 损坏不改写只回退 /
 * 保存写盘并更新运行态 / settingsJsonPath 路径拼接。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EDITOR_SETTINGS_DEFAULTS,
  getEditorSettings,
  setEditorSettings,
} from '../src/editor/editorSettings';
import { __setFsForTest, type NodeFsLike } from '../src/features/extFs';
import {
  initEditorSettingsStore,
  loadEditorSettings,
  saveEditorSettings,
  settingsJsonPath,
  type EditorSettingsHost,
} from '../src/settings/editorSettingsStore';

const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
const PATH = 'E:/vault/.obsidian/plugins/obsidian-my-obsidian/settings.json';

function makeHost(): EditorSettingsHost {
  return {
    app: {
      vault: {
        adapter: { getBasePath: () => 'E:/vault' },
        configDir: '.obsidian',
      },
    },
    manifest: { dir: 'obsidian-my-obsidian' },
  } as unknown as EditorSettingsHost;
}

/** 内存 fs:初始文件集 + 写盘记录,路径统一小写比较(Windows 语义)。 */
function makeFs(initial?: Record<string, string>) {
  const files = new Map<string, string>();
  for (const [k, v] of Object.entries(initial ?? {})) files.set(norm(k), v);
  const writes: string[] = [];
  const fsLike: NodeFsLike = {
    readdirSync: () => [] as never[],
    statSync: () => ({ size: 1, mtimeMs: 1 }),
    existsSync: (p: string) => files.has(norm(p)),
    readFileSync: (p: string) => {
      const v = files.get(norm(p));
      if (v === undefined) throw new Error('ENOENT: ' + p);
      return v;
    },
    writeFileSync: (p: string, data: string) => {
      files.set(norm(p), data);
      writes.push(norm(p));
    },
    lstatSync: () => ({ isDirectory: () => false }),
    realpathSync: (p: string) => p,
    mkdirSync: () => {},
  };
  return { fsLike, files, writes };
}

describe('editorSettingsStore', () => {
  beforeEach(() => {
    initEditorSettingsStore(makeHost());
  });

  afterEach(() => {
    __setFsForTest(null);
    setEditorSettings({ ...EDITOR_SETTINGS_DEFAULTS });
  });

  it('settingsJsonPath = <basePath>/<configDir>/plugins/<dir>/settings.json', () => {
    expect(settingsJsonPath(makeHost())).toBe(PATH);
  });

  it('settingsJsonPath 兼容 Obsidian 运行时的完整 dir 形态(.obsidian/plugins/<dir>)', () => {
    const host = {
      app: {
        vault: {
          adapter: { getBasePath: () => 'E:/vault' },
          configDir: '.obsidian',
        },
      },
      manifest: { dir: '.obsidian/plugins/obsidian-my-obsidian' },
    } as unknown as EditorSettingsHost;
    // 不能二次拼接 configDir —— manifest.dir 已含完整安装路径
    expect(settingsJsonPath(host)).toBe(PATH);
  });

  it('文件缺失 → 写入完整默认对象,created=true,运行态同步', () => {
    const { fsLike, writes } = makeFs();
    __setFsForTest(fsLike);
    const res = loadEditorSettings();
    expect(res.created).toBe(true);
    expect(res.corrupt).toBe(false);
    expect(res.settings).toEqual(EDITOR_SETTINGS_DEFAULTS);
    expect(getEditorSettings()).toEqual(EDITOR_SETTINGS_DEFAULTS);
    expect(writes).toEqual([norm(PATH)]);
    const onDisk = JSON.parse(fsLike.readFileSync(PATH, 'utf8')) as Record<string, unknown>;
    expect(onDisk.wordWrap).toBe('on');
    expect(Object.keys(onDisk).length).toBe(Object.keys(EDITOR_SETTINGS_DEFAULTS).length);
  });

  it('已有文件 → 读取清洗,未知键计数,不回写', () => {
    const { fsLike, writes } = makeFs({ [PATH]: JSON.stringify({ fontSize: 20, bogus: 1 }) });
    __setFsForTest(fsLike);
    const res = loadEditorSettings();
    expect(res.created).toBe(false);
    expect(res.unknownKeys).toBe(1);
    expect(res.settings.fontSize).toBe(20);
    expect(getEditorSettings().fontSize).toBe(20);
    expect(writes).toEqual([]); // 读路径不写盘
  });

  it('JSON 损坏 → 不改写文件(保住手改内容),回退默认 + corrupt 标记', () => {
    const broken = '{"fontSize": 20,'; // 截断
    const { fsLike, files, writes } = makeFs({ [PATH]: broken });
    __setFsForTest(fsLike);
    const res = loadEditorSettings();
    expect(res.corrupt).toBe(true);
    expect(res.settings).toEqual(EDITOR_SETTINGS_DEFAULTS);
    expect(getEditorSettings()).toEqual(EDITOR_SETTINGS_DEFAULTS);
    expect(writes).toEqual([]);
    expect(files.get(norm(PATH))).toBe(broken); // 原文件原样保留
  });

  it('saveEditorSettings → 写盘(完整 25 键对象)并更新运行态', () => {
    const { fsLike, writes } = makeFs();
    __setFsForTest(fsLike);
    loadEditorSettings();
    writes.length = 0;
    saveEditorSettings({ ...getEditorSettings(), fontSize: 18, wordWrap: 'off' });
    expect(writes).toEqual([norm(PATH)]);
    const onDisk = JSON.parse(fsLike.readFileSync(PATH, 'utf8')) as Record<string, unknown>;
    expect(onDisk.fontSize).toBe(18);
    expect(onDisk.wordWrap).toBe('off');
    expect(getEditorSettings().fontSize).toBe(18);
  });

  it('未初始化宿主(非桌面端等) → 静默回退默认,不抛异常', () => {
    initEditorSettingsStore(null);
    const res = loadEditorSettings();
    expect(res).toEqual({
      settings: EDITOR_SETTINGS_DEFAULTS,
      created: false,
      corrupt: false,
      unknownKeys: 0,
    });
    // saveEditorSettings 不带宿主:只更新运行态,不写盘
    saveEditorSettings({ ...EDITOR_SETTINGS_DEFAULTS, fontSize: 14 });
    expect(getEditorSettings().fontSize).toBe(14);
  });
});
