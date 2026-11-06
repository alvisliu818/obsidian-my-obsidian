/**
 * Compile-time stub for `electron` under vitest (same idea as obsidian-stub.js).
 *
 * The electron package ships without its binary here (`dependenciesMeta.electron
 * build: false` — only its types are used at build time), so loading its real
 * index.js under vitest throws "Electron failed to install correctly". Unit
 * tests never touch real Electron anyway — the only API the plugin calls is
 * `clipboard.writeText` (main.ts / ExternalCodeView.ts / externalPaneMenu.ts).
 */
export const clipboard = {
	writeText() {},
	readText() {
		return '';
	},
};
export const webUtils = {};
export const ipcRenderer = {
	send() {},
	invoke() {
		return Promise.resolve(undefined);
	},
};
export default { clipboard, webUtils, ipcRenderer };
