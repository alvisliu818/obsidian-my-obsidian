import {
    ButtonComponent,
    Modal,
    Setting,
    TextAreaComponent,
    TextComponent,
} from "obsidian";
import AdvancedURI from "../main";
import { Parameters } from "../types";

type SearchMode = "text" | "regex";

interface SearchModeOption {
    value: SearchMode;
    label: string;
    description: string;
}

export class SearchAndReplaceModal extends Modal {
    private readonly modes: SearchModeOption[] = [
        {
            value: "text",
            label: "Plain text",
            description: "Match the search text exactly.",
        },
        {
            value: "regex",
            label: "Regular expression",
            description: "Interpret the search text as a regular expression.",
        },
    ];

    private search = "";
    private replacement = "";
    private mode: SearchMode = "text";
    private copyButton: ButtonComponent;

    constructor(
        private readonly plugin: AdvancedURI,
        private readonly filepath?: string
    ) {
        super(plugin.app);
    }

    onOpen(): void {
        this.setTitle("Configure URI");

        const searchSection = this.contentEl.createDiv({
            cls: "advanced-uri-data-section",
        });
        new Setting(searchSection)
            .setName("Search")
            .setDesc("Enter the text or pattern to find.")
            .setHeading();

        const searchInput = new TextAreaComponent(searchSection);
        searchInput.setPlaceholder("Text to find").onChange((value) => {
            this.search = value;
            this.updateCopyButton();
        });
        searchInput.inputEl.addClass("advanced-uri-data-input");
        searchInput.inputEl.focus();

        new Setting(this.contentEl)
            .setName("Search mode")
            .setDesc("Select how to interpret the search text.")
            .setHeading();

        for (let index = 0; index < this.modes.length; index++) {
            const option = this.modes[index];
            const setting = new Setting(this.contentEl)
                .setName(option.label)
                .setDesc(option.description);
            const radio = setting.controlEl.createEl("input", {
                type: "radio",
                attr: {
                    name: "advanced-uri-search-mode",
                    value: option.value,
                    "aria-label": option.label,
                },
            });
            radio.checked = index === 0;
            radio.addEventListener("change", () => {
                if (radio.checked) {
                    this.mode = option.value;
                    this.updateCopyButton();
                }
            });
            setting.settingEl.addEventListener("click", (event) => {
                if (event.target !== radio) {
                    radio.focus();
                    radio.click();
                }
            });
            setting.settingEl.addClass("advanced-uri-mode-option");
        }

        const replacementSection = this.contentEl.createDiv({
            cls: "advanced-uri-data-section",
        });
        new Setting(replacementSection)
            .setName("Replacement")
            .setDesc(
                "Enter the replacement text. Leave this empty to remove matches."
            )
            .setHeading();

        const replacementInput = new TextAreaComponent(replacementSection);
        replacementInput
            .setPlaceholder("Replacement text")
            .onChange((value) => {
                this.replacement = value;
            });
        replacementInput.inputEl.rows = 4;
        replacementInput.inputEl.addClass("advanced-uri-data-input");

        new Setting(this.contentEl)
            .addButton((button) =>
                button.setButtonText("Cancel").onClick(() => this.close())
            )
            .addButton((button) => {
                this.copyButton = button
                    .setButtonText("Copy URI")
                    .setCta()
                    .onClick(() => this.copyURI());
                this.updateCopyButton();
            });
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private updateCopyButton(): void {
        this.copyButton?.setDisabled(
            this.search.length === 0 || !this.isRegexValid()
        );
    }

    private isRegexValid(): boolean {
        if (this.mode !== "regex") return true;

        try {
            const match = this.search.match(/(\/?)(.+)\1([a-z]*)/i);
            if (!match) return false;
            new RegExp(match[2], match[3]);
            return true;
        } catch {
            return false;
        }
    }

    private copyURI(): void {
        const parameters: Parameters = {
            filepath: this.filepath,
            replace: this.replacement,
        };
        if (this.mode === "regex") {
            parameters.searchregex = this.search;
        } else {
            parameters.search = this.search;
        }

        void this.plugin.tools.copyURI(parameters);
        this.close();
    }
}
