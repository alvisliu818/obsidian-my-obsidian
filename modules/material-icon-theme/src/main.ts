import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  getLanguage,
  type SettingDefinitionItem,
} from 'obsidian';
import {
  iconRegistry,
  fileExtensionKeys,
  fileNameKeys,
  folderNameKeys,
  folderNameOpenKeys,
  defaultFileIconKey,
  folderIconKey,
  folderOpenIconKey,
  type IconSet,
} from './icon-data';

// ── Constants ────────────────────────────────────────────────────────────────

const APPLIED_ATTR = 'data-mfi-applied';
const OBSERVED_ATTR = 'data-mfi-obs';
const ICON_CLASS = 'mfi-icon';
const FOLDER_ICON_CLASS = 'mfi-folder-icon';

// Upper bound for the refresh debounce. Vault indexing fires `create` once per
// existing file on startup, which would otherwise defer every pending refresh
// until indexing finishes.
const MAX_REFRESH_WAIT = 200;

// The file tree is rendered lazily, well after the plugin loads. Re-sync a few
// times so icons land regardless of how long the tree takes to appear.
const BOOT_RETRY_DELAYS = [0, 200, 600, 1500, 3000, 6000];

function ownValue<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// ── SVG helpers ───────────────────────────────────────────────────────────────

let svgInstanceId = 0;

/**
 * Icon SVGs ship with the plugin and are never user input, but they still get
 * parsed rather than assigned through innerHTML — raw HTML assignment is called
 * out in Obsidian's plugin guidelines.
 */
function parseSvgIcon(svg: string, doc: Document): SVGElement | null {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) return null;

  const root = parsed.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg') return null;

  const node = doc.importNode(root, true) as unknown as SVGElement;
  const identified: Element[] = Array.from(node.querySelectorAll('[id]'));
  if (node.hasAttribute('id')) identified.unshift(node);
  if (identified.length === 0) return node;

  const prefix = `mfi-svg-${++svgInstanceId}-`;
  const ids = new Map<string, string>();
  for (const element of identified) {
    const original = element.getAttribute('id');
    if (!original) continue;
    const renamed = prefix + original;
    ids.set(original, renamed);
    element.setAttribute('id', renamed);
  }

  for (const element of [node, ...Array.from(node.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      let value = attribute.value;
      if (attribute.localName === 'href' && value.startsWith('#')) {
        const renamed = ids.get(value.slice(1));
        if (renamed) value = `#${renamed}`;
      }
      value = value.replace(
        /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g,
        (match: string, _quote: string, id: string) => {
          const renamed = ids.get(id);
          return renamed ? `url(#${renamed})` : match;
        },
      );
      if (value !== attribute.value) {
        element.setAttributeNS(attribute.namespaceURI, attribute.name, value);
      }
    }
  }
  return node;
}

/** Replace an element's contents with a sized copy of the given icon. */
function renderIconInto(target: HTMLElement, svg: string, size: number) {
  target.empty();
  const node = parseSvgIcon(svg, target.ownerDocument);
  if (!node) return;
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  target.appendChild(node);
}

// ── i18n ──────────────────────────────────────────────────────────────────────

type Lang = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'de' | 'fr' | 'es' | 'ru' | 'pt';

/** What the user picked. `auto` defers to Obsidian's own interface language. */
type LanguageSetting = Lang | 'auto';

/**
 * getLanguage() returns Obsidian's configured interface language as an ISO code
 * — `zh`, `zh-TW`, `pt-BR` and so on. Map those onto the languages this plugin
 * ships; anything unrecognised falls back to English rather than to whichever
 * locale the author happened to develop in.
 */
function detectObsidianLanguage(): Lang {
  const raw = getLanguage().toLowerCase();
  if (!raw) return 'en';

  const aliases: Record<string, Lang> = {
    'zh': 'zh-CN',
    'zh-cn': 'zh-CN',
    'zh-tw': 'zh-TW',
    'zh-hant': 'zh-TW',
    'pt-br': 'pt',
  };
  if (raw in aliases) return aliases[raw];

  const base = raw.split('-')[0];
  const supported: Lang[] = ['en', 'ja', 'ko', 'de', 'fr', 'es', 'ru', 'pt'];
  return supported.find(code => code === base) ?? 'en';
}

const LANG_NAMES: Record<Lang, string> = {
  'en': 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文',
  'ja': '日本語', 'ko': '한국어', 'de': 'Deutsch',
  'fr': 'Français', 'es': 'Español', 'ru': 'Русский', 'pt': 'Português',
};

interface Strings {
  language: string; languageDesc: string; languageAuto: string;
  applyFiles: string; applyFilesDesc: string;
  applyFolders: string; applyFoldersDesc: string;
  customRules: string; customRulesDesc: string;
  noRules: string; addRuleBtn: string; rulesHeading: string; extExists: string;
  edit: string; delete: string;
  pickIcon: string; searchPlaceholder: string;
  addRule: string; editRule: string;
  extLabel: string; extDesc: string;
  iconLabel: string; iconDesc: string;
  notSelected: string; selectIcon: string;
  cancel: string; save: string; confirm: string;
  enterExt: string; selectIconNotice: string;
}

