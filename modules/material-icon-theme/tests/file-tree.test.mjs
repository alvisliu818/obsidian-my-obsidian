import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const SVG = {
  file: '<svg xmlns="http://www.w3.org/2000/svg" data-icon="file"></svg>',
  typescript: '<svg xmlns="http://www.w3.org/2000/svg" data-icon="typescript"></svg>',
  folder: '<svg xmlns="http://www.w3.org/2000/svg" data-icon="folder"></svg>',
  folderOpen: '<svg xmlns="http://www.w3.org/2000/svg" data-icon="folder-open"></svg>',
  assetsFolder: '<svg xmlns="http://www.w3.org/2000/svg" data-icon="assets-folder"></svg>',
  assetsFolderOpen: '<svg xmlns="http://www.w3.org/2000/svg" data-icon="assets-folder-open"></svg>',
  vercelDark: '<svg xmlns="http://www.w3.org/2000/svg" data-icon="vercel-dark"></svg>',
  vercelLight: '<svg xmlns="http://www.w3.org/2000/svg" data-icon="vercel-light"></svg>',
  gradientA: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="a"><stop stop-color="red"/></linearGradient><linearGradient id="b" xlink:href="#a"/></defs><path fill="url(#b)"/><use href="#a"/></svg>',
  gradientB: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="a"><stop stop-color="blue"/></linearGradient><linearGradient id="b" xlink:href="#a"/></defs><path fill="url(#b)"/><use href="#a"/></svg>',
};

const bundle = await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [
    {
      name: 'test-stubs',
      setup(builder) {
        builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test-stub' }));
        builder.onResolve({ filter: /^\.\/icon-data$/ }, () => ({ path: 'icon-data', namespace: 'test-stub' }));

        builder.onLoad({ filter: /^obsidian$/, namespace: 'test-stub' }, () => ({
          contents: `
            export class Plugin {}
            export class Modal {
              constructor(app) {
                this.app = app;
                this.contentEl = document.createElement('div');
                this.titleEl = document.createElement('h2');
              }
              close() { this.onClose(); }
            }
            export class Notice {}
            export class PluginSettingTab {}
            export class Setting {}
            export class WorkspaceLeaf {}
            export function getLanguage() { return 'en'; }
          `,
          loader: 'js',
        }));

        builder.onLoad({ filter: /^icon-data$/, namespace: 'test-stub' }, () => ({
          contents: `
            export const iconRegistry = ${JSON.stringify({
              file: { dark: SVG.file, light: SVG.file },
              typescript: { dark: SVG.typescript, light: SVG.typescript },
              folder: { dark: SVG.folder, light: SVG.folder },
              'folder-open': { dark: SVG.folderOpen, light: SVG.folderOpen },
              'assets-folder': { dark: SVG.assetsFolder, light: SVG.assetsFolder },
              'assets-folder-open': { dark: SVG.assetsFolderOpen, light: SVG.assetsFolderOpen },
              vercel: { dark: SVG.vercelDark, light: SVG.vercelLight },
              gradient: { dark: SVG.gradientA, light: SVG.gradientB },
            })};
            export const fileExtensionKeys = { ts: 'typescript', grad: 'gradient' };
            export const fileNameKeys = { 'vercel.json': 'vercel', constructor: 'typescript' };
            export const folderNameKeys = { assets: 'assets-folder' };
            export const folderNameOpenKeys = { assets: 'assets-folder-open' };
            export const defaultFileIconKey = 'file';
            export const folderIconKey = 'folder';
            export const folderOpenIconKey = 'folder-open';
          `,
          loader: 'js',
        }));

        builder.onLoad({ filter: /[\\/]src[\\/]main\.ts$/ }, args => ({
          contents: readFileSync(args.path, 'utf8') + '\nexport { IconPickerModal };',
          loader: 'ts',
          resolveDir: dirname(args.path),
        }));
      },
    },
  ],
});

const window = new Window();
globalThis.window = window;
globalThis.document = window.document;
globalThis.Document = window.Document;
globalThis.DOMParser = window.DOMParser;
globalThis.HTMLElement = window.HTMLElement;
globalThis.MutationObserver = window.MutationObserver;

