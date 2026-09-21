import { App, FuzzySuggestModal, Notice, Plugin, EditorPosition, ItemView, WorkspaceLeaf, MarkdownView, TFile, PluginSettingTab, Setting, normalizePath } from 'obsidian';

const VIEW_TYPE_VIDEO_RECORDER = 'video-recorder-view';

// --- Settings Interfaces ---
interface VideoJournalSettings {
    saveFolder: string;
}

const DEFAULT_SETTINGS: VideoJournalSettings = {
    saveFolder: 'Video Journals'
}

export default class VideoJournalPlugin extends Plugin {
    settings!: VideoJournalSettings;
    targetCursor: EditorPosition | null = null;
    targetFilePath: string | null = null;
    targetNoteWasSelected = false;
    lastActiveMarkdownPath: string | null = null;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new VideoJournalSettingTab(this.app, this));
        this.registerView(VIEW_TYPE_VIDEO_RECORDER, (leaf) => new VideoRecorderView(leaf, this));
        this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
            if (leaf?.view instanceof MarkdownView) {
                this.lastActiveMarkdownPath = leaf.view.file?.path ?? null;
            }
        }));

        this.addRibbonIcon('camera', 'Open Media Recorder', () => {
            void this.activateView(); // FIXED: Explicitly handled floating promise
        });
    }

    async loadSettings() {
        // FIXED: Added type assertion to resolve unsafe assignment warning
        this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<VideoJournalSettings>);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        const { workspace } = this.app;
        const activeEditor = workspace.activeEditor;
        const activeView = workspace.getActiveViewOfType(MarkdownView);
        const targetEditor = activeEditor?.editor ?? activeView?.editor ?? null;
        this.targetCursor = targetEditor?.getCursor() ?? null;
        this.targetFilePath = activeEditor?.file?.path
            ?? activeView?.file?.path
            ?? workspace.getActiveFile()?.path
            ?? null;
        if (this.targetFilePath) this.lastActiveMarkdownPath = this.targetFilePath;
        
        // FIX: Added 'undefined' to the allowed types
        let leaf: WorkspaceLeaf | null | undefined = null; 
        
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_VIDEO_RECORDER);
        
        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            if(leaf) {
                await leaf.setViewState({ type: VIEW_TYPE_VIDEO_RECORDER, active: true });
            }
        }
        
        if (leaf) void workspace.revealLeaf(leaf);
    }
}

// --- The UI View ---
class VideoRecorderView extends ItemView {
    plugin: VideoJournalPlugin;
    
    mediaRecorder: MediaRecorder | null = null;
    recordedChunks: BlobPart[] = [];
    stream: MediaStream | null = null;
    isMediaOn = false;

    elapsedSeconds = 0;
    timerInterval: number | null = null;
    
    // FIXED: Added definite assignment assertions (!) to resolve "possibly undefined" build errors
    videoElement!: HTMLVideoElement;
    timerDisplay!: HTMLElement;
    sourceSelect!: HTMLSelectElement;
    mediaToggleBtn!: HTMLButtonElement;
    recordBtn!: HTMLButtonElement;
    pauseBtn!: HTMLButtonElement;
    stopBtn!: HTMLButtonElement;
    pipBtn!: HTMLButtonElement;
    qualitySelect!: HTMLSelectElement;
    embedCheckbox!: HTMLInputElement;
    autoEmbedCheckbox!: HTMLInputElement;
    embedWidthInput!: HTMLInputElement;
    embedHeightInput!: HTMLInputElement;
    embedTargetLabel!: HTMLElement;
    muteCheckbox!: HTMLInputElement;

    constructor(leaf: WorkspaceLeaf, plugin: VideoJournalPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return VIEW_TYPE_VIDEO_RECORDER; }
    getDisplayText() { return 'Media Recorder'; }
    getIcon() { return 'camera'; }

