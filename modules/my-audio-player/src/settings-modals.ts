import { App, Modal, Setting } from "obsidian";
import { t } from "./i18n";
import {
    ASPECT_OPTIONS,
    ORIENTATION_OPTIONS,
    Option,
    PLAYBACK_OPTIONS,
    PlayerSettings,
    SHORTCUT_DEFS,
    getPlayerSettings,
    isModifierOnly,
    normalizeKeyEvent,
    prettyKey,
    refreshPlayers,
    resetShortcut,
    updatePlayerSettings,
} from "./utils/player-settings";

/** 在设置行右侧添加横向分段按钮组（多选一，选中项高亮） */
function addSegmented<T extends string>(
    setting: Setting,
    options: Option<T>[],
    current: T,
    onSelect: (value: T) => void,
) {
    const group = setting.controlEl.createDiv({ cls: "tsp-segmented" });
    const buttons = options.map(opt => {
        const btn = group.createEl("button", { cls: "tsp-segmented-btn", text: t(opt.labelKey) });
        if (opt.value === current) btn.addClass("is-active");
        btn.addEventListener("click", () => {
            buttons.forEach(b => b.removeClass("is-active"));
            btn.addClass("is-active");
            onSelect(opt.value);
        });
        return btn;
    });
}

/** 更多播放设置：播放方式 + 视频比例 + 屏幕方向 */
export class PlaybackSettingsModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        const settings = getPlayerSettings(this.app);
        contentEl.createEl("h2", { text: t("playback.title") });

        const row = <T extends string>(
            name: string,
            desc: string,
            options: Option<T>[],
            current: T,
            patch: (value: T) => Partial<PlayerSettings>,
        ) => addSegmented(
            new Setting(contentEl).setName(name).setDesc(desc),
            options,
            current,
            value => {
                updatePlayerSettings(this.app, patch(value));
                refreshPlayers(this.app);
            },
        );

        row(t("playback.mode"), t("playback.modeDesc"), PLAYBACK_OPTIONS, settings.playbackMode, v => ({ playbackMode: v }));
        row(t("playback.ratio"), t("playback.ratioDesc"), ASPECT_OPTIONS, settings.aspectRatio, v => ({ aspectRatio: v }));
        row(t("playback.orientation"), t("playback.orientationDesc"), ORIENTATION_OPTIONS, settings.orientation, v => ({ orientation: v }));
    }
}

/** 快捷键设置：功能描述 + 绑定键 + 恢复默认 */
export class ShortcutSettingsModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: t("shortcut.title") });
        contentEl.createEl("p", {
            cls: "tsp-settings-hint",
            text: t("shortcut.hint"),
        });

        for (const def of SHORTCUT_DEFS) {
            const setting = new Setting(contentEl).setName(t(def.labelKey));
            let input: HTMLInputElement;

            setting.addText(text => {
                input = text.inputEl;
                input.addClass("tsp-shortcut-input");
                input.readOnly = true;
                input.value = prettyKey(getPlayerSettings(this.app).shortcuts[def.id] ?? "");
                input.addEventListener("keydown", e => {
                    if (e.key === "Tab") return; // 保留正常的焦点切换
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === "Escape") { input.blur(); return; }
                    if (isModifierOnly(e)) return;
                    const combo = normalizeKeyEvent(e);
                    updatePlayerSettings(this.app, { shortcuts: { [def.id]: combo } });
                    refreshPlayers(this.app);
                    input.value = prettyKey(combo);
                    input.blur();
                }, true);
            });

            setting.addButton(btn => btn.setButtonText(t("shortcut.reset")).onClick(() => {
                input.value = prettyKey(resetShortcut(this.app, def.id).shortcuts[def.id]);
                refreshPlayers(this.app);
            }));
        }
    }
}
