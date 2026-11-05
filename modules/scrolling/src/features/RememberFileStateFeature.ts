import {
    Debouncer,
    Editor,
    EditorRange,
    FileView,
    MarkdownView,
    Notice,
    Platform,
    TAbstractFile,
    TFile,
    WorkspaceLeaf,
    debounce,
    normalizePath,
    setIcon,
} from "obsidian";
import type { Setting, TextComponent } from "obsidian";
import type { Feature, FeatureSettingsDefinition, ScrollingPlugin } from "@core/Feature";
import type { CustomRenderContext } from "@core/settings.schema";

interface EphemeralState {
    timestamp: number;
    scroll?: number;
    scrollTop?: number;
    cursor?: EditorRange;
}

// 库外存储（聚合主仓新增）：位置表写到 vault 之外的绝对路径（同步盘外的本机
// 文件），滚动时的高频落盘不再进同步队列。node:fs 保持 external，由 Electron
// renderer 的 nodeIntegration 在运行时解析；这里惰性 require，移动端（无
// nodeIntegration）拿到 null，外部存储的所有入口都会先挡在 isDesktop 上。
type FsModule = typeof import("node:fs");
type PathModule = typeof import("node:path");

let fsModule: FsModule | null | undefined;
function getFs(): FsModule | null {
    if (fsModule === undefined) {
        try {
            fsModule = require("node:fs") as FsModule;
        } catch {
            fsModule = null;
        }
    }
    return fsModule;
}
let pathModule: PathModule | null | undefined;
function getPath(): PathModule | null {
    if (pathModule === undefined) {
        try {
            pathModule = require("node:path") as PathModule;
        } catch {
            pathModule = null;
        }
    }
    return pathModule;
}

class FileLeaf extends WorkspaceLeaf {
    // 聚合主仓开了 strictPropertyInitialization：这里只是收窄 WorkspaceLeaf
    // 的 view 类型（不产生运行时字段，故用 declare）。
    declare view: FileView;
}