Object.defineProperties(window.HTMLElement.prototype, {
  createSpan: {
    value(options = {}) {
      const span = this.ownerDocument.createElement('span');
      if (options.cls) span.className = options.cls;
      if (options.text) span.textContent = options.text;
      this.appendChild(span);
      return span;
    },
  },
  createEl: {
    value(tag, options = {}) {
      const el = this.ownerDocument.createElement(tag);
      if (options.cls) el.className = options.cls;
      if (options.text) el.textContent = options.text;
      for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
      this.appendChild(el);
      return el;
    },
  },
  createDiv: {
    value(options = {}) { return this.createEl('div', options); },
  },
  addClass: {
    value(...classes) { this.classList.add(...classes); },
  },
  setText: {
    value(text) { this.textContent = text; },
  },
  empty: {
    value() {
      this.replaceChildren();
    },
  },
  instanceOf: {
    value(type) {
      return this instanceof type;
    },
  },
});

const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`;
const { default: MaterialFileIconsPlugin, IconPickerModal } = await import(moduleUrl);

function createPlugin() {
  const plugin = Object.create(MaterialFileIconsPlugin.prototype);
  plugin.settings = {
    applyToFiles: true,
    applyToFolders: true,
    enableCustomRules: false,
    customRules: [],
    language: 'auto',
  };
  plugin.containers = new Map();
  plugin.folderObservers = new Map();
  plugin.refreshTimer = null;
  plugin.refreshDeadline = null;
  plugin.isDark = false;
  return plugin;
}

function createFileRow(path) {
  const item = document.createElement('div');
  item.className = 'tree-item nav-file';

  const title = document.createElement('div');
  title.className = 'tree-item-self nav-file-title';
  title.dataset.path = path;

  const content = document.createElement('div');
  content.className = 'nav-file-title-content';
  title.appendChild(content);
  item.appendChild(title);

  return { item, title };
}

function createFolderRow(path) {
  const item = document.createElement('div');
  item.className = 'tree-item nav-folder is-collapsed';

  const title = document.createElement('div');
  title.className = 'tree-item-self nav-folder-title';
  title.dataset.path = path;

  const content = document.createElement('div');
  content.className = 'nav-folder-title-content';
  title.appendChild(content);
  item.appendChild(title);

  const children = document.createElement('div');
  children.className = 'tree-item-children';
  item.appendChild(children);

  return { item, title, children };
}

async function flushMutations() {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

async function createLoadedThemePlugin(initialDark) {
  const plugin = createPlugin();
  const events = new Map();
  const cleanups = [];
  let dark = initialDark;
  plugin.bootTimers = [];
  plugin.app = {
    isDarkMode: () => dark,
    workspace: {
      on(name, callback) {
        events.set(name, callback);
        return { name };
      },
      onLayoutReady() {},
    },
  };
  plugin.loadSettings = async () => {};
  plugin.addSettingTab = () => {};
  plugin.registerEvent = ref => cleanups.push(() => events.delete(ref.name));
  plugin.register = callback => cleanups.push(callback);
  await plugin.onload();
  return {
    plugin,
    events,
    setDark(value) { dark = value; },
    dispose() {
      plugin.onunload();
      cleanups.forEach(callback => callback());
    },
  };
}

test('lookup: inherited names use folder defaults', () => {
  const plugin = createPlugin();
  for (const name of ['constructor', '__proto__', 'CONSTRUCTOR']) {
    assert.equal(plugin.getFolderIconKey(name, true), 'folder');
    assert.equal(plugin.getFolderIconKey(name, false), 'folder-open');
    const { item, title } = createFolderRow(name);
    document.body.appendChild(item);
    plugin.injectFolderIcon(title, true);
    assert.equal(title.querySelector('svg').dataset.icon, 'folder');
    plugin.updateFolderIcon(title, false);
    assert.equal(title.querySelector('svg').dataset.icon, 'folder-open');
  }
});

test('lookup: own entries win and inherited icon keys are rejected', () => {
  const plugin = createPlugin();
  assert.equal(plugin.getFileIconSvg('CONSTRUCTOR'), SVG.typescript);
  assert.equal(plugin.getFileIconSvg('sample.ts'), SVG.typescript);
  assert.equal(plugin.getFileIconSvg('sample.unknown'), SVG.file);
  assert.equal(plugin.getIconSet('constructor').light, SVG.file);
  assert.equal(plugin.getIconSet('__proto__').light, SVG.file);
});

test('theme: startup and changes use the host scheme', async t => {
  const h = await createLoadedThemePlugin(true);
  t.after(() => h.dispose());
  assert.equal(h.plugin.getFileIconSvg('vercel.json'), SVG.vercelDark);

  const container = document.createElement('div');
  const { item, title } = createFileRow('vercel.json');
  container.appendChild(item);
  document.body.appendChild(container);
  h.plugin.containers.set(container, h.plugin.observeContainer(container));
  h.plugin.refreshIcons();
  assert.equal(title.querySelector('svg').dataset.icon, 'vercel-dark');

  h.setDark(false);
  h.events.get('css-change')();
  assert.equal(title.querySelector('svg').dataset.icon, 'vercel-light');

  const unchanged = title.querySelector('svg');
  h.events.get('css-change')();
  assert.equal(title.querySelector('svg'), unchanged);

  h.setDark(true);
  h.events.get('css-change')();
  assert.equal(title.querySelector('svg').dataset.icon, 'vercel-dark');
});

test('theme: registered callbacks are removed on unload', async () => {
  const h = await createLoadedThemePlugin(false);
  assert.equal(h.events.has('css-change'), true);
  h.dispose();
  assert.equal(h.events.has('css-change'), false);
});

test('svg isolation: instances keep their own IDs and references', () => {
  const plugin = createPlugin();
  const first = createFileRow('first.grad');
  const second = createFileRow('second.grad');
  document.body.append(first.item, second.item);
  plugin.isDark = true;
  plugin.injectFileIcon(first.title, 'first.grad');
  plugin.isDark = false;
  plugin.injectFileIcon(second.title, 'second.grad');
  const svgs = [first, second].map(row => row.title.querySelector('svg'));
  const ids = svgs.flatMap(svg => [...svg.querySelectorAll('[id]')].map(el => el.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const svg of svgs) {
    const [a, b] = svg.querySelectorAll('linearGradient');
    assert.equal(b.getAttributeNS('http://www.w3.org/1999/xlink', 'href'), `#${a.id}`);
    assert.equal(svg.querySelector('path').getAttribute('fill'), `url(#${b.id})`);
    assert.equal(svg.querySelector('use').getAttribute('href'), `#${a.id}`);
  }
  assert.equal(svgs[0].querySelector('stop').getAttribute('stop-color'), 'red');
  assert.equal(svgs[1].querySelector('stop').getAttribute('stop-color'), 'blue');

  const host = first.title.querySelector('.mfi-icon');
  plugin.injectFileIcon(first.title, 'first.grad', true);
  assert.equal(first.title.querySelector('.mfi-icon'), host);
  const finalIds = [...document.querySelectorAll('.mfi-icon [id]')].map(el => el.id);
  assert.equal(new Set(finalIds).size, finalIds.length);
});

