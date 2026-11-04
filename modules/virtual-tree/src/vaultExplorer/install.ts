/**
 * Vault virtual explorer — view registry install.
 *
 * Swaps the viewRegistry creator for the core 'file-explorer' type so the
 * saved sidebar leaf instantiates OUR virtualised view instead of the native
 * one. Community plugins load before the workspace layout restores, so on a
 * normal boot the native explorer never instantiates at all — no 55k-row DOM
 * is ever built (that is the entire point).
 *
 * Registry etiquette (why not plugin.registerView): the plugin wrapper
 * unregisters the view TYPE on unload, which would leave 'file-explorer'
 * creator-less and break the sidebar. We call the registry directly and
 * restore the captured core creator ourselves, then re-create any live leaves
 * so the running view swaps back to the native one.
 */

import { WorkspaceLeaf } from "obsidian";
import type DocTreePlugin from "../main";
import { VaultExplorerView } from "./view";

type ViewFactory = (leaf: WorkspaceLeaf) => unknown;

interface ViewRegistryLike {
	registerView(type: string, creator: ViewFactory): void;
	unregisterView(type: string): void;
	getViewCreatorByType(type: string): ViewFactory | undefined;
}

export interface VaultExplorerHandle {
	uninstall(): Promise<void>;
}

export function installVaultExplorer(plugin: DocTreePlugin): VaultExplorerHandle {
	const registry = (plugin.app as unknown as { viewRegistry?: ViewRegistryLike }).viewRegistry;
	if (!registry) {
		console.warn("[doc-tree] viewRegistry unavailable — vault virtual explorer not installed");
		return { uninstall: async () => {} };
	}
	// 核心的 registerView 对已存在类型直接抛错（"Attempting to register an
	// existing view type"）——先摘核心构造器再装我们的，两步之间无 await，
	// 不存在无主窗口期。
	const coreCreator = registry.getViewCreatorByType("file-explorer");
	if (!coreCreator) {
		console.warn("[doc-tree] core file-explorer creator missing — vault virtual explorer not installed");
		return { uninstall: async () => {} };
	}
	registry.unregisterView("file-explorer");
	registry.registerView("file-explorer", (leaf: WorkspaceLeaf) => new VaultExplorerView(leaf, plugin));

	// 首装时若侧栏已经有核心视图实例（极少见：布局先于本模块恢复的时序），
	// 现场换成虚拟视图。
	void (async () => {
		for (const leaf of plugin.app.workspace.getLeavesOfType("file-explorer")) {
			if (leaf.view instanceof VaultExplorerView) continue;
			try {
				const state =
					(leaf.view as unknown as { getState?: () => Record<string, unknown> }).getState?.() ?? {};
				await leaf.setViewState({ type: "file-explorer", state });
			} catch (err) {
				console.warn("[doc-tree] explorer leaf takeover failed", err);
			}
		}
	})();

	const uninstall = async (): Promise<void> => {
		try {
			registry.unregisterView("file-explorer");
		} catch {
			/* already gone */
		}
		registry.registerView("file-explorer", coreCreator);
		// 把还在跑的自研视图换成核心视图（关掉才走到这；尽力而为）。
		for (const leaf of plugin.app.workspace.getLeavesOfType("file-explorer")) {
			if (!(leaf.view instanceof VaultExplorerView)) continue;
			try {
				await leaf.setViewState({ type: "file-explorer", state: leaf.view.getState() });
			} catch (err) {
				console.warn("[doc-tree] file-explorer leaf restore failed", err);
			}
		}
	};
	return { uninstall };
}
