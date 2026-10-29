import { SuggestModal } from "obsidian";
import { momentFn } from "src/moment-compat";
import type ObsidianGit from "src/main";

export class CustomMessageModal extends SuggestModal<string> {
    resolve:
        ((value: string | PromiseLike<string> | undefined) => void) | null =
        null;
    constructor(private readonly plugin: ObsidianGit) {
        super(plugin.app);
        this.setPlaceholder(
            "Type your message and select optional the version with the added date."
        );
    }

    openAndGetResult(): Promise<string | undefined> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onClose() {
        // onClose gets called before onChooseItem
        void new Promise((resolve) => window.setTimeout(resolve, 10)).then(
            () => {
                if (this.resolve) this.resolve(undefined);
            }
        );
    }

    getSuggestions(query: string): string[] {
        const date = momentFn().format(this.plugin.settings.commitDateFormat);
        if (query == "") query = "...";
        return [query, `${date}: ${query}`, `${query}: ${date}`];
    }

    renderSuggestion(value: string, el: HTMLElement): void {
        el.innerText = value;
    }

    onChooseSuggestion(value: string, __: MouseEvent | KeyboardEvent) {
        if (this.resolve) this.resolve(value);
    }
}