test('picker: searchable options are focusable named buttons', t => {
  const chosen = [];
  const picker = new IconPickerModal({}, false, 'typescript', {
    pickIcon: '选择图标',
    searchPlaceholder: '搜索图标',
  }, key => chosen.push(key));
  t.after(() => picker.onClose());
  document.body.appendChild(picker.contentEl);
  picker.onOpen();
  const search = picker.contentEl.querySelector('input');
  search.value = ' TypeScript ';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  const options = [...picker.contentEl.querySelectorAll('.mfi-picker-item')];
  assert.equal(options.length, 1);
  const option = options[0];
  assert.equal(option.tagName, 'BUTTON');
  assert.equal(option.type, 'button');
  assert.equal(option.getAttribute('aria-label'), 'typescript');
  assert.equal(option.getAttribute('aria-pressed'), 'true');
  assert.equal(option.tabIndex, 0);
  option.focus();
  assert.equal(document.activeElement, option);
  option.click();
  assert.deepEqual(chosen, ['typescript']);
  assert.equal(picker.contentEl.childElementCount, 0);
});

test('picker: closing without selection does not submit a rule', () => {
  const chosen = [];
  const picker = new IconPickerModal({}, false, '', {
    pickIcon: '选择图标',
    searchPlaceholder: '搜索图标',
  }, key => chosen.push(key));
  picker.onOpen();
  picker.onClose();
  assert.deepEqual(chosen, []);
});

test.afterEach(() => {
  document.body.replaceChildren();
});

test.after(async () => {
  await window.happyDOM.close();
});

test('recycled rows keep the same icon host while data-path changes', async () => {
  const plugin = createPlugin();
  const container = document.createElement('div');
  const { item, title } = createFileRow('before.md');
  container.appendChild(item);
  document.body.appendChild(container);

  plugin.injectFileIcon(title, title.dataset.path);
  const iconBefore = title.querySelector('.mfi-icon');
  let scheduledRefreshes = 0;
  let pruneCalls = 0;
  plugin.scheduleRefresh = () => { scheduledRefreshes += 1; };
  plugin.pruneFolderObservers = () => { pruneCalls += 1; };
  const observer = plugin.observeContainer(container);

  title.dataset.path = 'after.ts';
  await flushMutations();

  assert.equal(title.querySelector('.mfi-icon') === iconBefore, true);
  assert.equal(title.querySelector('svg')?.dataset.icon, 'typescript');
  assert.equal(title.getAttribute('data-mfi-applied'), '1');
  assert.equal(scheduledRefreshes, 0);
  assert.equal(pruneCalls, 0);
  observer.disconnect();
});