    async onOpen() {
        // FIXED: Using this.contentEl safely instead of containerEl.children[1]
        const container = this.contentEl;
        container.empty();
        
        // Compact Header: Title and Timer on the same line
        const headerRow = container.createDiv({ attr: { style: 'display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px;' } });
        headerRow.createEl('h4', { text: 'Media Recorder', attr: { style: 'margin: 0;' }});
        this.timerDisplay = headerRow.createDiv({ 
            text: '00:00', 
            attr: { style: 'font-size: 1.2em; font-family: monospace; font-weight: bold; color: var(--text-error);' } 
        });

        // Small Controls right above the video
        const previewControls = container.createDiv({ attr: { style: 'display: flex; justify-content: space-between; gap: 5px; margin-bottom: 5px;' } });
        this.mediaToggleBtn = previewControls.createEl('button', { text: 'Turn on Camera', attr: { style: 'font-size: 0.8em; padding: 4px 8px; height: auto; flex: 1;' } });
        this.pipBtn = previewControls.createEl('button', { text: 'PiP', attr: { disabled: true, style: 'font-size: 0.8em; padding: 4px 8px; height: auto;' } });

        // Video Preview (Compact)
        this.videoElement = container.createEl('video', { 
            attr: { autoplay: true, style: 'width: 100%; border-radius: 6px; background: #222; min-height: 120px; max-height: 200px;' } 
        });

        // Settings Container (Reduced gaps)
        const settingsDiv = container.createDiv({ attr: { style: 'margin-top: 8px; display: flex; flex-direction: column; gap: 4px; font-size: 0.85em;' } });
        
        // Source Dropdown
        const sourceDiv = settingsDiv.createDiv({ attr: { style: 'display: flex; justify-content: space-between; align-items: center;' }});
        sourceDiv.createSpan({ text: 'Source:' });
        this.sourceSelect = sourceDiv.createEl('select', { attr: { style: 'padding: 2px 5px;' }});
        this.sourceSelect.createEl('option', { value: 'camera', text: 'Webcam' });
        this.sourceSelect.createEl('option', { value: 'screen', text: 'Screen Capture' });
        this.sourceSelect.createEl('option', { value: 'audio', text: 'Audio Only' });
        
        this.sourceSelect.onchange = () => {
            this.updateToggleButtonText();
            if (this.isMediaOn) void this.initMedia(); // FIXED: Handled floating promise
        };

        // Quality Dropdown
        const qualityDiv = settingsDiv.createDiv({ attr: { style: 'display: flex; justify-content: space-between; align-items: center;' }});
        qualityDiv.createSpan({ text: 'Quality:' });
        this.qualitySelect = qualityDiv.createEl('select', { attr: { style: 'padding: 2px 5px;' }});
        this.qualitySelect.createEl('option', { value: 'low', text: 'Low' });
        this.qualitySelect.createEl('option', { value: 'normal', text: 'Normal', attr: { selected: true }});
        this.qualitySelect.createEl('option', { value: 'high', text: 'High' });
        
        this.qualitySelect.onchange = () => {
            if (this.isMediaOn && this.sourceSelect.value === 'camera') void this.initMedia(); // FIXED: Handled floating promise
        };

        // Embed Toggle
        const embedDiv = settingsDiv.createDiv({ attr: { style: 'display: flex; justify-content: space-between; align-items: center;' }});
        embedDiv.createSpan({ text: 'Embed in note:' });
        this.embedCheckbox = embedDiv.createEl('input', { type: 'checkbox' });
        this.embedCheckbox.checked = false;
        const autoEmbedDiv = settingsDiv.createDiv({ attr: { style: 'display: flex; justify-content: space-between; align-items: center;' }});
        autoEmbedDiv.createSpan({ text: 'Auto-embed in active note:' });
        this.autoEmbedCheckbox = autoEmbedDiv.createEl('input', { type: 'checkbox' });
        this.autoEmbedCheckbox.onchange = () => {
            if (this.autoEmbedCheckbox.checked) {
                this.embedCheckbox.checked = true;
                this.plugin.targetNoteWasSelected = false;
                this.embedTargetLabel.setText('The active note at save time');
            } else if (this.embedCheckbox.checked) {
                void this.chooseEmbedTarget();
            }
        };
        this.embedTargetLabel = settingsDiv.createDiv({
            text: 'No note selected',
            attr: { style: 'color: var(--text-muted); font-size: 0.9em;' },
        });
        this.embedCheckbox.onchange = () => {
            if (this.embedCheckbox.checked) {
                if (this.autoEmbedCheckbox.checked) {
                    this.plugin.targetNoteWasSelected = false;
                    this.embedTargetLabel.setText('The active note at save time');
                } else {
                    void this.chooseEmbedTarget();
                }
            } else {
                this.autoEmbedCheckbox.checked = false;
                this.plugin.targetNoteWasSelected = false;
                this.embedTargetLabel.setText('No note selected');
            }
        };
        const sizeDiv = settingsDiv.createDiv({ attr: { style: 'display: flex; gap: 4px; align-items: center;' }});
        sizeDiv.createSpan({ text: 'Embed size:' });
        this.embedWidthInput = sizeDiv.createEl('input', {
            type: 'number',
            placeholder: 'Width',
            attr: { min: '1', style: 'width: 70px;' },
        });
        sizeDiv.createSpan({ text: 'x' });
        this.embedHeightInput = sizeDiv.createEl('input', {
            type: 'number',
            placeholder: 'Height',
            attr: { min: '1', style: 'width: 70px;' },
        });

        // Mute Preview Toggle
        const muteDiv = settingsDiv.createDiv({ attr: { style: 'display: flex; justify-content: space-between; align-items: center;' }});
        muteDiv.createSpan({ text: 'Mute preview (no echo):' });
        this.muteCheckbox = muteDiv.createEl('input', { type: 'checkbox' });
        this.muteCheckbox.checked = true; 

        this.videoElement.muted = this.muteCheckbox.checked;
        this.videoElement.volume = this.muteCheckbox.checked ? 0 : 1;
        this.muteCheckbox.onchange = () => {
            this.videoElement.muted = this.muteCheckbox.checked;
            this.videoElement.volume = this.muteCheckbox.checked ? 0 : 1;
        };

        // Record Controls
        const controlsDiv = container.createDiv({ attr: { style: 'margin-top: 10px; display: flex; flex-direction: column; gap: 5px;' } });
        const topRow = controlsDiv.createDiv({ attr: { style: 'display: flex; gap: 5px;' } });
        this.recordBtn = topRow.createEl('button', { text: 'Record', attr: { disabled: true, style: 'flex: 1;' }});
        this.pauseBtn = topRow.createEl('button', { text: 'Pause', attr: { disabled: true, style: 'flex: 1;' }});
        this.stopBtn = controlsDiv.createEl('button', { text: 'Stop & Save', attr: { disabled: true }});

        this.setupEventListeners();
    }