export class RememberFileStateFeature implements Feature {
    public readonly settings = {
        items: [
            {
                name: "Mode",
                desc: "Start at the top/bottom of the file, or restore the cursor or scroll position.",
                control: {
                    type: "dropdown",
                    key: "restoreScrollMode",
                    defaultValue: "top",
                    options: {
                        top: "Start at top (Obsidian's default)",
                        bottom: "Start at bottom",
                        cursor: "Restore Cursor position",
                        scroll: "Restore scroll position",
                    },
                },
            },
            {
                name: "Saved positions limit",
                desc: (): string => {
                    const count = this.getNumEphemeralStates();
                    return (
                        `Number of files to remember scroll positions for. ` +
                        `Leave empty for unlimited.\n` +
                        `Currently positions for ${count} file${count === 1 ? "" : "s"} are stored.`
                    );
                },
                control: {
                    type: "number",
                    key: "restoreScrollLimit",
                    defaultValue: -1,
                    placeholder: "Unlimited",
                    displayFormat: (value): string => {
                        return value > 0 ? value.toString() : "";
                    },
                    // `null` rejects the edit and keeps the stored value.
                    parse: (value): number | null => {
                        const limit = +value;
                        if (isNaN(limit) || limit.toString().includes(".")) {
                            return null;
                        }
                        return limit <= 0 ? -1 : limit;
                    },
                    disabled: (): boolean => {
                        return this.plugin.settings.restoreScrollMode === "top";
                    },
                },
            },
            {
                name: "Keep oldest scroll positions",
                desc: "When the limit is reached, keep the oldest saved positions instead of the most recent ones (default).",
                control: {
                    type: "toggle",
                    key: "restoreScrollAge",
                    defaultValue: false,
                    disabled: (): boolean => {
                        return this.plugin.settings.restoreScrollMode === "top";
                    },
                },
            },
            {
                name: "Enable in PDFs",
                desc: "Enable restoring position in PDF files.",
                control: {
                    type: "toggle",
                    key: "restoreScrollPdf",
                    defaultValue: false,
                    disabled: (): boolean => {
                        return this.plugin.settings.restoreScrollMode === "top";
                    },
                },
            },
            {
                name: "Enable in Bases",
                desc: "Enable restoring position in Bases.",
                control: {
                    type: "toggle",
                    key: "restoreScrollBases",
                    defaultValue: false,
                    disabled: (): boolean => {
                        return this.plugin.settings.restoreScrollMode === "top";
                    },
                },
            },
            {
                name: "Enable for link use",
                desc: "Enable restoring position when clicking links to files (not headings).",
                control: {
                    type: "toggle",
                    key: "restoreScrollFileLink",
                    defaultValue: true,
                    disabled: (): boolean => {
                        return this.plugin.settings.restoreScrollMode === "top";
                    },
                },
            },
            {
                name: "Enable only on launch",
                desc: "Only restore position once per file per session.",
                control: {
                    type: "toggle",
                    key: "restoreScrollInitialOnly",
                    defaultValue: false,
                    disabled: (): boolean => {
                        return this.plugin.settings.restoreScrollMode === "top";
                    },
                },
            },
            {
                name: "Delay after opening a note",
                desc: "Number of milliseconds to wait before restoring position.\nUse if restoring works unreliably.",
                control: {
                    type: "slider",
                    key: "restoreScrollDelay",
                    defaultValue: 5,
                    min: 0,
                    max: 300,
                    step: 5,
                    disabled: (): boolean => {
                        return this.plugin.settings.restoreScrollMode === "top";
                    },
                },
            },
            {
                name: "Store positions in file",
                desc: "Save positions inside a file to keep them after Obsidian restarts.",
                aliases: ["Storage file path"],
                control: {
                    type: "toggle",
                    key: "restoreScrollFileEnabled",
                    defaultValue: true,
                    disabled: (): boolean => {
                        return this.plugin.settings.restoreScrollMode === "top";
                    },
                },
            },
            {
                // 聚合主仓新增：库外存储。同步盘 vault 里高频滚动写盘全是同步
                // 噪音——外部文件（绝对路径，本机）绕开同步。仅桌面（node:fs）。
                name: "Store positions outside the vault",
                desc:
                    "Desktop only. Write the positions file to an absolute path on this machine " +
                    "instead of inside the vault, so the frequent scroll writes never reach a " +
                    "synced folder. Turning this on migrates the existing vault file to the " +
                    "external location (the vault copy is kept as a backup).",
                control: {
                    type: "toggle",
                    key: "restoreScrollExternal",
                    // 默认开（2026-11-06 用户指定）：位置文件落
                    // E:\HOME\Runtime\scrolling，同步盘 vault 不再吃高频写盘。
                    // 移动端 isExternalStorage() 自判 false 回落库内。
                    defaultValue: true,
                    disabled: (): boolean => {
                        return this.plugin.settings.restoreScrollMode === "top";
                    },
                },
                visible: (): boolean => {
                    return this.plugin.settings.restoreScrollFileEnabled && Platform.isDesktopApp;
                },
                onChange: (value: unknown) => {
                    if (value === true) void this.migrateToExternal();
                },
            },
            {
                // 聚合主仓新增（上游没有）：写盘时机开关。
                name: "Write file only on exit",
                desc:
                    "Keep positions in memory and write the storage file only when Obsidian closes " +
                    "(or when this module is disabled/reloaded) instead of after every scroll. " +
                    "Fewer disk writes, at the cost of losing the current session's positions " +
                    "if Obsidian is killed without a clean exit.",
                control: {
                    type: "toggle",
                    key: "restoreScrollWriteOnExitOnly",
                    defaultValue: false,
                    disabled: (): boolean => {
                        return this.plugin.settings.restoreScrollMode === "top";
                    },
                },
                visible: (): boolean => {
                    return this.plugin.settings.restoreScrollFileEnabled;
                },
            },
            {
                name: "Storage file path",
                desc: (): string =>
                    this.isExternalStorage()
                        ? "Absolute path on this machine (outside the vault) for persistent storage of scrolling positions."
                        : "File for persistent storage of scrolling positions across sessions (vault-relative).",
                control: {
                    type: "text",
                    key: "restoreScrollFilePath",
                    disabled: (): boolean => {
                        return this.plugin.settings.restoreScrollMode === "top";
                    },
                },
                visible: (): boolean => {
                    return this.plugin.settings.restoreScrollFileEnabled;
                },
                render: (setting, ctx): (() => void) =>
                    this.renderStatesFilePathRow(setting, ctx),
            },
        ],
    } as const satisfies FeatureSettingsDefinition;

    private plugin!: ScrollingPlugin;

    private ephemeralStates: Record<string, EphemeralState> = {};

    // Number of files that are currently opening.
    // If atleast one file is opening, no file states will be saved.
    private numOpeningFiles = 0;

    private storeStateDebounced!: Debouncer<[HTMLElement?, Event?], void>;
    private writeStatesFileDebounced!: Debouncer<[], void>;

    private openLeafIds = new Set();

    // 由 onload 赋值（聚合主仓开了 strictPropertyInitialization）。
    private workspaceInitialized!: boolean;

    // Prime numbers :)
    private readonly STORE_INTERVAL = 97;
    private readonly FILE_WRITE_INTERVAL = 293;