test('a file row recycled as a folder keeps its icon host and observes expansion', async () => {
  const plugin = createPlugin();
  const container = document.createElement('div');
  const { item, title } = createFileRow('before.md');
  const content = title.querySelector('.nav-file-title-content');
  container.appendChild(item);
  document.body.appendChild(container);

  plugin.injectFileIcon(title, title.dataset.path);
  const iconBefore = title.querySelector('.mfi-icon');
  let scheduledRefreshes = 0;
  plugin.scheduleRefresh = () => { scheduledRefreshes += 1; };
  const observer = plugin.observeContainer(container);

  item.className = 'tree-item nav-folder is-collapsed';
  title.className = 'tree-item-self nav-folder-title';
  content.className = 'nav-folder-title-content';
  title.dataset.path = 'src';
  await flushMutations();

  assert.equal(title.querySelector('.mfi-icon') === iconBefore, true);
  assert.equal(title.querySelector('svg')?.dataset.icon, 'folder');
  assert.equal(plugin.folderObservers.size, 1);

  item.classList.remove('is-collapsed');
  await flushMutations();

  assert.equal(title.querySelector('svg')?.dataset.icon, 'folder-open');
  assert.equal(scheduledRefreshes, 0);
  observer.disconnect();
});

test('new tree items receive icons without scheduling a whole-tree refresh', async () => {
  const plugin = createPlugin();
  const container = document.createElement('div');
  document.body.appendChild(container);

  let scheduledRefreshes = 0;
  plugin.scheduleRefresh = () => { scheduledRefreshes += 1; };
  const observer = plugin.observeContainer(container);
  const { item, title } = createFileRow('new.ts');
  const attachedSubtree = document.createElement('div');
  attachedSubtree.appendChild(item);

  container.appendChild(attachedSubtree);
  await flushMutations();

  assert.equal(title.querySelector('svg')?.dataset.icon, 'typescript');
  assert.equal(title.getAttribute('data-mfi-applied'), '1');
  assert.equal(scheduledRefreshes, 0);
  observer.disconnect();
});

test('expanding a folder updates its SVG without scheduling a refresh', async () => {
  const plugin = createPlugin();
  const { item, title, children } = createFolderRow('src');
  const { item: childItem, title: childTitle } = createFileRow('src/index.ts');
  children.appendChild(childItem);
  document.body.appendChild(item);

  plugin.processItem(item);
  const iconBefore = title.querySelector('.mfi-icon');
  assert.equal(childTitle.querySelector('.mfi-icon'), null);
  let scheduledRefreshes = 0;
  plugin.scheduleRefresh = () => { scheduledRefreshes += 1; };

  item.classList.remove('is-collapsed');
  await flushMutations();

  assert.equal(title.querySelector('.mfi-icon') === iconBefore, true);
  assert.equal(title.querySelector('svg')?.dataset.icon, 'folder-open');
  assert.equal(childTitle.querySelector('svg')?.dataset.icon, 'typescript');
  assert.equal(childTitle.getAttribute('data-mfi-applied'), '1');
  assert.equal(scheduledRefreshes, 0);
});

test('removing a folder releases its observer without a whole-tree refresh', async () => {
  const plugin = createPlugin();
  const container = document.createElement('div');
  document.body.appendChild(container);

  let scheduledRefreshes = 0;
  plugin.scheduleRefresh = () => { scheduledRefreshes += 1; };
  const observer = plugin.observeContainer(container);
  const { item } = createFolderRow('src');

  container.appendChild(item);
  await flushMutations();
  assert.equal(plugin.folderObservers.size, 1);

  item.remove();
  await flushMutations();

  assert.equal(plugin.folderObservers.size, 0);
  assert.equal(scheduledRefreshes, 0);
  observer.disconnect();
});