const STRINGS: Record<Lang, Strings> = {
  'en': {
    language: 'Language', languageDesc: 'Interface language', languageAuto: 'Follow Obsidian',
    applyFiles: 'Apply file icons', applyFilesDesc: 'Show Material icons for files by extension, use theme icons when disabled',
    applyFolders: 'Apply folder icons', applyFoldersDesc: 'Show Material icons for folders, use theme icons when disabled',
    customRules: 'Custom rules', customRulesDesc: 'When enabled, custom rules take priority over default icon matching',
    noRules: 'No rules yet', addRuleBtn: 'Add rule', rulesHeading: 'Rules', extExists: 'Rule for .{ext} already exists',
    edit: 'Edit', delete: 'Delete',
    pickIcon: 'Select Icon', searchPlaceholder: 'Search icon name...',
    addRule: 'Add Custom Rule', editRule: 'Edit Rule',
    extLabel: 'File Extension', extDesc: 'Without dot, e.g.: vue, rs, myext',
    iconLabel: 'Icon', iconDesc: 'Select from Material Icon Theme library',
    notSelected: 'Not selected', selectIcon: 'Select icon…',
    cancel: 'Cancel', save: 'Save', confirm: 'Confirm',
    enterExt: 'Please enter file extension', selectIconNotice: 'Please select an icon',
  },
  'zh-CN': {
    language: '语言', languageDesc: '界面语言', languageAuto: '跟随 Obsidian',
    applyFiles: '应用文件图标', applyFilesDesc: '根据扩展名为文件显示 Material 图标，关闭后使用主题自带图标',
    applyFolders: '应用文件夹图标', applyFoldersDesc: '为文件夹显示 Material 图标，关闭后使用主题自带图标',
    customRules: '自定义规则', customRulesDesc: '开启后，自定义规则优先于默认图标匹配',
    noRules: '暂无规则', addRuleBtn: '添加规则', rulesHeading: '规则', extExists: '后缀 .{ext} 的规则已存在',
    edit: '编辑', delete: '删除',
    pickIcon: '选择图标', searchPlaceholder: '搜索图标名称...',
    addRule: '添加自定义规则', editRule: '编辑规则',
    extLabel: '文件后缀', extDesc: '不含点号，例如：vue、rs、myext',
    iconLabel: '图标', iconDesc: '从 Material Icon Theme 图标库中选择',
    notSelected: '未选择', selectIcon: '选择图标…',
    cancel: '取消', save: '保存', confirm: '确认',
    enterExt: '请输入文件后缀', selectIconNotice: '请选择图标',
  },
  'zh-TW': {
    language: '語言', languageDesc: '介面語言', languageAuto: '跟隨 Obsidian',
    applyFiles: '套用檔案圖示', applyFilesDesc: '根據副檔名為檔案顯示 Material 圖示，關閉後使用佈景主題圖示',
    applyFolders: '套用資料夾圖示', applyFoldersDesc: '為資料夾顯示 Material 圖示，關閉後使用佈景主題圖示',
    customRules: '自訂規則', customRulesDesc: '啟用後，自訂規則優先於預設圖示匹配',
    noRules: '尚無規則', addRuleBtn: '新增規則', rulesHeading: '規則', extExists: '副檔名 .{ext} 的規則已存在',
    edit: '編輯', delete: '刪除',
    pickIcon: '選擇圖示', searchPlaceholder: '搜尋圖示名稱...',
    addRule: '新增自訂規則', editRule: '編輯規則',
    extLabel: '副檔名', extDesc: '不含點號，例如：vue、rs、myext',
    iconLabel: '圖示', iconDesc: '從 Material Icon Theme 圖示庫中選擇',
    notSelected: '未選擇', selectIcon: '選擇圖示…',
    cancel: '取消', save: '儲存', confirm: '確認',
    enterExt: '請輸入副檔名', selectIconNotice: '請選擇圖示',
  },
  'ja': {
    language: '言語', languageDesc: 'インターフェース言語', languageAuto: 'Obsidian に従う',
    applyFiles: 'ファイルアイコンを適用', applyFilesDesc: '拡張子に基づきファイルに Material アイコンを表示、無効時はテーマアイコンを使用',
    applyFolders: 'フォルダーアイコンを適用', applyFoldersDesc: 'フォルダーに Material アイコンを表示、無効時はテーマアイコンを使用',
    customRules: 'カスタムルール', customRulesDesc: '有効にすると、カスタムルールがデフォルトより優先されます',
    noRules: 'ルールがありません', addRuleBtn: 'ルールを追加', rulesHeading: 'ルール', extExists: '.{ext} のルールはすでに存在します',
    edit: '編集', delete: '削除',
    pickIcon: 'アイコンを選択', searchPlaceholder: 'アイコン名を検索...',
    addRule: 'カスタムルールを追加', editRule: 'ルールを編集',
    extLabel: 'ファイル拡張子', extDesc: 'ドットなし、例：vue、rs、myext',
    iconLabel: 'アイコン', iconDesc: 'Material Icon Theme ライブラリから選択',
    notSelected: '未選択', selectIcon: 'アイコンを選択…',
    cancel: 'キャンセル', save: '保存', confirm: '確定',
    enterExt: 'ファイル拡張子を入力してください', selectIconNotice: 'アイコンを選択してください',
  },
  'ko': {
    language: '언어', languageDesc: '인터페이스 언어', languageAuto: 'Obsidian 따르기',
    applyFiles: '파일 아이콘 적용', applyFilesDesc: '확장자에 따라 파일에 Material 아이콘 표시, 비활성화 시 테마 아이콘 사용',
    applyFolders: '폴더 아이콘 적용', applyFoldersDesc: '폴더에 Material 아이콘 표시, 비활성화 시 테마 아이콘 사용',
    customRules: '사용자 정의 규칙', customRulesDesc: '활성화 시 사용자 정의 규칙이 기본 아이콘 매칭보다 우선됩니다',
    noRules: '규칙이 없습니다', addRuleBtn: '규칙 추가', rulesHeading: '규칙', extExists: '.{ext} 규칙이 이미 존재합니다',
    edit: '편집', delete: '삭제',
    pickIcon: '아이콘 선택', searchPlaceholder: '아이콘 이름 검색...',
    addRule: '사용자 정의 규칙 추가', editRule: '규칙 편집',
    extLabel: '파일 확장자', extDesc: '점 없이 입력, 예: vue, rs, myext',
    iconLabel: '아이콘', iconDesc: 'Material Icon Theme 라이브러리에서 선택',
    notSelected: '선택 안 됨', selectIcon: '아이콘 선택…',
    cancel: '취소', save: '저장', confirm: '확인',
    enterExt: '파일 확장자를 입력하세요', selectIconNotice: '아이콘을 선택하세요',
  },
  'de': {
    language: 'Sprache', languageDesc: 'Benutzeroberflächen-Sprache', languageAuto: 'Obsidian folgen',
    applyFiles: 'Datei-Symbole anwenden', applyFilesDesc: 'Material-Symbole für Dateien nach Endung anzeigen, bei Deaktivierung Theme-Symbole verwenden',
    applyFolders: 'Ordner-Symbole anwenden', applyFoldersDesc: 'Material-Symbole für Ordner anzeigen, bei Deaktivierung Theme-Symbole verwenden',
    customRules: 'Benutzerdefinierte Regeln', customRulesDesc: 'Bei Aktivierung haben benutzerdefinierte Regeln Vorrang vor Standard-Zuordnungen',
    noRules: 'Noch keine Regeln', addRuleBtn: 'Regel hinzufügen', rulesHeading: 'Regeln', extExists: 'Regel für .{ext} existiert bereits',
    edit: 'Bearbeiten', delete: 'Löschen',
    pickIcon: 'Symbol auswählen', searchPlaceholder: 'Symbolname suchen...',
    addRule: 'Benutzerdefinierte Regel hinzufügen', editRule: 'Regel bearbeiten',
    extLabel: 'Dateiendung', extDesc: 'Ohne Punkt, z.B.: vue, rs, myext',
    iconLabel: 'Symbol', iconDesc: 'Aus der Material Icon Theme Bibliothek wählen',
    notSelected: 'Nicht ausgewählt', selectIcon: 'Symbol wählen…',
    cancel: 'Abbrechen', save: 'Speichern', confirm: 'Bestätigen',
    enterExt: 'Bitte Dateiendung eingeben', selectIconNotice: 'Bitte ein Symbol auswählen',
  },
  'fr': {
    language: 'Langue', languageDesc: "Langue de l'interface", languageAuto: 'Suivre Obsidian',
    applyFiles: 'Appliquer les icônes de fichiers', applyFilesDesc: "Afficher les icônes Material pour les fichiers selon l'extension, utiliser les icônes du thème si désactivé",
    applyFolders: 'Appliquer les icônes de dossiers', applyFoldersDesc: 'Afficher les icônes Material pour les dossiers, utiliser les icônes du thème si désactivé',
    customRules: 'Règles personnalisées', customRulesDesc: "Si activé, les règles personnalisées ont la priorité sur la correspondance d'icônes par défaut",
    noRules: 'Aucune règle', addRuleBtn: 'Ajouter une règle', rulesHeading: 'Règles', extExists: 'Une règle pour .{ext} existe déjà',
    edit: 'Modifier', delete: 'Supprimer',
    pickIcon: 'Sélectionner une icône', searchPlaceholder: 'Rechercher une icône...',
    addRule: 'Ajouter une règle personnalisée', editRule: 'Modifier la règle',
    extLabel: 'Extension de fichier', extDesc: 'Sans point, ex. : vue, rs, myext',
    iconLabel: 'Icône', iconDesc: 'Sélectionner depuis la bibliothèque Material Icon Theme',
    notSelected: 'Non sélectionné', selectIcon: 'Choisir une icône…',
    cancel: 'Annuler', save: 'Enregistrer', confirm: 'Confirmer',
    enterExt: "Veuillez saisir l'extension de fichier", selectIconNotice: 'Veuillez sélectionner une icône',
  },
  'es': {
    language: 'Idioma', languageDesc: 'Idioma de la interfaz', languageAuto: 'Seguir a Obsidian',
    applyFiles: 'Aplicar iconos de archivos', applyFilesDesc: 'Mostrar iconos Material para archivos según extensión, usar iconos del tema si está desactivado',
    applyFolders: 'Aplicar iconos de carpetas', applyFoldersDesc: 'Mostrar iconos Material para carpetas, usar iconos del tema si está desactivado',
    customRules: 'Reglas personalizadas', customRulesDesc: 'Si está activado, las reglas personalizadas tienen prioridad sobre la asignación predeterminada',
    noRules: 'Sin reglas', addRuleBtn: 'Añadir regla', rulesHeading: 'Reglas', extExists: 'Ya existe una regla para .{ext}',
    edit: 'Editar', delete: 'Eliminar',
    pickIcon: 'Seleccionar icono', searchPlaceholder: 'Buscar nombre de icono...',
    addRule: 'Añadir regla personalizada', editRule: 'Editar regla',
    extLabel: 'Extensión de archivo', extDesc: 'Sin punto, ej.: vue, rs, myext',
    iconLabel: 'Icono', iconDesc: 'Seleccionar de la biblioteca Material Icon Theme',
    notSelected: 'No seleccionado', selectIcon: 'Seleccionar icono…',
    cancel: 'Cancelar', save: 'Guardar', confirm: 'Confirmar',
    enterExt: 'Por favor ingrese la extensión de archivo', selectIconNotice: 'Por favor seleccione un icono',
  },
  'ru': {
    language: 'Язык', languageDesc: 'Язык интерфейса', languageAuto: 'Как в Obsidian',
    applyFiles: 'Применить иконки файлов', applyFilesDesc: 'Показывать Material-иконки для файлов по расширению, при отключении использовать иконки темы',
    applyFolders: 'Применить иконки папок', applyFoldersDesc: 'Показывать Material-иконки для папок, при отключении использовать иконки темы',
    customRules: 'Пользовательские правила', customRulesDesc: 'При включении пользовательские правила имеют приоритет над стандартным сопоставлением',
    noRules: 'Правил нет', addRuleBtn: 'Добавить правило', rulesHeading: 'Правила', extExists: 'Правило для .{ext} уже существует',
    edit: 'Изменить', delete: 'Удалить',
    pickIcon: 'Выбрать иконку', searchPlaceholder: 'Поиск иконки...',
    addRule: 'Добавить правило', editRule: 'Редактировать правило',
    extLabel: 'Расширение файла', extDesc: 'Без точки, например: vue, rs, myext',
    iconLabel: 'Иконка', iconDesc: 'Выбрать из библиотеки Material Icon Theme',
    notSelected: 'Не выбрано', selectIcon: 'Выбрать иконку…',
    cancel: 'Отмена', save: 'Сохранить', confirm: 'Подтвердить',
    enterExt: 'Пожалуйста, введите расширение файла', selectIconNotice: 'Пожалуйста, выберите иконку',
  },
  'pt': {
    language: 'Idioma', languageDesc: 'Idioma da interface', languageAuto: 'Seguir o Obsidian',
    applyFiles: 'Aplicar ícones de arquivos', applyFilesDesc: 'Mostrar ícones Material para arquivos por extensão, usar ícones do tema se desativado',
    applyFolders: 'Aplicar ícones de pastas', applyFoldersDesc: 'Mostrar ícones Material para pastas, usar ícones do tema se desativado',
    customRules: 'Regras personalizadas', customRulesDesc: 'Se ativado, regras personalizadas têm prioridade sobre a correspondência padrão',
    noRules: 'Sem regras', addRuleBtn: 'Adicionar regra', rulesHeading: 'Regras', extExists: 'Regra para .{ext} já existe',
    edit: 'Editar', delete: 'Excluir',
    pickIcon: 'Selecionar ícone', searchPlaceholder: 'Pesquisar nome do ícone...',
    addRule: 'Adicionar regra personalizada', editRule: 'Editar regra',
    extLabel: 'Extensão de arquivo', extDesc: 'Sem ponto, ex.: vue, rs, myext',
    iconLabel: 'Ícone', iconDesc: 'Selecionar da biblioteca Material Icon Theme',
    notSelected: 'Não selecionado', selectIcon: 'Selecionar ícone…',
    cancel: 'Cancelar', save: 'Salvar', confirm: 'Confirmar',
    enterExt: 'Por favor insira a extensão do arquivo', selectIconNotice: 'Por favor selecione um ícone',
  },
};