    private async chooseEmbedTarget() {
        const selectedPath = await new NotePickerModal(this.app).choose();
        if (!selectedPath) {
            this.embedCheckbox.checked = false;
            return;
        }

        this.plugin.targetFilePath = selectedPath;
        this.plugin.targetCursor = null;
        this.plugin.targetNoteWasSelected = true;
        this.embedTargetLabel.setText(`Selected note: ${selectedPath}`);
    }

    private getEmbedDimensions(): string {
        const width = Number.parseInt(this.embedWidthInput.value, 10);
        const height = Number.parseInt(this.embedHeightInput.value, 10);
        if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) {
            return `|${width}x${height}`;
        }
        if (Number.isInteger(width) && width > 0) return `|${width}`;
        return '';
    }

    updateToggleButtonText() {
        if (this.isMediaOn) {
            this.mediaToggleBtn.innerText = 'Turn off';
        } else {
            const source = this.sourceSelect.value;
            if (source === 'camera') this.mediaToggleBtn.innerText = 'Turn on Camera';
            else if (source === 'screen') this.mediaToggleBtn.innerText = 'Preview Screen';
            else if (source === 'audio') this.mediaToggleBtn.innerText = 'Test Mic';
        }
    }

    async initMedia() {
        this.stopMedia(); // Clear existing

        const source = this.sourceSelect.value;
        const quality = this.qualitySelect.value;
        let videoConstraints: MediaTrackConstraints | boolean = {};

        if (quality === 'low') videoConstraints = { width: 640, height: 480 };
        else if (quality === 'normal') videoConstraints = { width: 1280, height: 720 };
        else if (quality === 'high') videoConstraints = { width: 1920, height: 1080 };

        try {
            if (source === 'audio') {
                this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                this.videoElement.setCssStyles({ display: 'none' });
            } else if (source === 'screen') {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
                const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                
                const combinedTracks = [...screenStream.getVideoTracks(), ...micStream.getAudioTracks()];
                this.stream = new MediaStream(combinedTracks);
                
                this.videoElement.setCssStyles({ display: 'block' });
                this.videoElement.srcObject = this.stream;
            } else {
                this.stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: true });
                this.videoElement.setCssStyles({ display: 'block' });
                this.videoElement.srcObject = this.stream;
            }

            this.isMediaOn = true;
            this.updateToggleButtonText();
            this.recordBtn.disabled = false;
            this.pipBtn.disabled = source === 'audio';
            
        } catch (err) {
            new Notice('Media access denied or canceled.');
            console.error('Media initialization error:', err); // FIXED: Utilized the 'err' variable
            this.isMediaOn = false;
            this.updateToggleButtonText();
        }
    }

    stopMedia() {
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        this.videoElement.srcObject = null;
        this.isMediaOn = false;
        this.updateToggleButtonText();
        this.recordBtn.disabled = true;
        this.pipBtn.disabled = true;
        
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
        }
    }

    setupEventListeners() {
        this.mediaToggleBtn.onclick = async () => {
            if (this.isMediaOn) this.stopMedia();
            else await this.initMedia();
        };

        this.pipBtn.onclick = async () => {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else {
                await this.videoElement.requestPictureInPicture();
            }
        };

        this.recordBtn.onclick = () => {
            if (!this.stream) return;
            
            this.recordedChunks = [];
            const source = this.sourceSelect.value;
            const quality = this.qualitySelect.value;
            
            let videoBitsPerSecond = 1000000; 
            if (quality === 'low') videoBitsPerSecond = 250000; 
            if (quality === 'high') videoBitsPerSecond = 2500000; 

            const mimeType = source === 'audio' ? 'audio/webm' : 'video/webm';
            
            this.mediaRecorder = new MediaRecorder(this.stream, {
                mimeType: mimeType,
                videoBitsPerSecond: source === 'audio' ? undefined : videoBitsPerSecond
            });
            
            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) this.recordedChunks.push(event.data);
            };

            this.mediaRecorder.onstop = async () => {
                const blob = new Blob(this.recordedChunks, { type: mimeType });
                await this.saveMediaToVault(blob, source);
            };

            this.mediaRecorder.start();
            this.resetTimer();
            this.startTimer();
            
            this.recordBtn.disabled = true;
            this.sourceSelect.disabled = true;
            this.mediaToggleBtn.disabled = true; 
            this.qualitySelect.disabled = true; 
            this.pauseBtn.disabled = false;
            this.stopBtn.disabled = false;
        };

        this.pauseBtn.onclick = () => {
            if (!this.mediaRecorder) return;
            if (this.mediaRecorder.state === 'recording') {
                this.mediaRecorder.pause();
                this.stopTimer();
                this.pauseBtn.innerText = 'Resume';
            } else if (this.mediaRecorder.state === 'paused') {
                this.mediaRecorder.resume();
                this.startTimer();
                this.pauseBtn.innerText = 'Pause';
            }
        };

        this.stopBtn.onclick = () => {
            if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
                this.mediaRecorder.stop();
            }
            this.stopTimer();
            this.stopMedia();
            
            this.recordBtn.disabled = true;
            this.mediaToggleBtn.disabled = false;
            this.sourceSelect.disabled = false;
            this.qualitySelect.disabled = false;
            this.pauseBtn.disabled = true;
            this.pauseBtn.innerText = 'Pause';
            this.stopBtn.disabled = true;
        };
    }

    updateTimerDisplay() {
        const minutes = Math.floor(this.elapsedSeconds / 60).toString().padStart(2, '0');
        const seconds = (this.elapsedSeconds % 60).toString().padStart(2, '0');
        this.timerDisplay.innerText = `${minutes}:${seconds}`;
    }
    startTimer() {
        if (this.timerInterval !== null) return;
        this.timerInterval = window.setInterval(() => {
            this.elapsedSeconds++;
            this.updateTimerDisplay();
        }, 1000);
    }
    stopTimer() {
        if (this.timerInterval !== null) {
            window.clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }
    resetTimer() {
        this.stopTimer();
        this.elapsedSeconds = 0;
        this.updateTimerDisplay();
    }

    async saveMediaToVault(blob: Blob, source: string) {
        const arrayBuffer = await blob.arrayBuffer();
        const timestamp = window.moment().format('YYYYMMDD-HHmmss');
        
        const prefix = source === 'audio' ? 'Audio' : (source === 'screen' ? 'Screen' : 'Video');
        const filename = `${prefix}-Reflection-${timestamp}.webm`;
        
        const folderPath = normalizePath(this.plugin.settings.saveFolder);
        
        try {
            if (folderPath && folderPath !== "/") {
                const folderExists = this.app.vault.getAbstractFileByPath(folderPath);
                if (!folderExists) {
                    await this.app.vault.createFolder(folderPath);
                }
            }

            const finalPath = (folderPath && folderPath !== "/") ? `${folderPath}/${filename}` : filename;
            await this.app.vault.createBinary(finalPath, arrayBuffer);
            new Notice(`Saved to ${finalPath}!`);

            if (this.embedCheckbox.checked) {
                await this.embedInTargetFile(finalPath);
            }
        } catch (error) {
            new Notice('Failed to save media.');
            console.error(error);
        }
    }

    private async embedInTargetFile(finalPath: string) {
        const targetPath = this.autoEmbedCheckbox.checked
            ? this.plugin.lastActiveMarkdownPath
                ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path
            : this.plugin.targetFilePath;
        if (!targetPath) {
            new Notice('Recording saved, but no Markdown note was open to embed it.');
            return;
        }

        const file = this.app.vault.getAbstractFileByPath(targetPath);
        if (!(file instanceof TFile)) {
            new Notice('Recording saved, but the target note could not be found.');
            return;
        }

        const embedText = `\n![[${finalPath}${this.getEmbedDimensions()}]]\n`;
        const cursor = this.plugin.targetCursor;
        await this.app.vault.process(file, (content) => {
            if (this.plugin.targetNoteWasSelected || this.autoEmbedCheckbox.checked) {
                const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
                return `${content}${separator}${embedText.slice(1)}`;
            }

            if (!cursor) return `${content}${embedText}`;

            const lines = content.split('\n');
            const line = Math.min(cursor.line, lines.length - 1);
            const ch = Math.min(cursor.ch, (lines[line] ?? '').length);
            let offset = 0;
            for (let index = 0; index < line; index++) {
                offset += (lines[index] ?? '').length + 1;
            }
            return `${content.slice(0, offset + ch)}${embedText}${content.slice(offset + ch)}`;
        });
    }

    async onClose() {
        this.stopTimer();
        this.stopMedia();
    }
}