    async onload(plugin: ScrollingPlugin): Promise<void> {
        this.plugin = plugin;

        if (plugin.settings.restoreScrollFilePath === undefined) {
            void plugin.settingsStore.set("restoreScrollFilePath", this.getDefaultStateFilePath());
        }

        // 外部存储默认开启（2026-11-06）：两类存量路径都要补迁移——①库内相对
        // 路径（外部默认新开后路径没跟上）；②旧外部默认 %APPDATA%（外部模式
        // 早已开启、路径跟着旧默认走的库）。migrateToExternal 会把位置文件
        // 复制到 E:\HOME\Runtime\scrolling\<库slug>.json，原文件保留作备份。
        if (this.isExternalStorage()) {
            const currentPath = plugin.settings.restoreScrollFilePath ?? "";
            const legacy = this.legacyExternalDefaultPath();
            const onLegacy = !!legacy && !!currentPath && currentPath.trim().toLowerCase() === legacy.toLowerCase();
            if (!currentPath || !this.isAbsolutePath(currentPath) || onLegacy) {
                void this.migrateToExternal();
            }
        }

        // True when plugin is reloaded.
        this.workspaceInitialized = this.plugin.app.workspace.layoutReady;

        this.storeStateDebounced = debounce(
            this.storeFileState.bind(this),
            this.STORE_INTERVAL,
            false,
        );

        this.writeStatesFileDebounced = debounce(
            this.writeStatesFile.bind(this),
            this.FILE_WRITE_INTERVAL,
            true,
        );

        // 聚合主仓新增：只在退出时落盘。'quit' 是 Obsidian 关闭（含关窗/退出）时
        // 发的最后一次事件；模块被禁用/重载时 unload 也会冲一次，避免白丢。
        // 两者共用同一个 flush，重复调用无害（writeStatesFile 只是整表重写）。
        plugin.registerEvent(
            this.plugin.app.workspace.on("quit", () => {
                void this.flushStatesFile();
            }),
        );
        plugin.register(() => {
            void this.flushStatesFile();
        });

        // TODO: consider simply patching into WorkspaceLeaf.setViewState. It contains info about flashing element
        // see core/events for monkey patching

        plugin.events.onScroll(this.scrollHandler.bind(this));
        plugin.events.onMouseUp(this.mouseUpHandler.bind(this));
        plugin.events.onFileOpen(this.fileOpenHandler.bind(this));
        plugin.events.onFileDelete(this.fileDeleteHandler.bind(this));
        plugin.events.onFileRename(this.fileRenameHandler.bind(this));
        plugin.events.onLayoutReady(this.layoutReadyHandler.bind(this));
        plugin.events.onLayoutReady(this.cursorUpdateHandler.bind(this));

        // Read the positions file here rather than from the plugin, so this feature
        // owns its whole startup. `FeatureRegistry.loadAll` awaits `onload`, so the
        // states are in memory before the feature returns. Deliberately not gated on
        // `restoreScrollFileEnabled`: having storage turned off should not discard the
        // file, or re-enabling it later would start from an empty table.
        await this.loadStatesFile();
    }

    onunload(): void {}

    /**
     * Returns the number of stored file states.
     * Used in the settings menu to display the status.
     */
    public getNumEphemeralStates(): number {
        return Object.keys(this.ephemeralStates).length;
    }

    // ------------------------------------------------------------------
    // 库外存储（聚合主仓新增）——IO 分流的公共部分
    // ------------------------------------------------------------------

    /** 外部模式生效 = 开关开 + 桌面 + node:fs 可用。移动端没有 fs，永远走库内。 */
    private isExternalStorage(): boolean {
        return Platform.isDesktopApp && this.plugin.settings.restoreScrollExternal === true && getFs() !== null;
    }

    /** Windows 盘符路径 / POSIX 绝对路径判定（外部模式下用于识别已配置的绝对路径）。 */
    private isAbsolutePath(p: string): boolean {
        return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\");
    }

