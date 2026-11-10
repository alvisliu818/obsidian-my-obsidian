import { SettingsManager } from "src/data/settings-manager";
import { t } from "src/lang/helpers";
import SRPlugin from "src/main";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import CounterStatusBarItem from "src/ui/obsidian-ui-components/statusbar-items/counter-statusbar-item";
import TextStatusBarItem from "src/ui/obsidian-ui-components/statusbar-items/text-statusbar-item";

export type StatusBarItemPurpose = "card-review" | "note-review" | "update-available";
export const StatusBarItemTypesArray: ReadonlyArray<StatusBarItemPurpose> = [
    "card-review",
    "note-review",
    "update-available",
];

export default class StatusBarManager {
    private statusBarItems: TextStatusBarItem[];
    protected plugin: SRPlugin;
    private settingsManager: SettingsManager;

    /**
     * 为什么没有「检查 GitHub 新版本」：本模块是聚合插件 obsidian-my-obsidian
     * 的内嵌件，Obsidian 只会更新聚合插件本身，单独盯
     * st3v3nmw/obsidian-spaced-repetition 的 releases 毫无意义；而未认证的
     * GitHub API 在国内网络/代理下恒 403，状态栏每次刷新（库数据变化）都
     * 请求一次并刷控制台。2026-11-10 用户要求彻底解决 → 移除该请求，
     * 「update-available」状态栏项从此不再出现（保留代码结构以便回退）。
     */

    constructor(plugin: SRPlugin, settingsManager: SettingsManager) {
        this.plugin = plugin;
        this.settingsManager = settingsManager;
        this.statusBarItems = [];
    }

    setCount(count: number, showItems: boolean, statusBarItemType: StatusBarItemPurpose): void {
        const statusBarItem = this.statusBarItems.find(
            (statusBarItem) => statusBarItem.getStatusBarItemType() === statusBarItemType,
        );

        if (statusBarItem === undefined) return;

        (statusBarItem as CounterStatusBarItem).setCounter(count);
        if (showItems && count > 0) {
            statusBarItem.show();
        } else {
            statusBarItem.hide();
        }
    }

    async showStatusBarItems(
        showItems: boolean, // Overrides all other settings
        showCardStatusBarItem?: boolean,
        showNoteStatusBarItem?: boolean,
        showUpdateAvailableStatusBarItem?: boolean,
    ): Promise<void> {
        if (this.statusBarItems.length === 0) {
            await this.createStatusBarItems();
        }

        const showCardItem =
            showCardStatusBarItem === undefined ? showItems : showCardStatusBarItem;
        const showNoteItem =
            showNoteStatusBarItem === undefined ? showItems : showNoteStatusBarItem;
        const showUpdateAvailableItem =
            showUpdateAvailableStatusBarItem === undefined
                ? showItems
                : showUpdateAvailableStatusBarItem;

        for (const statusBarItem of this.statusBarItems) {
            if (showItems) {
                if (
                    statusBarItem.getStatusBarItemType() === "update-available" &&
                    statusBarItem.getText() === ""
                ) {
                    statusBarItem.hide();
                    return;
                }

                switch (statusBarItem.getStatusBarItemType()) {
                    case "card-review":
                        if (showItems && showCardItem) {
                            statusBarItem.show();
                        } else {
                            statusBarItem.hide();
                        }
                        break;
                    case "note-review":
                        if (showItems && showNoteItem) {
                            statusBarItem.show();
                        } else {
                            statusBarItem.hide();
                        }
                        break;
                    case "update-available":
                        // Disable the fetching of the version number if the statusbar items are disabled
                        if (showItems && showUpdateAvailableItem) {
                            await this.checkAndUpdatePluginVersion().then((_) => {
                                statusBarItem.show();
                            });
                        } else {
                            statusBarItem.hide();
                        }
                        break;
                    default:
                        statusBarItem.show();
                }
            } else {
                statusBarItem.hide();
            }
        }
    }

    async createStatusBarItems(): Promise<void> {
        if (this.statusBarItems.length > 0) return;

        for (const statusBarItemType of StatusBarItemTypesArray) {
            let statusBarItem = undefined;

            switch (statusBarItemType) {
                case "card-review":
                    statusBarItem = new CounterStatusBarItem(this.plugin, statusBarItemType, {
                        icon: "SpacedRepIcon",
                        show: false,
                        count: 0,
                        hideIcon: false,
                        text: " card(s) due",
                        tooltip: t("OPEN_DECK_FOR_REVIEW"),
                        tooltipPosition: "top",
                        onClick: async () => {
                            if (this.plugin.uiManager === null)
                                throw new Error("UI manager not initialized!!!");
                            await this.plugin.uiManager.openDeckContainer(
                                FlashcardReviewMode.Review,
                            );
                        },
                    });
                    break;
                case "note-review":
                    statusBarItem = new CounterStatusBarItem(this.plugin, statusBarItemType, {
                        icon: "lucide-file-clock",
                        show: false,
                        text: " note(s) due",
                        count: 0,
                        hideIcon: false,
                        tooltip: t("OPEN_NOTE_FOR_REVIEW"),
                        tooltipPosition: "top",
                        onClick: async () => {
                            if (
                                this.plugin.dataManager === null ||
                                this.plugin.dataManager.osrCore === null
                            )
                                throw new Error("SR plugin or OSR app core not initialized!!!");
                            if (this.plugin.nextNoteReviewHandler === null)
                                throw new Error("Next note review handler not initialized!!!");

                            if (!this.plugin.dataManager.syncLock) {
                                await this.plugin.dataManager.sync();
                                await this.plugin.nextNoteReviewHandler.reviewNextNoteModal();
                            }
                        },
                    });
                    break;
                case "update-available":
                    statusBarItem = new TextStatusBarItem(this.plugin, statusBarItemType, {
                        icon: "lucide-circle-arrow-up",
                        show: false,
                        hideIcon: false,
                        text: "",
                        tooltip: t("UPDATE_AVAILABLE"),
                        tooltipPosition: "top",
                    });
                    break;
            }

            this.statusBarItems.push(statusBarItem);
        }

        // Disable the fetching of the version number if the statusbar items are disabled
        if (
            this.settingsManager.settings.showStatusBar &&
            this.settingsManager.settings.showUpdateAvailableStatusBarItem
        ) {
            await this.checkAndUpdatePluginVersion();
        }
    }

    private async checkAndUpdatePluginVersion() {
        // 版本检查已移除（见类注释）：恒返回当前版本 = 永不提示「有更新」。
        const newestVersion = this.plugin.manifest.version;

        if (this.plugin.manifest.version === newestVersion) return;

        const updateItem = this.statusBarItems.find(
            (statusBarItem) => statusBarItem.getStatusBarItemType() === "update-available",
        );

        if (updateItem !== undefined) {
            updateItem.setText("Spaced Repetition: new Update!");
        }
    }

    private async getNewestVersion(): Promise<string> {
        // 2026-11-10 起不再请求 GitHub API（403 根因，见类注释）。
        return this.plugin.manifest.version;
    }
}