for (const [initialCollapsed, before, after] of [
  [false, 'folder-open', 'folder'],
  [true, 'folder', 'folder-open'],
]) {
  test(`reattached folder reconciles ${before} to ${after}`, async t => {
    const plugin = createPlugin();
    const container = document.createElement('div');
    const { item, title } = createFolderRow('plain');
    item.classList.toggle('is-collapsed', initialCollapsed);
    document.body.appendChild(container);
    const observer = plugin.observeContainer(container);
    t.after(() => {
      observer.disconnect();
      plugin.folderObservers.forEach(obs => obs.disconnect());
    });
    container.appendChild(item);
    await flushMutations();
    const host = title.querySelector('.mfi-icon');
    assert.equal(title.querySelector('svg').dataset.icon, before);
    item.remove();
    await flushMutations();
    assert.equal(plugin.folderObservers.has(item), false);
    item.classList.toggle('is-collapsed', !initialCollapsed);
    await flushMutations();
    container.appendChild(item);
    await flushMutations();
    assert.equal(title.querySelector('svg').dataset.icon, after);
    assert.equal(title.querySelector('.mfi-icon'), host);
    item.classList.toggle('is-collapsed', initialCollapsed);
    await flushMutations();
    assert.equal(title.querySelector('svg').dataset.icon, before);
  });
}

test('reattached asset folders update only when their icon key changes', async t => {
  const plugin = createPlugin();
  const container = document.createElement('div');
  const { item, title } = createFolderRow('assets');
  document.body.appendChild(container);
  const observer = plugin.observeContainer(container);
  t.after(() => {
    observer.disconnect();
    plugin.folderObservers.forEach(obs => obs.disconnect());
  });

  container.appendChild(item);
  await flushMutations();
  const host = title.querySelector('.mfi-icon');
  const svg = title.querySelector('svg');
  assert.equal(svg.dataset.icon, 'assets-folder');
  plugin.processItem(item);
  assert.equal(title.querySelector('svg'), svg);

  item.remove();
  await flushMutations();
  container.appendChild(item);
  await flushMutations();
  assert.equal(title.querySelector('.mfi-icon'), host);
  assert.equal(title.querySelector('svg'), svg);

  item.classList.remove('is-collapsed');
  await flushMutations();
  assert.equal(title.querySelector('svg').dataset.icon, 'assets-folder-open');
  const openSvg = title.querySelector('svg');
  plugin.processItem(item);
  assert.equal(title.querySelector('svg'), openSvg);
});

test('a folder row recycled as a file releases its folder observer', async () => {
  const plugin = createPlugin();
  const container = document.createElement('div');
  const { item, title } = createFolderRow('src');
  const content = title.querySelector('.nav-folder-title-content');
  container.appendChild(item);
  document.body.appendChild(container);

  plugin.processItem(item);
  const iconBefore = title.querySelector('.mfi-icon');
  assert.equal(plugin.folderObservers.size, 1);
  const observer = plugin.observeContainer(container);

  item.className = 'tree-item nav-file';
  title.className = 'tree-item-self nav-file-title';
  content.className = 'nav-file-title-content';
  title.dataset.path = 'src/index.ts';
  await flushMutations();

  assert.equal(title.querySelector('.mfi-icon') === iconBefore, true);
  assert.equal(title.querySelector('svg')?.dataset.icon, 'typescript');
  assert.equal(plugin.folderObservers.size, 0);
  assert.equal(item.hasAttribute('data-mfi-obs'), false);
  observer.disconnect();
});

test('a recycled row without data-path schedules the fallback refresh', async () => {
  const plugin = createPlugin();
  const container = document.createElement('div');
  const { item, title } = createFileRow('before.md');
  container.appendChild(item);
  document.body.appendChild(container);

  plugin.injectFileIcon(title, title.dataset.path);
  let scheduledRefreshes = 0;
  plugin.scheduleRefresh = () => { scheduledRefreshes += 1; };
  const observer = plugin.observeContainer(container);

  title.removeAttribute('data-path');
  await flushMutations();

  assert.equal(scheduledRefreshes, 1);
  observer.disconnect();
});

test('disabled file and folder icons do not schedule a refresh', async () => {
  const plugin = createPlugin();
  plugin.settings.applyToFiles = false;
  plugin.settings.applyToFolders = false;
  const container = document.createElement('div');
  document.body.appendChild(container);

  let scheduledRefreshes = 0;
  plugin.scheduleRefresh = () => { scheduledRefreshes += 1; };
  const observer = plugin.observeContainer(container);
  const { item, title } = createFileRow('new.ts');

  container.appendChild(item);
  await flushMutations();

  assert.equal(title.querySelector('.mfi-icon'), null);
  assert.equal(title.hasAttribute('data-mfi-applied'), false);
  assert.equal(scheduledRefreshes, 0);
  observer.disconnect();
});