    /**
     * 外部默认路径（用户指定，2026-11-06）：E:\HOME\Runtime\scrolling——本机
     * 运行时目录（与统一索引同层），绝不在任何 vault（同步盘）内。文件名带库
     * 身份（slug = 库绝对路径净化 + fnv1a-32 前 6 位，惯例同 unified-index 的
     * 库文件命名）——状态键是库相对路径，两库共用一个文件会互相串位。
     * 用户可在设置页改。
     */
    private externalDefaultPath(): string {
        const path = getPath();
        if (!path) return "";
        const base = String(
            (this.plugin.app.vault.adapter as unknown as { basePath?: string }).basePath ??
                this.plugin.manifest.id ??
                "vault",
        );
        let h = 0x811c9dc5;
        for (let i = 0; i < base.length; i++) {
            h ^= base.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        h >>>= 0;
        const slug = `${base.replace(/[^A-Za-z0-9._-]/g, "_")}-${h.toString(16).padStart(8, "0").slice(0, 6)}`;
        return path.join("E:\\HOME\\Runtime\\scrolling", `scrolling-${slug}.json`);
    }

    /**
     * 首次切到库外存储时调用：路径还是库内相对路径就换成外部默认路径，并把
     * 现有库内位置文件复制过去（库内原件保留作备份）。已在绝对路径上则仅尝试
     * 把库内默认文件迁移过来（用户可能改过路径）。
     * 例外（2026-11-06）：当前路径若等于**旧外部默认**（%APPDATA%/obsidian/
     * scrolling-positions.json），视为「跟着旧默认走」而非用户手选——同样迁到
     * 新默认 E:\HOME\Runtime\scrolling，旧外部文件内容一并带过去。
     */
    private async migrateToExternal(): Promise<void> {
        const fs = getFs();
        if (!fs) {
            new Notice("External storage requires the desktop app.");
            await this.plugin.settingsStore.set("restoreScrollExternal", false);
            return;
        }
        const current = this.plugin.settings.restoreScrollFilePath ?? "";
        const legacy = this.legacyExternalDefaultPath();
        const onLegacyExternal = !!legacy && !!current && current.trim().toLowerCase() === legacy.toLowerCase();
        let target = current;
        let fsSource = "";
        if (!current || !this.isAbsolutePath(current) || onLegacyExternal) {
            target = this.externalDefaultPath();
            if (!target) {
                new Notice("External storage is not available on this system.");
                await this.plugin.settingsStore.set("restoreScrollExternal", false);
                return;
            }
            if (onLegacyExternal) fsSource = current;
            await this.plugin.settingsStore.set("restoreScrollFilePath", target);
        }

        // 迁移源：库内路径（相对路径现状/库内默认），或旧外部默认文件。
        const vaultSource = !current || this.isAbsolutePath(current) ? this.getDefaultStateFilePath() : current;
        try {
            const adapter = this.plugin.app.vault.adapter;
            const hasVaultSource = !this.isAbsolutePath(vaultSource) && (await adapter.exists(vaultSource));
            const hasFsSource = !!fsSource && fs.existsSync(fsSource);
            const hasTarget = fs.existsSync(target);
            if ((hasVaultSource || hasFsSource) && !hasTarget) {
                const path = getPath();
                const dir = path ? path.dirname(target) : "";
                if (dir) fs.mkdirSync(dir, { recursive: true });
                const data = hasFsSource ? fs.readFileSync(fsSource, "utf-8") : await adapter.read(vaultSource);
                fs.writeFileSync(target, data, "utf-8");
                new Notice(`Migrated scroll positions to ${target} (the old copy is kept).`);
            }
        } catch (err) {
            console.warn("Scroll positions migration failed:", err);
        }
    }

    /**
     * 旧版外部默认路径（2026-11-06 前的 externalDefaultPath 实现）——仅用于
     * 识别「跟着旧默认走」的存量配置并迁到新默认，不是可选目标。
     */
    private legacyExternalDefaultPath(): string {
        const path = getPath();
        if (!path) return "";
        const base = process.env.APPDATA || path.join(process.env.USERPROFILE ?? "", ".config");
        return path.join(base, "obsidian", "scrolling-positions.json");
    }

    /** 位置文件是否存在（按当前模式走 fs 或 vault adapter）。 */
    private async statesFileExists(filePath: string): Promise<boolean> {
        if (this.isExternalStorage()) {
            const fs = getFs();
            if (!fs) return false;
            try {
                return fs.existsSync(filePath);
            } catch {
                return false;
            }
        }
        return this.plugin.app.vault.adapter.exists(filePath);
    }

    /** 读位置文件全文（按当前模式分流）。 */
    private async readStatesFile(filePath: string): Promise<string> {
        if (this.isExternalStorage()) {
            const fs = getFs();
            if (!fs) throw new Error("node:fs unavailable");
            return fs.readFileSync(filePath, "utf-8");
        }
        return this.plugin.app.vault.adapter.read(filePath);
    }

    /** 写位置文件全文（外部模式确保父目录存在）。 */
    private async writeStatesFileAt(filePath: string, data: string): Promise<void> {
        if (this.isExternalStorage()) {
            const fs = getFs();
            const path = getPath();
            if (!fs || !path) throw new Error("node:fs unavailable");
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, data, "utf-8");
            return;
        }
        await this.plugin.app.vault.adapter.write(filePath, data);
    }

    /** 某路径的父目录是否存在（外部模式按 fs 判，库内模式按 adapter 判）。 */
    private async directoryOfFileExists(filePath: string): Promise<boolean> {
        const lastSlashIndex = filePath.lastIndexOf("/");
        const winSlash = filePath.lastIndexOf("\\");
        const idx = Math.max(lastSlashIndex, winSlash);
        if (idx === -1) {
            return true;
        }
        const dirPath = filePath.substring(0, idx);
        if (this.isExternalStorage()) {
            const fs = getFs();
            if (!fs) return false;
            try {
                return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
            } catch {
                return false;
            }
        }
        return await this.plugin.app.vault.adapter.exists(dirPath);
    }

    /**
     * Reads the state file on disk into memory.
     *
     * Returns without touching the in-memory states when there is no file to read,
     * so a missing file cannot discard positions this session has already recorded.
     */
    public async loadStatesFile(): Promise<void> {
        const exists = await this.checkStatesFileLoadPath();
        if (!exists) return;
        const filePath = this.plugin.settings.restoreScrollFilePath;

        try {
            const data = await this.readStatesFile(filePath);
            if (data) {
                this.ephemeralStates = JSON.parse(data);
            } else {
                this.ephemeralStates = {};
            }
        } catch {
            console.warn("Failed to load scroll positions file:", filePath);
            this.ephemeralStates = {};
        }
    }

