import { ButtonComponent, Modal, Setting, TextAreaComponent } from "obsidian";
import AdvancedURI from "../main";
import { Parameters } from "../types";

type WriteMode = Parameters["mode"] | undefined;

interface ModeOption {
    value: WriteMode;
    label: string;
    description: string;
}

export class EnterDataModal extends Modal {
    private readonly modes: ModeOption[] = [
        {
            value: undefined,
            label: "Default",
            description:
                "Write normally, or only open the file when data is empty.",
        },
        {
            value: "overwrite",
            label: "Overwrite",
            description: "Replace the existing file contents with the data.",
        },
        {
            value: "append",
            label: "Append",
            description: "Add the data after the existing file contents.",
        },
        {
            value: "prepend",
            label: "Prepend",
            description: "Add the data before the existing file contents.",
        },
    ];

    private data = "";
    private mode: WriteMode;
    private copyButton: ButtonComponent;

    constructor(
        private readonly plugin: AdvancedURI,
        private readonly withFormat: boolean,
        private readonly file?: string
    ) {
        super(plugin.app);
    }

    onOpen(): void {
        this.setTitle("Configure URI");

        const dataSection = this.contentEl.createDiv({
            cls: "advanced-uri-data-section",
        });
        new Setting(dataSection)
            .setName("Data")
            .setDesc(
                "Enter the text to write. Leave this empty to only open the file."
            )
            .setHeading();

        const textArea = new TextAreaComponent(dataSection);
        textArea.setPlaceholder("Text to write").onChange((value) => {
            this.data = value;
            this.updateCopyButton();
        });
        textArea.inputEl.rows = 4;
        textArea.inputEl.addClass("advanced-uri-data-input");
        textArea.inputEl.focus();

        new Setting(this.contentEl)
            .setName("Mode")
            .setDesc("Select how to write the data to the file.")
            .setHeading();

        for (let index = 0; index < this.modes.length; index++) {
            const option = this.modes[index];
            const setting = new Setting(this.contentEl)
                .setName(option.label)
                .setDesc(option.description);
            const radio = setting.controlEl.createEl("input", {
                type: "radio",
                attr: {
                    name: "advanced-uri-write-mode",
                    value: option.value ?? "default",
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

        new Setting(this.contentEl)
            .addButton((button) =>
                button.setButtonText("Cancel").onClick(() => this.close())
            )
            .addButton((button) => {
                this.copyButton = button
                    .setButtonText(
                        this.withFormat ? "Copy formatted URI" : "Copy URI"
                    )
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
            this.mode === "overwrite" && this.data.length === 0
        );
    }

    private copyURI(): void {
        const data = this.data.length > 0 ? this.data : undefined;
        const parameters: Parameters = this.file
            ? {
                  filepath: this.file,
                  data,
                  mode: this.mode,
              }
            : {
                  daily: "true",
                  data,
                  mode: this.mode,
              };

        void this.plugin.tools.copyURI(
            parameters,
            this.withFormat,
            this.file ? this.app.vault.getFileByPath(this.file) : undefined
        );
        this.close();
    }
}