// ── Settings types ────────────────────────────────────────────────────────────

interface CustomRule {
  extension: string; // without leading dot, lowercase
  iconKey: string;   // key in iconRegistry
}

interface MfiSettings {
  applyToFiles: boolean;
  applyToFolders: boolean;
  enableCustomRules: boolean;
  customRules: CustomRule[];
  language: LanguageSetting;
}

const DEFAULT_SETTINGS: MfiSettings = {
  applyToFiles: true,
  applyToFolders: true,
  enableCustomRules: false,
  customRules: [],
  language: 'auto',
};

/**
 * Rule edits are triggered from synchronous UI callbacks that expect no return
 * value, so the work runs detached. Catch here rather than handing a floating
 * promise to a `void` parameter, where a failed save would vanish silently.
 */
function applySettingsChange(action: string, work: () => Promise<void>) {
  work().catch((err: unknown) => {
    console.error(`[material-icon] failed to ${action}`, err);
  });
}

// ── Icon picker modal ─────────────────────────────────────────────────────────

class IconPickerModal extends Modal {
  private isDark: boolean;
  private currentKey: string;
  private t: Strings;
  private onSelect: (key: string) => void;

  constructor(app: App, isDark: boolean, currentKey: string, t: Strings, onSelect: (key: string) => void) {
    super(app);
    this.isDark = isDark;
    this.currentKey = currentKey;
    this.t = t;
    this.onSelect = onSelect;
  }