    /**
     * Returns the valid normalized path or nothing.
     * Emits notices to the user on success or failure.
     * Used in the settings menu.
     * Do not confuse with renameFileHandler.
     */
    public async renameStatesFile(newPath: string | null): Promise<string | undefined> {
        if (!this.plugin.settings.restoreScrollFileEnabled) return;

        if (newPath === null) {
            new Notice("Path unchanged.");
            return;
        }

        // Check empty/invalid paths before normalizing.
        if (!newPath || newPath.trim() === "" || newPath === "." || newPath === "..") {
            new Notice("Invalid file path!");
            return;
        }

        const external = this.isExternalStorage();
        if (external) {
            // 外部模式：绝对路径直用（Windows 反斜杠原样保留），不碰
            // normalizePath——它会把绝对路径当 vault 相对路径改写。
            const fs = getFs();
            const path = getPath();
            if (!fs || !path) {
                new Notice("External storage requires the desktop app.");
                return;
            }
            const target = newPath.trim();
            const old = this.plugin.settings.restoreScrollFilePath ?? "";
            if (!(await this.directoryOfFileExists(target))) {
                new Notice(`Directory of file does not exist.`);
                return;
            }
            if (fs.existsSync(target)) {
                new Notice(`File already exists: ${target}`);
                return;
            }
            if (old && fs.existsSync(old)) {
                try {
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.renameSync(old, target);
                } catch {
                    new Notice("Invalid file path!");
                    return;
                }
            }
            new Notice(`Renamed storage file to: ${target}`);
            return target;
        }

        // Assuming this.plugin.settings.restoreScrollStoreFile is valid
        const newNormalizedPath = normalizePath(newPath);
        const oldNormalizedPath = normalizePath(this.plugin.settings.restoreScrollFilePath);

        if (!newNormalizedPath) {
            new Notice("Invalid file path!");
            return;
        }

        const adapter = this.plugin.app.vault.adapter;

        if (!(await this.directoryOfFileExists(newNormalizedPath))) {
            new Notice(`Directory of file does not exist.`);
            return;
        }

        if (await adapter.exists(newNormalizedPath)) {
            new Notice(`File already exists: ${newNormalizedPath}`);
            return;
        }

        if (oldNormalizedPath && (await adapter.exists(oldNormalizedPath))) {
            try {
                await adapter.rename(oldNormalizedPath, newNormalizedPath);
            } catch {
                new Notice("Invalid file path!");
                return;
            }
        }

        new Notice(`Renamed storage file to: ${newNormalizedPath}`);
        return newNormalizedPath;
    }

    /**
     * Renders the storage path row, which stages edits until they are confirmed.
     *
     * Confirming renames the existing positions file first, so a path change can
     * never orphan the file the user already has. The stored value only moves
     * once the rename succeeded, which is why this row builds its own DOM
     * instead of using the declarative text control.
     * @param setting The row to build the control in.
     * @param ctx Store access for reading and committing the path.
     * @returns A cleanup that detaches the listeners this row added.
     */
    private renderStatesFilePathRow(setting: Setting, ctx: CustomRenderContext): () => void {
        // `null` means "no pending change", which is distinct from a staged empty string.
        let staged: string | null = null;
        let text!: TextComponent;

        // `ctx.current()` is untyped because the context erases the key/value
        // correlation; this row is a text control, so anything else means no path.
        const stored = (): string => {
            const value = ctx.current();
            return typeof value === "string" ? value : "";
        };

        const confirm = async (): Promise<void> => {
            if (ctx.isDisabled() || staged === null) return;

            const newPath = await this.renameStatesFile(staged);
            if (newPath === undefined) return;

            staged = null;
            text.setValue(newPath);
            ctx.commit(newPath);
        };

        const discard = (): void => {
            if (staged === null) return;

            staged = null;
            text.setValue(stored());
        };

        setting.addText((component) => {
            text = component;
            component.setValue(stored()).onChange((raw: string) => {
                staged = raw;
            });
        });

        const onKeydown = (event: KeyboardEvent): void => {
            if (event.key === "Enter") {
                event.preventDefault();
                void confirm();
            }
        };
        text.inputEl.addEventListener("keydown", onKeydown);

        const discardButton = setting.controlEl.createDiv({
            cls: "clickable-icon extra-setting-button",
        });
        discardButton.setAttr("aria-label", "Discard path change");
        setIcon(discardButton, "reset");
        discardButton.onclick = discard;

        const confirmButton = setting.controlEl.createEl("button", { text: "Confirm" });
        confirmButton.onclick = (): void => void confirm();
        confirmButton.disabled = ctx.isDisabled();

        return () => {
            text.inputEl.removeEventListener("keydown", onKeydown);
            discardButton.onclick = null;
            confirmButton.onclick = null;
        };
    }

    /**
     * On scroll event.
     * Requests to save the file scroll state & store it in a file.
     */
    private scrollHandler(event: Event): void {
        if (!this.workspaceInitialized || this.numOpeningFiles > 0) return;

        this.storeStateDebounced(event.target as HTMLElement);
        this.scheduleWrite();
    }

    /**
     * On mouse up event.
     */
    private mouseUpHandler(event: MouseEvent) {
        this.storeStateDebounced(event.target as HTMLElement);
    }

    /**
     * On cursor update.
     */
    // 形参放宽为可选：events.onLayoutReady 的回调是 () => void，
    // 带可选形参的函数可赋给它，运行时调用不变。
    private cursorUpdateHandler(
        _editor?: Editor,
        _docChanged?: boolean,
        vimModeChanged?: boolean,
    ) {
        if (vimModeChanged) return;
        this.storeStateDebounced();
    }

