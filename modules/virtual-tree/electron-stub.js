/**
 * Compile-time stub for `electron` under vitest (same idea as obsidian-stub.js).
 *
 * The electron package ships without its binary here (`dependenciesMeta.electron
 * build: false` — only its types are used at build time), so loading its real
 * index.js under vitest throws "Electron failed to install correctly". The only
 * API this module's sources call is `clipboard.writeText` (externalPaneMenu.ts).
 */
export const clipboard = {
	writeText() {},
	readText() {
		return '';
	},
};
export default { clipboard };