  onOpen() {
    const { contentEl, t } = this;
    contentEl.addClass('mfi-picker-modal');
    this.titleEl.setText(t.pickIcon);

    const searchInput = contentEl.createEl('input', { cls: 'mfi-picker-search' });
    searchInput.type = 'text';
    searchInput.placeholder = t.searchPlaceholder;

    const grid = contentEl.createDiv({ cls: 'mfi-picker-grid' });
    const allKeys = Object.keys(iconRegistry).sort();

    const render = (q: string) => {
      grid.empty();
      const keys = q ? allKeys.filter(k => k.includes(q)) : allKeys;
      for (const key of keys) {
        const set = iconRegistry[key];
        const svg = this.isDark ? set.dark : set.light;

        const item = grid.createEl('button', {
          cls: 'mfi-picker-item',
          attr: {
            type: 'button',
            'aria-label': key,
            'aria-pressed': String(key === this.currentKey),
          },
        });
        if (key === this.currentKey) item.addClass('is-active');

        const svgWrap = item.createSpan({ cls: 'mfi-picker-svg' });
        renderIconInto(svgWrap, svg, 24);

        item.createSpan({ text: key, cls: 'mfi-picker-name' });

        item.addEventListener('click', () => {
          this.currentKey = key;
          this.onSelect(key);
          this.close();
        });
      }
    };

    render('');
    searchInput.addEventListener('input', () => render(searchInput.value.toLowerCase().trim()));
    window.setTimeout(() => searchInput.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ── Add rule modal ────────────────────────────────────────────────────────────

class AddRuleModal extends Modal {
  private plugin: MaterialFileIconsPlugin;
  private extension = '';
  private selectedKey = '';
  private previewEl: HTMLElement | null = null;
  private selectedLabelEl: HTMLElement | null = null;
  private onSubmit: (rule: CustomRule) => void;
  private isEditing: boolean;

  constructor(
    app: App,
    plugin: MaterialFileIconsPlugin,
    onSubmit: (rule: CustomRule) => void,
    existing?: CustomRule,
  ) {
    super(app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
    this.isEditing = !!existing;
    if (existing) {
      this.extension = existing.extension;
      this.selectedKey = existing.iconKey;
    }
  }

  onOpen() {
    const { contentEl } = this;
    const t = this.plugin.t;
    this.titleEl.setText(this.isEditing ? t.editRule : t.addRule);

    new Setting(contentEl)
      .setName(t.extLabel)
      .setDesc(t.extDesc)
      .addText(text => {
        text
          .setPlaceholder('Vue')
          .setValue(this.extension)
          .onChange(v => {
            this.extension = v.trim().replace(/^\.+/, '').toLowerCase();
          });
        if (this.isEditing) text.setDisabled(true);
      });

    const iconSetting = new Setting(contentEl)
      .setName(t.iconLabel)
      .setDesc(t.iconDesc);

    const previewRow = iconSetting.controlEl.createDiv({ cls: 'mfi-add-rule-preview' });
    this.previewEl = previewRow.createSpan({ cls: 'mfi-add-rule-icon' });
    this.selectedLabelEl = previewRow.createSpan({ cls: 'mfi-add-rule-key', text: t.notSelected });

    if (this.isEditing) this.refreshPreview();

    iconSetting.addButton(btn =>
      btn.setButtonText(t.selectIcon).onClick(() => {
        new IconPickerModal(this.app, this.plugin.isDark, this.selectedKey, t, key => {
          this.selectedKey = key;
          this.refreshPreview();
        }).open();
      })
    );

    new Setting(contentEl)
      .addButton(btn => btn.setButtonText(t.cancel).onClick(() => this.close()))
      .addButton(btn =>
        btn
          .setButtonText(this.isEditing ? t.save : t.confirm)
          .setCta()
          .onClick(() => {
            if (!this.extension) { new Notice(t.enterExt); return; }
            if (!this.selectedKey) { new Notice(t.selectIconNotice); return; }
            this.onSubmit({ extension: this.extension, iconKey: this.selectedKey });
            this.close();
          })
      );
  }

  private refreshPreview() {
    if (!this.previewEl || !this.selectedLabelEl) return;
    const set = iconRegistry[this.selectedKey];
    if (!set) return;
    const svg = this.plugin.isDark ? set.dark : set.light;
    renderIconInto(this.previewEl, svg, 20);
    this.selectedLabelEl.textContent = this.selectedKey;
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ── Settings tab ──────────────────────────────────────────────────────────────

class MfiSettingTab extends PluginSettingTab {
  plugin: MaterialFileIconsPlugin;

  constructor(app: App, plugin: MaterialFileIconsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // ── Declarative settings (Obsidian 1.13.0+) ─────────────────────────────────

  getSettingDefinitions(): SettingDefinitionItem[] {
    const t = this.plugin.t;

    return [
      {
        name: t.language,
        desc: t.languageDesc,
        control: {
          type: 'dropdown',
          key: 'language',
          options: { auto: t.languageAuto, ...LANG_NAMES },
        },
      },
      {
        name: t.applyFiles,
        desc: t.applyFilesDesc,
        control: { type: 'toggle', key: 'applyToFiles' },
      },
      {
        name: t.applyFolders,
        desc: t.applyFoldersDesc,
        control: { type: 'toggle', key: 'applyToFolders' },
      },
      {
        name: t.customRules,
        desc: t.customRulesDesc,
        control: { type: 'toggle', key: 'enableCustomRules' },
      },
      {
        type: 'list',
        heading: t.rulesHeading,
        visible: () => this.plugin.settings.enableCustomRules,
        emptyState: t.noRules,
        onDelete: index => this.deleteRule(index),
        addItem: { name: t.addRuleBtn, action: () => this.openRuleModal() },
        items: this.plugin.settings.customRules.map((rule, idx) => ({
          name: `.${rule.extension}`,
          desc: rule.iconKey,
          render: (setting: Setting) => {
            const preview = setting.controlEl.createSpan({ cls: 'mfi-rule-icon' });
            const set = iconRegistry[rule.iconKey];
            if (set) renderIconInto(preview, this.plugin.isDark ? set.dark : set.light, 18);

            setting.addButton(btn =>
              btn.setButtonText(t.edit).onClick(() => this.openRuleModal(idx))
            );
          },
        })),
      },
    ];
  }

  /**
   * The framework persists the value before calling back, so this only has to
   * propagate the side effects each key implies.
   */
  async setControlValue(key: string, value: unknown): Promise<void> {
    await super.setControlValue(key, value);

    // Every label comes from the language table, so the definitions have to be
    // rebuilt rather than merely re-evaluated.
    if (key === 'language') {
      this.reopenTab();
      return;
    }

    // Toggling custom rules shows or hides the list, which `visible` covers.
    if (key === 'enableCustomRules') this.refreshDomState();

    this.plugin.resetAndRefresh();
  }

  // ── Rule operations, shared by both rendering paths ─────────────────────────

  /** Open the add/edit modal. Passing an index edits that rule instead. */
  private openRuleModal(index?: number) {
    const t = this.plugin.t;
    const editing = index !== undefined ? this.plugin.settings.customRules[index] : undefined;

    new AddRuleModal(
      this.app,
      this.plugin,
      submitted => {
        const rules = this.plugin.settings.customRules;

        if (index === undefined && rules.some(r => r.extension === submitted.extension)) {
          new Notice(t.extExists.replace('{ext}', submitted.extension));
          return;
        }

        applySettingsChange(index === undefined ? 'add rule' : 'update rule', async () => {
          if (index === undefined) rules.push(submitted);
          else rules[index] = submitted;

          await this.plugin.saveSettings();
          this.rerender();
          this.plugin.resetAndRefresh();
        });
      },
      editing
    ).open();
  }

  private deleteRule(index: number) {
    applySettingsChange('delete rule', async () => {
      this.plugin.settings.customRules.splice(index, 1);
      await this.plugin.saveSettings();
      this.rerender();
      this.plugin.resetAndRefresh();
    });
  }

  /** Adding or removing a rule changes the shape of the definitions. */
  private rerender() {
    this.update();
  }

  /**
   * update() alone is not enough after a language change: the framework re-syncs
   * the control the user just interacted with once this callback returns, which
   * leaves that single row rendered in the previous language. Reopening the tab
   * forces a full render instead.
   */
  private reopenTab() {
    this.update();

    interface SettingModal {
      activeTab?: unknown;
      openTabById?: (id: string) => void;
    }
    const modal = (this.app as unknown as { setting?: SettingModal }).setting;
    if (modal?.activeTab === this) modal.openTabById?.(this.plugin.manifest.id);
  }

}

// ── Main plugin ───────────────────────────────────────────────────────────────

export default class MaterialFileIconsPlugin extends Plugin {
  settings: MfiSettings = { ...DEFAULT_SETTINGS };

  get t(): Strings { return STRINGS[this.activeLanguage]; }

  /**
   * The language actually in use. `auto` — and any value left over from an older
   * build that no longer exists — resolves against Obsidian's own setting.
   */
  get activeLanguage(): Lang {
    const picked = this.settings.language;
    if (picked !== 'auto' && picked in STRINGS) return picked;
    return detectObsidianLanguage();
  }

  private containers = new Map<HTMLElement, MutationObserver>();
  private folderObservers = new Map<HTMLElement, MutationObserver>();
  private refreshTimer: number | null = null;
  private refreshDeadline: number | null = null;
  private bootTimers: number[] = [];
  isDark = false;

  async onload() {
    await this.loadSettings();
    this.isDark = this.app.isDarkMode();
    this.registerEvent(this.app.workspace.on('css-change', () => {
      const nextIsDark = this.app.isDarkMode();
      if (nextIsDark === this.isDark) return;
      this.isDark = nextIsDark;
      this.resetAndRefresh();
    }));
    this.addSettingTab(new MfiSettingTab(this.app, this));

    this.registerEvent(this.app.workspace.on('layout-change', () => this.syncLeaves()));

    this.app.workspace.onLayoutReady(() => {
      this.syncLeaves();

      // Registering vault events here rather than in onload() skips the burst of
      // `create` events Obsidian emits for every pre-existing file while indexing.
      this.registerEvent(this.app.vault.on('create', () => this.scheduleRefresh(50)));
      this.registerEvent(this.app.vault.on('rename', () => this.scheduleRefresh(50)));

      for (const delay of BOOT_RETRY_DELAYS) {
        this.bootTimers.push(window.setTimeout(() => this.syncLeaves(), delay));
      }
    });
    this.register(() => {
      this.bootTimers.forEach(id => window.clearTimeout(id));
      this.bootTimers = [];
    });

  }

  onunload() {
    // Order matters: resetAllIcons() walks the container map, so it has to run
    // before disconnectContainers() empties it.
    this.resetAllIcons();
    this.disconnectContainers();

    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshDeadline = null;
  }

  // ── Leaf management ─────────────────────────────────────────────────────────

  /** Reconcile observers against every file explorer currently in the workspace. */
  private syncLeaves() {
    const live = new Set<HTMLElement>();

    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      if (leaf.getViewState().type !== 'file-explorer') return;
      const container = leaf.view.containerEl.querySelector<HTMLElement>(
        ':scope .nav-files-container > div'
      );
      if (container) live.add(container);
    });

    for (const [el, obs] of this.containers) {
      if (live.has(el) && el.isConnected) continue;
      obs.disconnect();
      this.containers.delete(el);
    }

    for (const el of live) {
      if (this.containers.has(el)) continue;
      this.containers.set(el, this.observeContainer(el));
    }

    this.refreshIcons();
  }

  private observeContainer(container: HTMLElement): MutationObserver {
    const obs = new MutationObserver(mutations => {
      let needsRefresh = false;
      let shouldPruneFolderObservers = false;

      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'data-path') {
          // Obsidian recycles rows by rewriting data-path. Reuse the fixed-width
          // icon host so the row never collapses while its SVG is replaced.
          if (
            !m.target.instanceOf(HTMLElement) ||
            !this.refreshRecycledRow(m.target)
          ) {
            needsRefresh = true;
          }
          continue;
        }
        if (m.type === 'childList') {
          if (
            Array.from(m.removedNodes).some(
              node =>
                node.instanceOf(HTMLElement) &&
                (node.classList.contains('tree-item') || Boolean(node.querySelector('.tree-item')))
            )
          ) {
            shouldPruneFolderObservers = true;
          }
          for (const node of Array.from(m.addedNodes)) {
            const processed = this.processAddedNode(node);
            if (processed === false) needsRefresh = true;
          }
        }
      }

      if (shouldPruneFolderObservers) this.pruneFolderObservers();
      if (needsRefresh) this.scheduleRefresh(0);
    });

    obs.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-path'],
    });

    return obs;
  }

  /** Process attached tree rows before the browser paints them. */
  private processAddedNode(node: Node): boolean | null {
    if (!node.instanceOf(HTMLElement)) return null;

    let found = false;
    let ready = true;
    if (node.classList.contains('tree-item')) {
      return this.processItem(node);
    }

    node.querySelectorAll<HTMLElement>('.tree-item').forEach(item => {
      const ancestorItem = item.parentElement?.closest('.tree-item');
      if (ancestorItem && node.contains(ancestorItem)) return;
      found = true;
      ready = this.processItem(item) && ready;
    });

    return found ? ready : null;
  }

  /** Drop folder observers whose element Obsidian has already detached. */
  private pruneFolderObservers() {
    for (const [el, obs] of this.folderObservers) {
      if (el.isConnected) continue;
      obs.disconnect();
      el.removeAttribute(OBSERVED_ATTR);
      this.folderObservers.delete(el);
    }
  }

  private disconnectContainers() {
    this.containers.forEach(obs => obs.disconnect());
    this.containers.clear();
    // Disconnecting folder observers must also clear their DOM markers, or
    // processItem() sees them as already observed and never re-registers.
    this.folderObservers.forEach((obs, el) => {
      obs.disconnect();
      el.removeAttribute(OBSERVED_ATTR);
    });
    this.folderObservers.clear();
  }

  // ── Refresh scheduling ──────────────────────────────────────────────────────

  private scheduleRefresh(delayMs = 0) {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);

    // Plain debouncing lets a steady stream of events (vault indexing, virtual
    // scrolling) postpone the refresh indefinitely. Cap how long it can slip.
    if (this.refreshDeadline === null) this.refreshDeadline = Date.now() + MAX_REFRESH_WAIT;
    const wait = Math.max(0, Math.min(delayMs, this.refreshDeadline - Date.now()));

    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refreshDeadline = null;
      this.refreshIcons();
    }, wait);
  }

  // ── Icon rendering ──────────────────────────────────────────────────────────

  private refreshIcons() {
    // Virtual scrolling detaches rows constantly, so reclaim their observers on
    // every sweep rather than only when leaves change.
    this.pruneFolderObservers();

    for (const container of this.containers.keys()) {
      container
        .querySelectorAll<HTMLElement>(':scope > .tree-item')
        .forEach(item => this.processItem(item));
    }
  }

  private processItem(itemEl: HTMLElement): boolean {
    const isFolder = itemEl.classList.contains('nav-folder');
    const titleEl = itemEl.querySelector<HTMLElement>(':scope > .tree-item-self');
    if (!titleEl) return false;

    if (isFolder || !titleEl.hasAttribute(APPLIED_ATTR)) {
      // One unhappy row must not abort the whole sweep — the remaining siblings
      // would silently keep their theme icons until something else triggers a refresh.
      try {
        if (isFolder) {
          this.injectFolderIcon(titleEl, itemEl.classList.contains('is-collapsed'));
        } else {
          const path = titleEl.dataset.path ?? '';
          // No path yet means the row is still being built; retry on the next pass
          // rather than locking it to the fallback icon.
          if (path) this.injectFileIcon(titleEl, path);
        }
      } catch (err) {
        console.error('[material-icon] failed to inject icon', titleEl.dataset.path, err);
      }
    }

    let ready = !(
      (isFolder ? this.settings.applyToFolders : this.settings.applyToFiles) &&
      !titleEl.hasAttribute(APPLIED_ATTR)
    );

    if (isFolder) {
      if (!itemEl.hasAttribute(OBSERVED_ATTR)) {
        itemEl.setAttribute(OBSERVED_ATTR, '1');
        this.observeFolder(itemEl);
      }
      if (!itemEl.classList.contains('is-collapsed')) {
        itemEl
          .querySelectorAll<HTMLElement>(':scope > .tree-item-children > .tree-item')
          .forEach(child => {
            ready = this.processItem(child) && ready;
          });
      }
    }

    return ready;
  }

  /** Refresh a virtualized row without removing its icon slot. */
  private refreshRecycledRow(titleEl: HTMLElement): boolean {
    const itemEl = titleEl.parentElement;
    if (!itemEl?.classList.contains('tree-item')) return false;

    if (itemEl.classList.contains('nav-folder')) {
      if (!itemEl.hasAttribute(OBSERVED_ATTR)) {
        itemEl.setAttribute(OBSERVED_ATTR, '1');
        this.observeFolder(itemEl);
      }
      if (!this.settings.applyToFolders) {
        this.removeRowIcon(titleEl);
        return true;
      }
      this.injectFolderIcon(titleEl, itemEl.classList.contains('is-collapsed'), true);
    } else {
      const folderObserver = this.folderObservers.get(itemEl);
      if (folderObserver) {
        folderObserver.disconnect();
        this.folderObservers.delete(itemEl);
        itemEl.removeAttribute(OBSERVED_ATTR);
      }
      if (!this.settings.applyToFiles) {
        this.removeRowIcon(titleEl);
        return true;
      }
      const path = titleEl.dataset.path ?? '';
      if (!path) return false;
      this.injectFileIcon(titleEl, path, true);
    }

    return titleEl.hasAttribute(APPLIED_ATTR);
  }

  private observeFolder(folderEl: HTMLElement) {
    const obs = new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.attributeName !== 'class' || !m.target.instanceOf(HTMLElement)) continue;
        const wasCollapsed = (m.oldValue ?? '').includes('is-collapsed');
        const isCollapsed = folderEl.classList.contains('is-collapsed');
        if (wasCollapsed === isCollapsed) continue;

        const titleEl = folderEl.querySelector<HTMLElement>(':scope > .tree-item-self');
        if (titleEl) this.updateFolderIcon(titleEl, isCollapsed);
        if (!isCollapsed) {
          folderEl
            .querySelectorAll<HTMLElement>(':scope > .tree-item-children > .tree-item')
            .forEach(child => this.processItem(child));
        }
      }
    });
    obs.observe(folderEl, {
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true,
    });
    this.folderObservers.set(folderEl, obs);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private getIconSet(key: string): IconSet {
    return ownValue(iconRegistry, key)
      ?? ownValue(iconRegistry, defaultFileIconKey)
      ?? { dark: '', light: '' };
  }

  private getSvg(iconSet: IconSet): string {
    return this.isDark ? iconSet.dark : iconSet.light;
  }

  private getFileIconSvg(path: string): string {
    const segments = path.toLowerCase().split('/');
    const lower = segments[segments.length - 1] ?? '';

    // 0. Custom rules (highest priority)
    if (this.settings.enableCustomRules && this.settings.customRules.length > 0) {
      const parts = lower.split('.');
      for (let i = 1; i < parts.length; i++) {
        const ext = parts.slice(i).join('.');
        const rule = this.settings.customRules.find(r => r.extension === ext);
        if (rule) return this.getSvg(this.getIconSet(rule.iconKey));
      }
    }

    // 1. Directory-scoped filename, e.g. `.config/prettierrc` or `.github/FUNDING.yml`.
    // More specific than a bare filename, so it wins.
    if (segments.length >= 2) {
      const scopedKey = ownValue(fileNameKeys, segments.slice(-2).join('/'));
      if (scopedKey) return this.getSvg(this.getIconSet(scopedKey));
    }

    // 2. Exact filename match
    const nameKey = ownValue(fileNameKeys, lower);
    if (nameKey) return this.getSvg(this.getIconSet(nameKey));

    // 3. Extension match — longest suffix first
    const parts = lower.split('.');
    for (let i = 1; i < parts.length; i++) {
      const ext = parts.slice(i).join('.');
      const extKey = ownValue(fileExtensionKeys, ext);
      if (extKey) return this.getSvg(this.getIconSet(extKey));
    }

    return this.getSvg(this.getIconSet(defaultFileIconKey));
  }

  /** Resolve the folder icon for a name, falling back to the generic folder. */
  private getFolderIconKey(path: string, collapsed: boolean): string {
    const name = path.toLowerCase().split('/').pop() ?? '';
    const table = collapsed ? folderNameKeys : folderNameOpenKeys;
    return ownValue(table, name) ?? (collapsed ? folderIconKey : folderOpenIconKey);
  }

  private injectFileIcon(titleEl: HTMLElement, path: string, force = false) {
    if (!this.settings.applyToFiles) return;
    if (force) titleEl.removeAttribute(APPLIED_ATTR);
    else if (titleEl.hasAttribute(APPLIED_ATTR)) return;

    // Marked only after the icon is actually in place. Marking first would leave
    // rows that failed here permanently skipped, with no path back.
    const contentEl = titleEl.querySelector('.nav-file-title-content');
    if (!contentEl) return;

    this.placeIcon(titleEl, contentEl, this.getFileIconSvg(path), ICON_CLASS);
    titleEl.setAttribute(APPLIED_ATTR, '1');
  }

  private injectFolderIcon(titleEl: HTMLElement, collapsed: boolean, force = false) {
    if (!this.settings.applyToFolders) return;
    if (force) titleEl.removeAttribute(APPLIED_ATTR);
    else if (titleEl.hasAttribute(APPLIED_ATTR)) {
      this.updateFolderIcon(titleEl, collapsed);
      return;
    }

    const contentEl = titleEl.querySelector('.nav-folder-title-content');
    if (!contentEl) return;

    const key = this.getFolderIconKey(titleEl.dataset.path ?? '', collapsed);
    const icon = this.placeIcon(
      titleEl,
      contentEl,
      this.getSvg(this.getIconSet(key)),
      `${ICON_CLASS} ${FOLDER_ICON_CLASS}`
    );
    icon.dataset.mfiIconKey = key;
    titleEl.setAttribute(APPLIED_ATTR, '1');
  }

  private removeRowIcon(titleEl: HTMLElement) {
    titleEl.removeAttribute(APPLIED_ATTR);
    titleEl.querySelectorAll(`:scope > .${ICON_CLASS}`).forEach(el => el.remove());
  }

  /**
   * Put the icon in front of the label. insertBefore() requires a direct child,
   * so fall back to prepending when a theme wraps the label in another element.
   */
  private placeIcon(titleEl: HTMLElement, contentEl: Element, svg: string, className: string) {
    let icon = titleEl.querySelector<HTMLElement>(`:scope > .${ICON_CLASS}`);
    if (!icon) {
      // createSpan appends to titleEl, so the node is repositioned afterwards.
      // insertBefore and prepend both move an existing child, never duplicate it.
      icon = titleEl.createSpan({ cls: className });
      if (contentEl.parentElement === titleEl) titleEl.insertBefore(icon, contentEl);
      else titleEl.prepend(icon);
    } else {
      icon.className = className;
    }

    renderIconInto(icon, svg, 16);
    return icon;
  }

  private updateFolderIcon(titleEl: HTMLElement, collapsed: boolean) {
    const span = titleEl.querySelector<HTMLElement>(`.${FOLDER_ICON_CLASS}`);
    if (!span) return;
    const key = this.getFolderIconKey(titleEl.dataset.path ?? '', collapsed);
    if (span.dataset.mfiIconKey === key) return;
    renderIconInto(span, this.getSvg(this.getIconSet(key)), 16);
    span.dataset.mfiIconKey = key;
  }


  private resetAllIcons() {
    // Scoped to the explorers this instance owns. A document-wide query would
    // hit whichever window currently has focus, which in a multi-vault setup is
    // often somebody else's.
    for (const container of this.containers.keys()) {
      container.querySelectorAll(`[${APPLIED_ATTR}]`).forEach(el => el.removeAttribute(APPLIED_ATTR));
      container.querySelectorAll(`[${OBSERVED_ATTR}]`).forEach(el => el.removeAttribute(OBSERVED_ATTR));
      container.querySelectorAll(`.${ICON_CLASS}`).forEach(el => el.remove());
    }

    this.folderObservers.forEach(obs => obs.disconnect());
    this.folderObservers.clear();
  }

  resetAndRefresh() {
    this.resetAllIcons();
    this.refreshIcons();
  }

  async loadSettings() {
    // loadData() is typed as Promise<any>; narrow it before merging so the
    // settings object keeps a real type.
    const saved = (await this.loadData()) as Partial<MfiSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