    /**
     * On file open.
     * Restores file state of the opened file.
     * Does not restore on initial load.
     * Does not restore if the same file is opened in the same split already.
     * Does not restore if heading link is used or links are disabled and any link is used.
     * Might break if the same file is opened twice in different tabs simultaneously .
     */
    // events.onFileOpen 传入 TFile | null；上游只按非空使用，此处仅放宽签名。
    private fileOpenHandler(_file: TFile | null): void {
        // Do not restore on initial load. Responsiblity of layoutReadyHandler.
        if (!this.workspaceInitialized) return;
        if (this.plugin.settings.restoreScrollInitialOnly) return;

        // Do not restore if heading link/search is used.
        // BUG: is-flashing might be still active on an element in the previous view
        // NOTE: can be avoided by hooking into WorkspaceLeaf.setViewState directly
        const headingLinkUsed = this.plugin.app.workspace.containerEl.querySelector(".is-flashing");
        if (headingLinkUsed) return;

        // Do not restore if any link was used and links are disabled.
        if (this.plugin.events.isOpeningWithLink && !this.plugin.settings.restoreScrollFileLink)
            return;

        // Mode top means feature is disabled.
        if (this.plugin.settings.restoreScrollMode === "top") return;

        // Get the currently opened leaf
        let fileLeaf = (this.plugin.app.workspace.getActiveFileView()?.leaf as FileLeaf) || null;
        if (fileLeaf === null) return;

        // File-open event is invoked on switching tabs!
        // This keeps track of all currently opened leafs.
        // Might make the isFileOpenedInSplit redundant.
        let isOpened = this.openLeafIds.has(this.getFileId(fileLeaf.view));
        this.openLeafIds.clear();
        this.plugin.app.workspace.iterateRootLeaves((leaf) => {
            if (leaf.view instanceof FileView) this.openLeafIds.add(this.getFileId(leaf.view));
        });
        if (isOpened) return;

        // Check whether the same file is already opened in other tab of the same split.
        if (this.isFileOpenedInSplit(fileLeaf)) return;

        // Must be reset in iter!
        this.numOpeningFiles += 1;

        // Restore state as soon as file finished loading.
        let numFrames = 0;
        const MAX_ATTEMPTS = 100;
        const iter = () => {
            // Check again if heading link/search was used, in case file loads slowly.
            const headingLinkUsed =
                this.plugin.app.workspace.containerEl.querySelector(".is-flashing");
            if (headingLinkUsed) return;

            if (fileLeaf && fileLeaf.working && numFrames++ < MAX_ATTEMPTS) {
                window.requestAnimationFrame(iter);
            } else {
                this.restoreFileState(fileLeaf.view);

                // File is opened and does not prohibit state saving anymore.
                // Maybe add some edge case handling.
                this.numOpeningFiles -= 1;
            }
        };
        iter();

        this.scheduleWrite();
    }

    /**
     * On Obsidian layout ready or plugin reload.
     * Restores visible leaves across all splits.
     */
    private layoutReadyHandler() {
        // Skip if plugin is reloaded.
        if (this.workspaceInitialized) return;

        this.plugin.app.workspace.iterateRootLeaves((leaf) => {
            if (leaf.view instanceof FileView) {
                this.restoreFileState(leaf.view);
            }
        });

        // Mark as initialized, because Workspace.layoutReady is set to true too early.
        this.workspaceInitialized = true;
    }

    /**
     * On file deletion.
     * Updates file cache.
     */
    private fileDeleteHandler(file: TAbstractFile): void {
        delete this.ephemeralStates[file.path];
    }

    /**
     * On file rename.
     * Updates file cache.
     * Marks file as not to be restored.
     * Do not confuse with renameStatesFile.
     */
    private fileRenameHandler(file: TAbstractFile, old: string): void {
        this.ephemeralStates[file.path] = this.ephemeralStates[old];
        delete this.ephemeralStates[old];
    }

    /**
     * Do not confuse with renameStatesFile.
     */
    private getDefaultStateFilePath(): string {
        return this.plugin.manifest.dir + "/scrolling-positions.json";
    }

    /**
     * Checks whether the file of the specified leaf is already opened in a different tab of the same split.
     */
    private isFileOpenedInSplit(leaf: WorkspaceLeaf): boolean {
        if (!(leaf.view instanceof FileView)) return false;

        for (let sibling of leaf.parentSplit.children) {
            if (
                !(sibling instanceof WorkspaceLeaf) ||
                !(sibling.view instanceof FileView) ||
                sibling.view === leaf.view
            ) {
                continue;
            }
            if (leaf.view.file!.path == sibling.view.file!.path) return true;
        }

        return false;
    }