test('recycling a file as a folder removes the old icon when folder icons are disabled', async () => {
  const plugin = createPlugin();
  plugin.settings.applyToFolders = false;
  const container = document.createElement('div');
  const { item, title } = createFileRow('before.md');
  const content = title.querySelector('.nav-file-title-content');
  container.appendChild(item);
  document.body.appendChild(container);

  plugin.injectFileIcon(title, title.dataset.path);
  let scheduledRefreshes = 0;
  plugin.scheduleRefresh = () => { scheduledRefreshes += 1; };
  const observer = plugin.observeContainer(container);

  item.className = 'tree-item nav-folder is-collapsed';
  title.className = 'tree-item-self nav-folder-title';
  content.className = 'nav-folder-title-content';
  title.dataset.path = 'src';
  await flushMutations();

  assert.equal(title.querySelector('.mfi-icon'), null);
  assert.equal(title.hasAttribute('data-mfi-applied'), false);
  assert.equal(scheduledRefreshes, 0);
  observer.disconnect();
});

test('recycling a folder as a file removes the old icon when file icons are disabled', async () => {
  const plugin = createPlugin();
  plugin.settings.applyToFiles = false;
  const container = document.createElement('div');
  const { item, title } = createFolderRow('src');
  const content = title.querySelector('.nav-folder-title-content');
  container.appendChild(item);
  document.body.appendChild(container);

  plugin.processItem(item);
  let scheduledRefreshes = 0;
  plugin.scheduleRefresh = () => { scheduledRefreshes += 1; };
  const observer = plugin.observeContainer(container);

  item.className = 'tree-item nav-file';
  title.className = 'tree-item-self nav-file-title';
  content.className = 'nav-file-title-content';
  title.dataset.path = 'src/index.ts';
  await flushMutations();

  assert.equal(title.querySelector('.mfi-icon'), null);
  assert.equal(title.hasAttribute('data-mfi-applied'), false);
  assert.equal(plugin.folderObservers.size, 0);
  assert.equal(scheduledRefreshes, 0);
  observer.disconnect();
});

test('a failed recycled-row injection keeps the icon host and schedules fallback', async () => {
  const plugin = createPlugin();
  const container = document.createElement('div');
  const { item, title } = createFileRow('before.md');
  container.appendChild(item);
  document.body.appendChild(container);

  plugin.injectFileIcon(title, title.dataset.path);
  const iconBefore = title.querySelector('.mfi-icon');
  title.querySelector('.nav-file-title-content').className = 'pending-title-content';
  let scheduledRefreshes = 0;
  plugin.scheduleRefresh = () => { scheduledRefreshes += 1; };
  const observer = plugin.observeContainer(container);

  title.dataset.path = 'after.ts';
  await flushMutations();

  assert.equal(title.querySelector('.mfi-icon') === iconBefore, true);
  assert.equal(title.hasAttribute('data-mfi-applied'), false);
  assert.equal(scheduledRefreshes, 1);
  observer.disconnect();
});

test('an added expanded folder processes its existing child subtree locally', async () => {
  const plugin = createPlugin();
  const container = document.createElement('div');
  document.body.appendChild(container);

  let scheduledRefreshes = 0;
  plugin.scheduleRefresh = () => { scheduledRefreshes += 1; };
  const observer = plugin.observeContainer(container);
  const { item, title, children } = createFolderRow('src');
  const { item: childItem, title: childTitle } = createFileRow('src/index.ts');
  item.classList.remove('is-collapsed');
  children.appendChild(childItem);

  container.appendChild(item);
  await flushMutations();

  assert.equal(title.querySelector('svg')?.dataset.icon, 'folder-open');
  assert.equal(childTitle.querySelector('svg')?.dataset.icon, 'typescript');
  assert.equal(scheduledRefreshes, 0);
  observer.disconnect();
});

test('an incomplete added tree item schedules the fallback refresh', async () => {
  const plugin = createPlugin();
  const container = document.createElement('div');
  document.body.appendChild(container);

  let scheduledRefreshes = 0;
  plugin.scheduleRefresh = () => { scheduledRefreshes += 1; };
  const observer = plugin.observeContainer(container);
  const item = document.createElement('div');
  item.className = 'tree-item nav-file';

  container.appendChild(item);
  await flushMutations();

  assert.equal(scheduledRefreshes, 1);
  observer.disconnect();
});
