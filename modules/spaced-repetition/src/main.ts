import { Plugin } from "obsidian";

import { CommandManager } from "./command-manager";
import { DataManager } from "./data/data-manager";
import { DebugLoggerInstance } from "./data/debug-logger";
import { PluginDataError, PluginDataManager } from "./data/plugin-data-manager";
import { SRSettings } from "./data/settings";
import { SettingsManager } from "./data/settings-manager";
import { LocaleManagerInstance } from "./lang/locale-manager";
import { NextNoteReviewHandler } from "./note/next-note-review-handler";
import { NoteReviewQueue } from "./note/note-review-queue";
import { ReminderManager } from "./scheduling/reminder-manager";
import { REVIEW_QUEUE_VIEW_TYPE } from "./ui/obsidian-ui-components/item-views/review-queue-list-view";
import { UIManager } from "./ui/ui-manager";
import { TextDirection } from "./utils/strings";

export default class SRPlugin extends Plugin {
    private _uiManager: UIManager | null = null;
    private _dataManager: DataManager | null = null;

    private _nextNoteReviewHandler: NextNoteReviewHandler | null = null;
    private _commandManager: CommandManager | null = null;
    private _reminderManager: ReminderManager | null = null;
    public isInitialized: boolean = false;

    async onload(): Promise<void> {
        try {
            // Load the plugin data and settings first, as other components depend on it being available during their initialization.
            const pluginDataManager = new PluginDataManager(this);
            await pluginDataManager.loadData();

            const settingsManager = new SettingsManager(
                pluginDataManager.pluginData.settings,
                async (settings: SRSettings) => {
                    await pluginDataManager.writeSettings(settings);
                },
            );

            this.dataManager = new DataManager(this, pluginDataManager, settingsManager);
            const uiManager = new UIManager(this, settingsManager);
            this.uiManager = uiManager;
            this.commandManager = new CommandManager(this, settingsManager, uiManager);

            this.app.workspace.onLayoutReady(async () => {
                this.dataManager.loadData();

                // Set the preferred locale if it is not the default
                if (settingsManager.settings.preferredLocale !== "-") {
                    LocaleManagerInstance.getInstance().currentLocale =
                        settingsManager.settings.preferredLocale;
                }

                const noteReviewQueue = new NoteReviewQueue();
                this._nextNoteReviewHandler = new NextNoteReviewHandler(
                    this.app,
                    settingsManager.settings,
                    noteReviewQueue,
                );

                await this.dataManager.initOSRCore(noteReviewQueue, async () => {
                    await this.onOsrVaultDataChanged();
                });

                await this.uiManager.onLayoutReady();
                this.commandManager.onLayoutReady();
                this._reminderManager = new ReminderManager(this, this.uiManager, this.dataManager);

                this.isInitialized = true;
                this._reminderManager.restartReviewReminders();
            });
        } catch (error) {
            if (error instanceof PluginDataError || error instanceof Error) {
                console.warn("SRPlugin: Error in onLoad", error.message);
                DebugLoggerInstance.getInstance().log(
                    "SRPlugin: Error in onLoad: " + error.message,
                    "error",
                );
            } else {
                console.warn("SRPlugin: Error in onLoad");
                DebugLoggerInstance.getInstance().log("SRPlugin: Error in onLoad", "error");
            }
        }
    }

    get reminderManager(): ReminderManager {
        if (this._reminderManager === null) throw new Error("Reminder manager not initialized!!!");
        return this._reminderManager;
    }

    get uiManager(): UIManager {
        if (this._uiManager === null) throw new Error("UI manager not initialized!!!");
        return this._uiManager;
    }

    set uiManager(uiManager: UIManager) {
        this._uiManager = uiManager;
    }

    get nextNoteReviewHandler(): NextNoteReviewHandler {
        if (this._nextNoteReviewHandler === null)
            throw new Error("Next note review handler not initialized!!!");
        return this._nextNoteReviewHandler;
    }

    get commandManager(): CommandManager {
        if (this._commandManager === null) throw new Error("Command manager not initialized!!!");
        return this._commandManager;
    }

    set commandManager(commandManager: CommandManager) {
        this._commandManager = commandManager;
    }

    isUiManagerLoaded(): boolean {
        return this._uiManager !== null;
    }

    get dataManager(): DataManager {
        if (this._dataManager === null) throw new Error("Data manager not initialized!!!");
        return this._dataManager;
    }

    set dataManager(dataManager: DataManager) {
        this._dataManager = dataManager;
    }

    isDataManagerLoaded(): boolean {
        return this._dataManager !== null;
    }

    onunload(): void {
        this.reminderManager.stopReviewReminders();
        this.app.workspace.getLeavesOfType(REVIEW_QUEUE_VIEW_TYPE).forEach((leaf) => leaf.detach());
        this.uiManager.destroy();
        this.commandManager.onunload();
    }

    public addCustomHotkeys() {
        this.commandManager.addCustomHotkeys();
    }

    public removeCustomHotkeys() {
        this.commandManager.removeCustomHotkeys();
    }

    /**
     * Gets the text direction setting for the current Obsidian instance.
     */
    public getObsidianRtlSetting(): TextDirection {
        return activeDocument.body.hasClass("mod-rtl") ? TextDirection.Rtl : TextDirection.Ltr;
    }

    /**
     * Called when the OSR app core's data has changed.
     *
     * Anything that needs to be updated in the UI because of this change should be done here.
     */
    private async onOsrVaultDataChanged() {
        await this.uiManager.updateStatusBar();
        if (this.dataManager.data.settings.enableNoteReviewPaneOnStartup) {
            this.uiManager.sidebarManager.redraw();
        }
    }
}