class NotePickerModal extends FuzzySuggestModal<TFile> {
    private resolveSelection!: (path: string | null) => void;

    constructor(app: App) {
        super(app);
        this.setPlaceholder('Choose a note for the recording');
    }

    choose(): Promise<string | null> {
        return new Promise((resolve) => {
            this.resolveSelection = resolve;
            this.open();
        });
    }

    getItems(): TFile[] {
        return this.app.vault.getMarkdownFiles();
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChooseItem(file: TFile): void {
        this.resolveSelection(file.path);
    }
}

// --- The Settings Tab ---
class VideoJournalSettingTab extends PluginSettingTab {
    plugin: VideoJournalPlugin;

    constructor(app: App, plugin: VideoJournalPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();
        
        new Setting(containerEl).setName('Video Journal').setHeading();

        new Setting(containerEl)
            .setName('Save Folder')
            .setDesc('Folder where your recordings will be saved.')
            .addText(text => text
                .setPlaceholder('Enter folder path')
                .setValue(this.plugin.settings.saveFolder)
                .onChange(async (value) => {
                    this.plugin.settings.saveFolder = value;
                    await this.plugin.saveSettings();
                }));

        // --- NEW FEEDBACK SECTION ---
        new Setting(containerEl).setName('Support').setHeading();

        new Setting(containerEl)
            .setName('Feedback & Bug Reports')
            .setDesc('Found a bug or have a feature request? Let us know on GitHub!')
            .addButton(button => button
                .setButtonText('Open GitHub Issues')
                .setCta() // Makes the button stand out visually
                .onClick(() => {
                    // Replace 'YourUsername' with your actual GitHub username or FlyNetX organization name
                    window.open('https://github.com/Alaxanalax10/obsidian-media-journal/issues');
                }));
    }

    // FIXED: Added getSettingDefinitions to clear the declarative settings warning
    getSettingDefinitions() {
        return [];
    }
}