    /**
     * Restores the file state without extra checks.
     * Whether the state should be restored must be decided in advance.
     */
    private restoreFileState(view: FileView): void {
        // Mode top means feature is disabled.
        if (this.plugin.settings.restoreScrollMode === "top") return;

        // 上游三个变量在 bottom 分支里不赋值（类型上就是“可能未定义”），
        // 聚合主仓开了严格空检查，故显式声明为可空。
        let cursor: EditorRange | undefined;
        let scroll: number | undefined;
        let scrollTop: number | undefined;
        if (this.plugin.settings.restoreScrollMode === "bottom") {
            // For bottom mode use same logic as for scroll mode.
            scroll = Infinity;
            scrollTop = Infinity;
        } else {
            // Read state of file with split id.
            const fileId = this.getFileId(view);
            const ephemeralState = this.ephemeralStates[fileId];
            if (!ephemeralState) return;
            ({ cursor, scroll, scrollTop } = ephemeralState);
        }

        if (view instanceof MarkdownView && view.getMode() === "source" && (scroll || cursor)) {
            if (cursor && this.plugin.settings.restoreScrollMode === "cursor") {
                view.editor.setCursor(cursor.from);
                view.setEphemeralState({ cursor, scroll, focus: true });
                view.editor.scrollIntoView(cursor, true);
                window.setTimeout(() => {
                    view.setEphemeralState({ cursor, focus: true });
                    view.editor.scrollIntoView(cursor, true);
                }, this.plugin.settings.restoreScrollDelay);
            } else {
                view.setEphemeralState({ scroll });
                window.setTimeout(() => {
                    view.setEphemeralState({ scroll });
                }, this.plugin.settings.restoreScrollDelay);
            }
        } else if (scrollTop) {
            const scroller = this.getScroller(view);
            if (!scroller) return;

            // Bases content loads in late.
            let numFrames = 0;
            const MAX_ATTEMPTS = 100;
            const iter = () => {
                scroller.scrollTop = scrollTop;

                if (scroller.scrollTop !== scrollTop && numFrames++ < MAX_ATTEMPTS) {
                    window.requestAnimationFrame(iter);
                }
            };
            iter();
        }
    }

    /**
     * Returns the scroller Element for pdf files, bases and markdown previews.
     * Markdown source must be checked and handled separately.
     * Pdf is only enabled on mobile.
     */
    private getScroller(view: FileView): HTMLElement | null {
        switch (view.getViewType()) {
            case "markdown":
                return view.containerEl.querySelector(".markdown-preview-view");
            case "pdf":
                if (!Platform.isMobile || !this.plugin.settings.restoreScrollPdf) return null;
                return view.containerEl.querySelector(".pdf-viewer-container");
            case "bases":
                if (!this.plugin.settings.restoreScrollBases) return null;
                return view.containerEl.querySelector(".bases-view");
            default:
                return null;
        }
    }

    /**
     * 计划一次落盘（聚合主仓新增的调度层）。
     *
     * 上游每次滚动/打开文件都会防抖写盘（293ms），库里文件多或开着同步盘时写
     * 得很勤。开了「Write file only on exit」后这里直接返回，写盘只由退出/卸载
     * 时的 flush 触发。
     */
    private scheduleWrite(): void {
        if (this.plugin.settings.restoreScrollWriteOnExitOnly) return;
        this.writeStatesFileDebounced();
    }

    /**
     * 立即把内存里的整张位置表写进文件（退出 / 模块卸载时调用）。
     * 取消在途的防抖任务，避免退出时又排一次已经不需要的写。
     */
    private async flushStatesFile(): Promise<void> {
        this.writeStatesFileDebounced?.cancel();
        await this.writeStatesFile();
    }

    /**
     * Validates or updates the path to the state file on disk for writing (not reading).
     * Attempts "scrolling" and "obsidian-scrolling" as fallback directory names of this plugin.
     */
    private async checkStatesFileWritePath(): Promise<void> {
        // Check saved path
        if (await this.directoryOfFileExists(this.plugin.settings.restoreScrollFilePath)) return;

        // Check default path（外部模式回落外部默认；库内模式回落插件目录）
        let default_path = this.isExternalStorage() ? this.externalDefaultPath() : this.getDefaultStateFilePath();
        if (default_path && (await this.directoryOfFileExists(default_path))) {
            await this.plugin.settingsStore.set("restoreScrollFilePath", default_path);
            return;
        }
    }

    /**
     * Updates the state file path.
     * Writes the state file on disk asynchronously.
     *  TODO: should write to a temporary file to avoid interrupt corruptions.
     */
    private async writeStatesFile(): Promise<void> {
        if (!this.plugin.settings.restoreScrollFileEnabled) return;

        await this.checkStatesFileWritePath();
        const filePath = this.plugin.settings.restoreScrollFilePath;

        try {
            const data = JSON.stringify(this.ephemeralStates);
            await this.writeStatesFileAt(filePath, data);
        } catch {
            new Notice("Failed to write scroll positions file. Disabling disk storage.");
            console.error("Failed to write scroll positions file:", filePath);
            await this.plugin.settingsStore.set("restoreScrollFileEnabled", false);
        }
    }

