import { App, PluginSettingTab, Setting } from "obsidian";
import { t } from "./i18n";
import type { AudioPlayerSettings, NavigationBehavior } from "./settings";
import type AudioPlayerPlugin from "./main";

/**
 * 模块设置页（移植自 obsidian-audio-timestamp-player 的设置页模型，0BSD）。
 *
 * 宿主把本 tab 显示为「Audio Player」设置页；切页行为与悬浮视频尺寸经
 * loadData/saveData 分片持久化。语言覆盖 / 紧凑显示等不移植项见 NOTICE。
 */
export class AudioPlayerSettingTab extends PluginSettingTab {
    plugin: AudioPlayerPlugin;

    constructor(
        app: App,
        plugin: AudioPlayerPlugin,
    ) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        const settings = this.plugin.settings;

        this.addMediaSettings("audio", settings);
        this.addMediaSettings("video", settings);

        new Setting(containerEl)
            .setName(t("video.size"))
            .setDesc(t("video.sizeDesc"))
            .addButton((button) =>
                button.setButtonText(t("video.resetSize")).onClick(async () => {
                    settings.videoPlayerWidth = 480;
                    settings.videoPlayerHeight = 320;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t("video.resize"))
            .setDesc(t("video.resizeDesc"))
            .addToggle((toggle) =>
                toggle.setValue(settings.videoResizeEnabled).onChange(async (value) => {
                    settings.videoResizeEnabled = value;
                    await this.plugin.saveSettings();
                }),
            );
    }

    private addMediaSettings(mediaType: "audio" | "video", settings: AudioPlayerSettings): void {
        const mediaName = t(mediaType === "audio" ? "media.audio" : "media.video");
        const settingKey = mediaType === "audio"
            ? "audioNavigationBehavior"
            : "videoNavigationBehavior";

        new Setting(this.containerEl).setName(mediaName).setHeading();
        new Setting(this.containerEl)
            .setName(t("nav.behavior"))
            .setDesc(t("nav.behaviorDesc", { media: mediaName }))
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("continue", t("nav.continue"))
                    .addOption("pause", t("nav.pause"))
                    .addOption("close", t("nav.close"))
                    .setValue(settings[settingKey])
                    .onChange(async (value) => {
                        settings[settingKey] = value as NavigationBehavior;
                        await this.plugin.saveSettings();
                    }),
            );
    }
}