    /**
     * Validates or updates the path to the storage file on disk for reading (not writing).
     * Attempts "scrolling" and "obsidian-scrolling" as fallback directory names of this plugin.
     */
    private async checkStatesFileLoadPath(): Promise<boolean> {
        // Check saved path
        if (await this.statesFileExists(this.plugin.settings.restoreScrollFilePath)) return true;

        // Check default path
        let default_path = this.isExternalStorage() ? this.externalDefaultPath() : this.getDefaultStateFilePath();
        if (default_path && (await this.statesFileExists(default_path))) {
            await this.plugin.settingsStore.set("restoreScrollFilePath", default_path);
            return true;
        }

        return false;
    }

    /**
     * Get id of the split that contains a given leaf.
     * Returns a string with the nested split indices concatinated with -.
     * Returns an empty string for the zero indexed leaf.
     * Example: '1-0-2'
     */
    private getSplitIdOfLeaf(leaf: WorkspaceLeaf): string {
        /*
         * Example hierarchy:
         *
         * [container leaf]
         *   [container leaf]
         *     [tab leaf]
         *     [tab leaf]
         *   [container leaf]
         *     [container leaf]
         *       [tab leaf]
         *       [tab leaf]
         *     [container leaf]
         *       [tab leaf]
         *       [tab leaf]
         *
         * We expect the input leaf to be a tab. The parent of the leaf is a container.
         */

        if (!leaf?.parentSplit?.parentSplit) return "";

        const path: number[] = [];
        let current = leaf.parentSplit;

        while (current.parentSplit) {
            path.unshift(current.parentSplit.children.indexOf(current));
            current = current.parentSplit;
        }

        if (path.every((index) => index === 0)) return "";

        return path.join("-");
    }

    /**
     * Returns the file id based on the file path and split id.
     */
    private getFileId(view: FileView): string {
        const splitId = this.getSplitIdOfLeaf(view.leaf);
        if (splitId === "") {
            return view.file!.path;
        } else {
            return view.file!.path + "#" + splitId;
        }
    }

    /**
     * Checks and saves current scroll & cursor position in state cache.
     * Discards old states if number of stored states is limited.
     */
    private storeFileState(el?: Element, _event?: Event): void {
        const mode = this.plugin.settings.restoreScrollMode;
        if (mode === "top" || mode === "bottom") return;

        if (!this.workspaceInitialized || this.numOpeningFiles > 0) return;

        // If element is provided, find matching view. Otherwise use active view.
        // Not active leaves can be scrolled.
        // Blocked while loading (leaf.working) or not rendered (leaf.width is zero).
        let view: FileView | null = null;
        if (el) {
            this.plugin.app.workspace.iterateRootLeaves((leaf) => {
                if (
                    !leaf.working &&
                    leaf.width &&
                    leaf.view instanceof FileView &&
                    leaf.view.containerEl.contains(el)
                ) {
                    view = leaf.view;
                }
            });
        } else {
            view = this.plugin.app.workspace.getActiveViewOfType(FileView);
        }
        if (!view) return;

        const fileId = this.getFileId(view);

        const timestamp = Date.now();

        if (view instanceof MarkdownView && view.getMode() == "source") {
            const scrollTop = view.editor.getScrollInfo().top;
            const { cursor, scroll } = view.getEphemeralState() as {
                cursor?: EditorRange;
                scroll?: number;
            };

            // This function is also invoked on file load when using the file tree.
            // Simple to filter out by checking for undefined.
            if (cursor === undefined || scroll === undefined) return;

            this.ephemeralStates[fileId] = {
                timestamp,
                cursor,
                scroll,
                scrollTop,
            };
        } else {
            const scrollTop = this.getScroller(view)?.scrollTop;
            if (scrollTop) this.ephemeralStates[fileId] = { timestamp, scrollTop };
        }

        if (this.plugin.settings.restoreScrollAge) {
            this.discardNewStates();
        } else {
            this.discardOldStates();
        }
    }

    /**
     * Limits the number of stored file states by timestamp and discards the oldest.
     */
    private discardOldStates() {
        const entries = Object.entries(this.ephemeralStates);
        if (
            this.plugin.settings.restoreScrollLimit <= 0 ||
            entries.length <= this.plugin.settings.restoreScrollLimit
        )
            return;

        entries.sort(([, a], [, b]) => b.timestamp - a.timestamp);

        this.ephemeralStates = Object.fromEntries(
            entries.slice(0, this.plugin.settings.restoreScrollLimit),
        );
    }

    /**
     * Limits the number of stored file states by timestamp and discards the newest.
     * but will allow existing file states to be updated.
     */
    private discardNewStates() {
        const entries = Object.entries(this.ephemeralStates);
        const limit = this.plugin.settings.restoreScrollLimit;

        if (limit <= 0 || entries.length <= limit) return;

        entries.sort(([, a], [, b]) => a.timestamp - b.timestamp);

        const oldestStates = entries.slice(0, limit);
        const newestStates = entries.slice(limit);

        // Update states of existing old files to register new scroll positions
        const statesToKeep = new Map(oldestStates);
        for (const [fileTitle, state] of newestStates) {
            if (statesToKeep.has(fileTitle)) statesToKeep.set(fileTitle, state);
        }

        this.ephemeralStates = Object.fromEntries(statesToKeep.entries());
    }
}
