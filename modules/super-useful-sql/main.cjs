'use strict';

/*
 * Super Useful SQL — query SQLite databases that live *outside* your vault, with SQL,
 * and read the results in a side panel. Nothing is written to your notes.
 *
 * Read-only by construction: sqlite runs in-process through Node's built-in
 * `node:sqlite` with a read-only connection, `PRAGMA query_only=1` and an
 * authorizer that only allows read actions. `prepare()` compiles a single
 * statement, so anything after the first `;` is never executed.
 */

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, normalizePath, TFile, TFolder } = require('obsidian');

const VIEW_TYPE = 'super-useful-sql-view';

/** AI assistant plugins this plugin can hand its usage instructions to.
 *  Matching is by id first, then by a name/id pattern, so unlisted assistants still work. */
const ASSISTANT_CANDIDATES = [
  { id: 'copilot', label: 'Copilot', folders: ['userSystemPromptsFolder', 'customPromptsFolder'] },
  { id: 'realclaudian', label: 'Claudian', folders: ['instructionsFolder'] },
];

/** Fallback labels when an assistant is not in ASSISTANT_CANDIDATES. */
const ASSISTANT_PATTERNS = [
  { re: /claudian/i, label: 'Claudian' },
  { re: /copilot/i, label: 'Copilot' },
  { re: /claude/i, label: 'Claude' },
];

const MARK_START = '<!-- super-useful-sql-ai:start -->';
const MARK_END = '<!-- super-useful-sql-ai:end -->';

const DEFAULTS = {
  databases: [],
  dictionaryPath: 'Super Useful SQL/Data dictionary.md',
  exportFolder: 'Super Useful SQL',
  aiInstructionsPath: 'Super Useful SQL/Super Useful SQL for AI.md',
  aiSuggestionDismissed: false,
  historyLimit: 50,
  renderRowCap: 500,
  maxRows: 200000,
  history: [],
};

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** uiLanguage: follow Obsidian's own language so the plugin reads like the app. */
const LANG = (() => {
  try {
    const l = String((window.localStorage.getItem('language') || navigator.language || 'en')).toLowerCase();
    return l.startsWith('zh') ? 'zh' : 'en';
  } catch (e) {
    return 'en';
  }
})();

const STRINGS = {
  en: {
    ribbon: 'Super Useful SQL',
    cmdOpen: 'Open query panel',
    cmdRunSelection: 'Run SQL from selection',
    cmdCopyAi: 'Copy usage instructions for AI assistants',
    cmdWriteAi: 'Write usage instructions for AI assistants',
    cmdClearHistory: 'Clear query history',
    db: 'DB',
    run: 'Run',
    readOnly: 'read-only',
    history: 'History',
    historyEmpty: '— none —',
    dictionary: 'Data dictionary',
    dictMissing: 'No data dictionary found. Set a path in settings, or create a template.',
    dictCreate: 'Create template',
    export: 'Export to',
    running: 'Running…',
    colsRows: (c, r, ms) => `${c} cols · ${r} rows · ${ms} ms`,
    dupCols: 'Duplicate column names — shown by position. Consider aliasing with AS.',
    noRows: '(no rows)',
    renderCap: (n, total) => `Showing first ${n} of ${total} rows (configurable).`,
    errEmpty: 'Empty query',
    errNoDb: 'No database configured (Settings → Super Useful SQL).',
    errUnknownDb: (a) => `Unknown database: ${a}`,
    errNoPath: 'Main database has no path set.',
    errPrefix: 'Unsupported input: SQL cannot start with ".". sqlite dot-commands are not available.',
    errSingle: 'Only a single statement is supported.',
    errVacuum: 'VACUUM is not supported.',
    errAttach: 'ATTACH/DETACH is not supported; registered databases are attached for you — use "alias.table".',
    errNoSqlite: 'node:sqlite is unavailable in this Obsidian runtime, so execution is refused. Reinstall Obsidian from the official download page — the latest installer bundles a newer Electron and adds it.',
    noticeRightSidebar: 'Super Useful SQL: the right sidebar is unavailable.',
    attachFailed: (alias, m) => `Could not attach "${alias}": ${m}`,
    truncated: (n) => `Result exceeded the ${n} row cap and was truncated (adjust maxRows in settings).`,
    exportNoResult: 'Nothing to export.',
    exportOk: (p) => `Exported: ${p}`,
    exportFail: (m) => `Export failed: ${m}`,
    aiTitle: 'AI assistants',
    aiDetected: (list) => `Detected: ${list}`,
    aiNone: 'No AI assistant plugin detected (Copilot, Claudian, …).',
    aiDesc: 'Write this plugin\'s usage instructions into a note (or copy them) so your AI assistant knows how to query these databases through Super Useful SQL.',
    aiPath: 'Instructions file',
    aiPathDesc: 'A marked block is created/updated here, so re-running replaces it instead of appending.',
    aiWrite: 'Write / update file',
    aiCopy: 'Copy to clipboard',
    aiCopied: 'Usage instructions copied to clipboard.',
    aiWritten: (p) => `Instructions written to ${p}`,
    aiSuggest: (who) => `Super Useful SQL: ${who} detected. Let it learn how to query your databases?`,
    aiSuggestBtn: 'Write instructions',
    aiSuggestionOnce: 'Suggest only once',
    aiSuggestionOnceDesc: 'Do not propose this again on startup.',
    aiTargetHint: (folder) => `Suggested folder from that plugin: ${folder}`,
    settingsDb: 'Databases',
    settingsDbDesc: 'Absolute paths to SQLite files outside the vault. Aliases are used for ATTACH and cross-database joins.',
    alias: 'Alias',
    path: 'Path',
    engine: 'Engine',
    addDb: 'Add database',
    remove: 'Remove',
    settingsData: 'Data & display',
    dictPath: 'Data dictionary path',
    dictPathDesc: 'Tables/columns descriptions. Parsed for the in-panel tree and for column header tooltips.',
    maxRows: 'Hard row cap (maxRows)',
    maxRowsDesc: 'sqlite streams rows and stops at this cap, so a runaway query cannot exhaust memory. 0 = unlimited (not recommended).',
    renderCapSetting: 'Rendered rows',
    renderCapSettingDesc: 'How many rows the panel renders (exports use maxRows).',
    historyLimit: 'History entries',
    historyLimitDesc: 'Stored in the plugin\'s data.json (never in notes). 0 = keep none.',
    clearHistory: 'Clear history now',
    historyCleared: 'Query history cleared.',
    exportFolder: 'Export folder',
    exportFolderDesc: 'Only used when you press Export.',
    sampleDbHint: 'No database yet — add one with an absolute path to a .db file.',
  },
  zh: {
    ribbon: 'Super Useful SQL',
    cmdOpen: '打开查询面板',
    cmdRunSelection: '对选中文本执行 SQL',
    cmdCopyAi: '复制给 AI 助手的使用说明',
    cmdWriteAi: '写入给 AI 助手的使用说明',
    cmdClearHistory: '清空查询历史',
    db: '库',
    run: '运行',
    readOnly: '只读',
    history: '历史',
    historyEmpty: '— 无 —',
    dictionary: '数据字典',
    dictMissing: '未读到数据字典。可在设置里指定路径，或生成模板。',
    dictCreate: '生成模板',
    export: '导出到',
    running: '执行中…',
    colsRows: (c, r, ms) => `${c} 列 · ${r} 行 · ${ms} ms`,
    dupCols: '结果含同名列，按位置分列显示（建议用 AS 取别名）。',
    noRows: '（无结果行）',
    renderCap: (n, total) => `仅显示前 ${n} 行，共 ${total} 行（可设置）。`,
    errEmpty: '空查询',
    errNoDb: '未配置数据库（设置 → Super Useful SQL）。',
    errUnknownDb: (a) => `未知数据库：${a}`,
    errNoPath: '主库未设置路径。',
    errPrefix: '不支持的输入：SQL 不能以 "." 开头（不支持 sqlite 点命令）。',
    errSingle: '只支持单条语句。',
    errVacuum: '不支持 VACUUM。',
    errAttach: '不支持 ATTACH/DETACH；登记库已自动挂载，用 “别名.表名” 引用。',
    errNoSqlite: '当前运行时没有 node:sqlite，已拒绝执行。请到官网下载最新安装包重装 Obsidian——新安装包带的 Electron 才有这个模块。',
    noticeRightSidebar: 'Super Useful SQL：右侧栏不可用。',
    attachFailed: (alias, m) => `库 ${alias} 挂载失败：${m}`,
    truncated: (n) => `结果超过 ${n} 行上限，已截断（可在设置里调 maxRows）。`,
    exportNoResult: '没有可导出的结果。',
    exportOk: (p) => `已导出：${p}`,
    exportFail: (m) => `导出失败：${m}`,
    aiTitle: 'AI 助手',
    aiDetected: (list) => `检测到：${list}`,
    aiNone: '未检测到 AI 助手插件（Copilot、Claudian 等）。',
    aiDesc: '把本插件的用法写进一个笔记（或复制），让你的 AI 助手知道如何通过 Super Useful SQL 查询这些库。',
    aiPath: '说明文件路径',
    aiPathDesc: '会在这里创建/更新一个带标记的区块，重复执行是替换而不是追加。',
    aiWrite: '写入 / 更新文件',
    aiCopy: '复制到剪贴板',
    aiCopied: '使用说明已复制到剪贴板。',
    aiWritten: (p) => `说明已写入 ${p}`,
    aiSuggest: (who) => `Super Useful SQL：检测到 ${who}。让它学会查询你的数据库？`,
    aiSuggestBtn: '写入说明',
    aiSuggestionOnce: '只建议一次',
    aiSuggestionOnceDesc: '启动时不再提示。',
    aiTargetHint: (folder) => `该插件的建议目录：${folder}`,
    settingsDb: '数据库',
    settingsDbDesc: '库外 SQLite 文件的绝对路径。别名用于 ATTACH 与跨库查询。',
    alias: '别名',
    path: '路径',
    engine: '引擎',
    addDb: '添加数据库',
    remove: '删除',
    settingsData: '数据与显示',
    dictPath: '数据字典路径',
    dictPathDesc: '表/列说明。用于面板内的字典树与结果列头提示。',
    maxRows: '结果行数硬上限（maxRows）',
    maxRowsDesc: 'sqlite 流式读取到上限即停，避免病态查询撑爆内存。0 表示不限制（不推荐）。',
    renderCapSetting: '渲染行数',
    renderCapSettingDesc: '面板渲染多少行（导出受 maxRows 约束）。',
    historyLimit: '历史条数',
    historyLimitDesc: '存在插件 data.json 里（不写笔记）。0 表示不留。',
    clearHistory: '立即清空历史',
    historyCleared: '查询历史已清空。',
    exportFolder: '导出目录',
    exportFolderDesc: '仅在你点“导出”时使用。',
    sampleDbHint: '还没有数据库——用 .db 文件的绝对路径添加一个。',
  },
};

function t(key, ...args) {
  const table = STRINGS[LANG] || STRINGS.en;
  const v = table[key] !== undefined ? table[key] : STRINGS.en[key];
  return typeof v === 'function' ? v(...args) : v;
}

/** node:sqlite is bundled with the runtime; refuse to run without it (fail closed). */
const nodeSqlite = (() => {
  try { return require('node:sqlite'); } catch (e) { return null; }
})();

function cleanSettings(raw) {
  const s = Object.assign({}, DEFAULTS, raw || {});
  if (!Array.isArray(s.databases)) s.databases = [];
  if (!Array.isArray(s.history)) s.history = [];
  return s;
}

/** Cell value → display text (BigInt / BLOB safe). */
function normText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return '<blob ' + v.length + 'B>';
  return String(v);
}

/** Escape a SQL string literal (used when embedding a path in an ATTACH statement). */
function sqlStr(s) {
  return String(s || '').replace(/'/g, "''");
}

/**
 * Parse a dictionary note into:
 *   [{name, engine, path, desc, tables: [{name, desc, columns: [{name, type, desc}]}]}]
 * Expected shape: `## Database <alias>` / `- **Path**: …` / `### Table <name>` / a `| column | type | description |` table.
 * Both English and Chinese heading words are accepted.
 */
function parseDictionary(md) {
  const dbs = [];
  let cur = null, curTable = null, inCols = false;
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trim();
    const dbM = line.match(/^##\s+(?:Database|库)\s+(\S+)/i);
    if (dbM) {
      cur = { name: dbM[1], engine: 'sqlite', path: '', desc: '', tables: [] };
      dbs.push(cur); curTable = null; inCols = false;
      continue;
    }
    if (!cur) continue;
    const tblM = line.match(/^###\s+(?:Table|表)\s+(\S+)/i);
    if (tblM) {
      curTable = { name: tblM[1], desc: '', columns: [] };
      cur.tables.push(curTable); inCols = false;
      continue;
    }
    const bM = line.match(/^-\s+\*\*(.+?)\*\*\s*[:：]\s*(.*)$/);
    if (bM && !curTable) {
      const k = bM[1].toLowerCase(), v = bM[2];
      if (k.includes('engine') || k.includes('引擎')) cur.engine = v;
      else if (k.includes('path') || k.includes('路径')) cur.path = v;
      else if (k.includes('desc') || k.includes('说明')) cur.desc = v;
      continue;
    }
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map((x) => x.trim());
      if (cells.length && cells.every((x) => x === '' || /^-{2,}$/.test(x))) continue;
      if (cells.length >= 3 && /^(column|列)$/i.test(cells[0])) { inCols = true; continue; }
      if (inCols && curTable && cells.length >= 3) {
        curTable.columns.push({ name: cells[0].replace(/`/g, ''), type: cells[1], desc: cells[2] });
      }
      continue;
    }
    if (curTable && !inCols && line && !line.startsWith('#') && !line.startsWith('-') && !line.startsWith('>')) {
      curTable.desc = (curTable.desc ? curTable.desc + ' ' : '') + line;
    }
  }
  return dbs;
}

const DICTIONARY_TEMPLATE = `# Data dictionary

Describes databases, tables and columns for Super Useful SQL. The panel shows this as a tree and
uses it for result column tooltips. Keep it in sync when the schema changes.

## Database <alias>

- **Engine**: sqlite
- **Path**: /absolute/path/to/example.db
- **Description**: what this database holds

### Table <name>

One row per thing. Prose here shows up under the table name.

| Column | Type | Description |
|---|---|---|
| id | INTEGER | primary key, join key |
| created | TEXT | ISO \`YYYY-MM-DD HH:MM:SS\` |
| body | TEXT | free text |
`;

class SuperUsefulSqlView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.lastResult = null;
    this.lastSql = '';
    this.lastDb = '';
    this.requestedDb = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Super Useful SQL'; }
  getIcon() { return 'database'; }

  async onOpen() {
    const c = this.contentEl;
    c.empty();
    c.addClass('susql-root');

    const bar = c.createDiv({ cls: 'susql-bar' });
    bar.createSpan({ text: t('db'), cls: 'susql-label' });
    this.dbSelect = bar.createEl('select', { cls: 'susql-db' });
    this.dbSelect.onchange = () => { this.requestedDb = null; };
    this.runBtn = bar.createEl('button', { text: t('run') + ' ▶', cls: 'mod-cta' });
    this.runBtn.onclick = () => { this.execute(); };
    bar.createSpan({ text: t('readOnly'), cls: 'susql-ro' });
    bar.createSpan({ text: t('history'), cls: 'susql-label' });
    this.histSelect = bar.createEl('select', { cls: 'susql-hist' });
    this.histSelect.onchange = () => {
      const v = this.histSelect.value;
      if (v) { this.editor.value = v; this.editor.focus(); }
    };

    this.dictEl = c.createEl('details', { cls: 'susql-dict' });
    this.dictEl.createEl('summary', { text: t('dictionary') });
    this.dictBody = this.dictEl.createDiv({ cls: 'susql-dict-body' });

    this.editor = c.createEl('textarea', { cls: 'susql-editor' });
    this.editor.spellcheck = false;
    this.editor.placeholder = 'SELECT author, COUNT(*) AS n FROM books GROUP BY author ORDER BY n DESC LIMIT 20;';
    this.editor.onkeydown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); this.execute(); }
    };

    const act = c.createDiv({ cls: 'susql-actions' });
    this.exportBtn = act.createEl('button', { text: t('export') + ' ' + this.plugin.settings.exportFolder });
    this.exportBtn.onclick = () => { this.exportCurrent(); };
    this.statusEl = act.createSpan({ cls: 'susql-status' });

    this.resultEl = c.createDiv({ cls: 'susql-result' });

    this.refreshDbs();
    this.refreshHistory();
    await this.renderDictionary();
  }

  async onClose() {}

  refreshDbs() {
    const dbs = this.plugin.settings.databases;
    const keep = this.dbSelect.value;
    this.dbSelect.empty();
    for (const d of dbs) this.dbSelect.createEl('option', { value: d.alias, text: d.alias });
    if (dbs.length && dbs.some((d) => d.alias === keep)) this.dbSelect.value = keep;
  }

  refreshHistory() {
    const h = this.plugin.settings.history;
    this.histSelect.empty();
    this.histSelect.createEl('option', { value: '', text: h.length ? '— ' + h.length + ' —' : t('historyEmpty') });
    for (const item of h) {
      const one = String(item.sql).replace(/\s+/g, ' ').trim();
      this.histSelect.createEl('option', {
        value: item.sql,
        text: (item.db ? item.db + ' · ' : '') + (one.length > 70 ? one.slice(0, 70) + '…' : one),
      });
    }
  }

  async renderDictionary() {
    const dbs = await this.plugin.getDictionary();
    this.dictBody.empty();
    if (!dbs.length) {
      const row = this.dictBody.createDiv({ cls: 'susql-muted' });
      row.createSpan({ text: t('dictMissing') + ' ' });
      const btn = row.createEl('button', { text: t('dictCreate') });
      btn.onclick = async () => {
        await this.plugin.writeDictionaryTemplate();
        await this.renderDictionary();
      };
      return;
    }
    for (const db of dbs) {
      const wrap = this.dictBody.createDiv({ cls: 'susql-dict-db' });
      const head = wrap.createDiv({ cls: 'susql-dict-dbhead' });
      head.createSpan({ text: db.name, cls: 'susql-dict-dbname' });
      head.createSpan({ text: db.engine, cls: 'susql-muted' });
      if (db.desc) wrap.createDiv({ text: db.desc, cls: 'susql-muted' });
      if (db.path) wrap.createDiv({ text: db.path, cls: 'susql-dict-path' });
      for (const tb of db.tables) {
        const td = wrap.createEl('details', { cls: 'susql-dict-table' });
        td.createEl('summary', { text: tb.name });
        if (tb.desc) td.createDiv({ text: tb.desc, cls: 'susql-muted' });
        const ul = td.createEl('ul', { cls: 'susql-dict-cols' });
        for (const col of tb.columns) {
          const li = ul.createEl('li');
          li.createSpan({ text: col.name, cls: 'susql-col-name' });
          li.createSpan({ text: ' ' + col.type + ' ', cls: 'susql-col-type' });
          li.createSpan({ text: col.desc });
        }
      }
    }
  }

  /** Point the editor at a query and a database alias (unknown alias errors on run). */
  setSql(sql, alias) {
    this.editor.value = sql || '';
    this.requestedDb = alias || null;
    if (alias) {
      this.refreshDbs();
      if (this.plugin.settings.databases.some((d) => d.alias === alias)) this.dbSelect.value = alias;
    }
  }

  async execute() {
    const sql = (this.editor.value || '').trim();
    const alias = this.requestedDb || this.dbSelect.value;
    if (!sql) return { error: t('errEmpty'), columns: [], rows: [], ms: 0 };
    this.runBtn.disabled = true;
    this.statusEl.setText(t('running'));
    // Yield a frame so the "running" state is visible before the synchronous query.
    await new Promise((r) => setTimeout(r, 0));
    const res = await this.plugin.runQuery(sql, alias);
    this.runBtn.disabled = false;
    this.lastResult = res;
    this.lastSql = sql;
    this.lastDb = alias;
    if (!res.error) this.requestedDb = null;
    this.renderResult(res);
    this.refreshHistory();
    return res;
  }

  renderResult(res) {
    this.resultEl.empty();
    if (!res) return;
    if (res.error) {
      this.statusEl.setText('✗');
      this.resultEl.createDiv({ text: res.error, cls: 'susql-error' });
      return;
    }
    const rows = res.rows || [];
    const cols = res.columns || [];
    const cap = this.plugin.settings.renderRowCap;
    this.statusEl.setText(t('colsRows', cols.length, rows.length, res.ms));
    if (new Set(cols).size < cols.length) {
      this.resultEl.createDiv({ text: t('dupCols'), cls: 'susql-muted' });
    }
    if (res.warning) this.resultEl.createDiv({ text: res.warning, cls: 'susql-muted' });
    if (!rows.length) {
      this.resultEl.createDiv({ text: t('noRows'), cls: 'susql-muted' });
      return;
    }
    const table = this.resultEl.createEl('table', { cls: 'susql-table' });
    const thead = table.createEl('thead').createEl('tr');
    for (const col of cols) {
      const th = thead.createEl('th', { text: col });
      const help = this.plugin.columnHelp(col);
      if (help) th.title = help;
    }
    const tbody = table.createEl('tbody');
    const n = Math.min(rows.length, cap);
    for (let i = 0; i < n; i++) {
      const tr = tbody.createEl('tr');
      for (let j = 0; j < cols.length; j++) {
        tr.createEl('td', { text: normText(rows[i][j]) });
      }
    }
    if (rows.length > cap) {
      this.resultEl.createDiv({ text: t('renderCap', cap, rows.length), cls: 'susql-muted' });
    }
  }

  async exportCurrent() {
    const res = this.lastResult;
    if (!res || res.error || !res.rows || !res.rows.length) {
      new Notice(t('exportNoResult'));
      return;
    }
    const folder = (this.plugin.settings.exportFolder || 'Super Useful SQL').replace(/\/+$/, '');
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const name = 'sql-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.md';
    const cols = res.columns || [];
    const lines = [];
    lines.push('Query (' + this.lastDb + ', ' + res.rows.length + ' rows' +
      (res.truncated ? ', truncated at maxRows' : '') + ', ' + res.ms + ' ms):');
    lines.push('');
    lines.push('```sql');
    lines.push(this.lastSql);
    lines.push('```');
    lines.push('');
    lines.push('| ' + cols.join(' | ') + ' |');
    lines.push('| ' + cols.map(() => '---').join(' | ') + ' |');
    for (const row of res.rows) {
      lines.push('| ' + cols.map((c, j) => normText(row[j]).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |');
    }
    lines.push('');
    try {
      await this.plugin.ensureFolder(folder);
      const file = await this.plugin.app.vault.create(normalizePath(folder + '/' + name), lines.join('\n'));
      new Notice(t('exportOk', file.path));
    } catch (e) {
      new Notice(t('exportFail', String((e && e.message) || e)));
    }
  }
}

class SuperUsefulSqlSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl).setName(t('settingsDb')).setHeading();
    containerEl.createEl('p', { text: t('settingsDbDesc'), cls: 'setting-item-description' });
    if (!s.databases.length) {
      containerEl.createEl('p', { text: t('sampleDbHint'), cls: 'setting-item-description' });
    }

    for (let i = 0; i < s.databases.length; i++) {
      const db = s.databases[i];
      new Setting(containerEl)
        .setName(t('alias'))
        .addText((x) => x.setValue(db.alias).onChange(async (v) => {
          const val = v.trim();
          if (IDENT_RE.test(val)) { db.alias = val; await this.plugin.saveSettings(); this.plugin.refreshViews(); }
        }))
        .addText((x) => x.setValue(db.path).setPlaceholder('/absolute/path/to/data.db').onChange(async (v) => {
          db.path = v.trim(); await this.plugin.saveSettings();
        }))
        .addExtraButton((b) => b.setIcon('trash').setTooltip(t('remove')).onClick(async () => {
          s.databases.splice(i, 1); await this.plugin.saveSettings(); this.plugin.refreshViews(); this.display();
        }));
    }
    new Setting(containerEl).addButton((b) => b.setButtonText(t('addDb')).onClick(async () => {
      s.databases.push({ alias: 'db' + (s.databases.length + 1), path: '', engine: 'sqlite' });
      await this.plugin.saveSettings(); this.display();
    }));

    new Setting(containerEl).setName(t('aiTitle')).setHeading();
    const detected = this.plugin.detectAssistants();
    containerEl.createEl('p', {
      text: detected.length ? t('aiDetected', detected.map((d) => d.label).join(', ')) : t('aiNone'),
      cls: 'setting-item-description',
    });
    const hint = detected.map((d) => d.folder).filter(Boolean)[0];
    if (hint) containerEl.createEl('p', { text: t('aiTargetHint', hint), cls: 'setting-item-description' });
    containerEl.createEl('p', { text: t('aiDesc'), cls: 'setting-item-description' });

    new Setting(containerEl)
      .setName(t('aiPath'))
      .setDesc(t('aiPathDesc'))
      .addText((x) => x.setValue(s.aiInstructionsPath).onChange(async (v) => {
        s.aiInstructionsPath = v.trim(); await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .addButton((b) => b.setButtonText(t('aiWrite')).setCta().onClick(async () => { await this.plugin.writeAiInstructions(); }))
      .addButton((b) => b.setButtonText(t('aiCopy')).onClick(async () => { await this.plugin.copyAiInstructions(); }));
    new Setting(containerEl)
      .setName(t('aiSuggestionOnce'))
      .setDesc(t('aiSuggestionOnceDesc'))
      .addToggle((tg) => tg.setValue(!!s.aiSuggestionDismissed).onChange(async (v) => {
        s.aiSuggestionDismissed = v; await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName(t('settingsData')).setHeading();

    new Setting(containerEl)
      .setName(t('dictPath'))
      .setDesc(t('dictPathDesc'))
      .addText((x) => x.setValue(s.dictionaryPath).onChange(async (v) => {
        s.dictionaryPath = v.trim(); await this.plugin.saveSettings(); await this.plugin.refreshDictionary();
      }));

    new Setting(containerEl)
      .setName(t('maxRows'))
      .setDesc(t('maxRowsDesc'))
      .addText((x) => x.setValue(String(s.maxRows)).onChange(async (v) => {
        const n = parseInt(v, 10); if (!isNaN(n) && n >= 0) { s.maxRows = n; await this.plugin.saveSettings(); }
      }));

    new Setting(containerEl)
      .setName(t('renderCapSetting'))
      .setDesc(t('renderCapSettingDesc'))
      .addText((x) => x.setValue(String(s.renderRowCap)).onChange(async (v) => {
        const n = parseInt(v, 10); if (!isNaN(n) && n > 0) { s.renderRowCap = n; await this.plugin.saveSettings(); }
      }));

    new Setting(containerEl)
      .setName(t('historyLimit'))
      .setDesc(t('historyLimitDesc'))
      .addText((x) => x.setValue(String(s.historyLimit)).onChange(async (v) => {
        const n = parseInt(v, 10); if (!isNaN(n) && n >= 0) { s.historyLimit = n; await this.plugin.saveSettings(); }
      }))
      .addButton((b) => b.setButtonText(t('clearHistory')).setWarning().onClick(async () => {
        await this.plugin.clearHistory(); this.display();
      }));

    new Setting(containerEl)
      .setName(t('exportFolder'))
      .setDesc(t('exportFolderDesc'))
      .addText((x) => x.setValue(s.exportFolder).onChange(async (v) => {
        s.exportFolder = v.trim() || 'Super Useful SQL'; await this.plugin.saveSettings();
      }));

  }
}

class SuperUsefulSqlPlugin extends Plugin {
  async onload() {
    this.settings = cleanSettings(await this.loadData());
    this.dict = [];
    this.colDesc = {};

    this.registerView(VIEW_TYPE, (leaf) => new SuperUsefulSqlView(leaf, this));

    this.addRibbonIcon('database', t('ribbon'), () => this.activateView());
    this.addCommand({ id: 'open', name: t('cmdOpen'), callback: () => this.activateView() });
    this.addCommand({
      id: 'run-selection',
      name: t('cmdRunSelection'),
      editorCallback: async (editor) => {
        const sql = editor.getSelection() || editor.getValue();
        await this.activateView();
        const view = this.getView();
        if (view) { view.setSql(sql, view.dbSelect.value); await view.execute(); }
      },
    });
    this.addCommand({ id: 'copy-ai-instructions', name: t('cmdCopyAi'), callback: () => this.copyAiInstructions() });
    this.addCommand({ id: 'write-ai-instructions', name: t('cmdWriteAi'), callback: () => this.writeAiInstructions() });
    this.addCommand({
      id: 'clear-history',
      name: t('cmdClearHistory'),
      callback: async () => { await this.clearHistory(); this.refreshViews(); new Notice(t('historyCleared')); },
    });

    this.addSettingTab(new SuperUsefulSqlSettingTab(this.app, this));

    /* Programmatic entry point for AI assistants and scripts:
     *   app.plugins.plugins["super-useful-sql"].api.run(sql, { db: "alias" }) */
    this.api = {
      run: async (sql, opts) => {
        const o = opts || {};
        await this.activateView();
        const view = this.getView();
        if (view) {
          view.setSql(sql, o.db);
          return await view.execute();
        }
        return await this.runQuery(sql, o.db);
      },
      listDatabases: () => this.settings.databases.map((d) => ({ alias: d.alias, path: d.path, engine: d.engine })),
      dictionary: () => this.dict,
      instructions: () => this.aiInstructionBlock(),
    };

    this.app.workspace.onLayoutReady(() => {
      this.refreshDictionary();
      this.suggestForAssistants();
    });
  }

  onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }

  async saveSettings() { await this.saveData(this.settings); }

  /** Which AI assistant plugins are enabled (and a folder they read prompts from, if known). */
  detectAssistants() {
    const found = [];
    const seen = new Set();
    const plugins = (this.app.plugins && this.app.plugins.plugins) || {};
    for (const id of Object.keys(plugins)) {
      const inst = plugins[id];
      if (!inst) continue;
      const cand = ASSISTANT_CANDIDATES.find((c) => c.id === id);
      let label = cand ? cand.label : '';
      if (!label) {
        const name = String((inst.manifest && inst.manifest.name) || id);
        const hit = ASSISTANT_PATTERNS.find((p) => p.re.test(name) || p.re.test(id));
        if (hit) label = hit.label;
      }
      if (!label || seen.has(label)) continue;
      seen.add(label);
      let folder = '';
      try {
        const st = inst.settings || {};
        const keys = cand ? cand.folders : ['userSystemPromptsFolder', 'customPromptsFolder'];
        for (const key of keys) {
          if (typeof st[key] === 'string' && st[key].trim()) { folder = st[key].trim(); break; }
        }
      } catch (e) { /* best effort only */ }
      found.push({ id: id, label: label, folder: folder });
    }
    return found;
  }

  suggestForAssistants() {
    if (this.settings.aiSuggestionDismissed) return;
    const detected = this.detectAssistants();
    if (!detected.length) return;
    const who = detected.map((d) => d.label).join(', ');
    try {
      const notice = new Notice(t('aiSuggest', who), 15000);
      const btn = notice.noticeEl.createEl('button', { text: t('aiSuggestBtn'), cls: 'susql-notice-btn' });
      btn.onclick = async () => {
        notice.hide();
        await this.writeAiInstructions();
        this.settings.aiSuggestionDismissed = true;
        await this.saveSettings();
      };
    } catch (e) {
      new Notice(t('aiSuggest', who));
    }
  }

  /** The teaching block handed to AI assistants; idempotent via HTML-comment markers. */
  aiInstructionBlock() {
    const dbs = this.settings.databases || [];
    const dbLines = dbs.length
      ? dbs.map((d) => `  - \`${d.alias}\` — \`${d.path}\` (${d.engine || 'sqlite'})`).join('\n')
      : '  - (none registered yet)';
    return [
      MARK_START,
      '## Super Useful SQL',
      '',
      'This vault has the **Super Useful SQL** plugin: it runs read-only SQL against SQLite databases that live',
      '**outside** the vault and shows results in a side panel without creating notes.',
      '',
      'Run a query and show it to the user:',
      '',
      '```js',
      'await app.plugins.plugins["super-useful-sql"].api.run("SELECT 1 AS ok", { db: "<alias>" });',
      '```',
      '',
      'Returns `{ columns, rows, ms, error, warning, truncated }`. `columns` is a string array and `rows` is',
      'an array of arrays aligned with `columns` (duplicate names keep their position).',
      '',
      'Other entry points: `api.listDatabases()`, `api.dictionary()`, `api.instructions()`.',
      '',
      'Registered databases (alias — absolute path — engine):',
      dbLines,
      '',
      'Rules to follow when writing SQL for this plugin:',
      '',
      '- Read-only. `INSERT`/`UPDATE`/`CREATE`/`DROP`, `ATTACH`/`DETACH`, `PRAGMA` and `VACUUM` are rejected.',
      '- One statement per call. Anything after the first `;` is never executed.',
      '- Cross-database joins: the `db` you pass is the main database (unqualified table names); every other',
      '  registered database is attached under its alias, so reference it as `alias.table`.',
      '- Plain SQL only: sqlite dot-commands such as `.shell` or `.tables` are rejected.',
      `- Keep results small (WHERE/LIMIT). The plugin caps rows at ${this.settings.maxRows} and renders ${this.settings.renderRowCap}.`,
      this.settings.dictionaryPath
        ? `- Schemas and column meanings: read \`${this.settings.dictionaryPath}\` before writing queries.`
        : '- Ask the user for schema details before writing queries.',
      MARK_END,
      '',
    ].join('\n');
  }

  async copyAiInstructions() {
    const text = this.aiInstructionBlock();
    try {
      await navigator.clipboard.writeText(text);
      new Notice(t('aiCopied'));
    } catch (e) {
      new Notice(t('aiCopied'));
    }
  }

  /** Create or update the marked block in the instructions file (never append duplicates). */
  async writeAiInstructions() {
    const path = normalizePath((this.settings.aiInstructionsPath || '').trim());
    if (!path) { new Notice(t('aiPath')); return; }
    const block = this.aiInstructionBlock();
    const merge = (old) => {
      const a = old.indexOf(MARK_START);
      if (a < 0) return old.replace(/\s*$/, '\n\n') + block;      // no block yet: append one
      const b = old.indexOf(MARK_END, a);                          // end marker must follow the start
      if (b > a) return old.slice(0, a) + block.trimEnd() + old.slice(b + MARK_END.length);
      // Start marker without an end marker: replace the marker and keep everything after it.
      return old.slice(0, a) + block.trimEnd() + old.slice(a + MARK_START.length);
    };
    try {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.vault.process(existing, merge);
      } else {
        await this.ensureFolder(path.split('/').slice(0, -1).join('/'));
        await this.app.vault.create(path, block);
      }
      new Notice(t('aiWritten', path));
    } catch (e) {
      new Notice(t('exportFail', String((e && e.message) || e)));
    }
  }

  async writeDictionaryTemplate() {
    const path = normalizePath((this.settings.dictionaryPath || '').trim());
    if (!path) return;
    try {
      if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) {
        await this.ensureFolder(path.split('/').slice(0, -1).join('/'));
        await this.app.vault.create(path, DICTIONARY_TEMPLATE);
      }
      await this.refreshDictionary();
    } catch (e) {
      new Notice(t('exportFail', String((e && e.message) || e)));
    }
  }

  async clearHistory() {
    this.settings.history = [];
    await this.saveSettings();
  }

  /** Create a folder path if it does not exist yet (mkdir -p style). */
  async ensureFolder(folder) {
    const f = (folder || '').replace(/^\/+|\/+$/g, '');
    if (!f) return;
    try {
      let acc = '';
      for (const seg of f.split('/')) {
        acc = acc ? acc + '/' + seg : seg;
        if (!(this.app.vault.getAbstractFileByPath(acc) instanceof TFolder)) {
          await this.app.vault.createFolder(acc);
        }
      }
    } catch (e) { /* already exists or cannot create; the caller surfaces the error */ }
  }

  async refreshDictionary() {
    try {
      const path = normalizePath((this.settings.dictionaryPath || '').trim());
      const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
      if (!(file instanceof TFile)) {
        this.dict = [];
        this.colDesc = {};
        return;
      }
      const raw = await this.app.vault.cachedRead(file);
      this.dict = parseDictionary(raw);
      const map = {};
      for (const db of this.dict) {
        for (const tb of db.tables) {
          for (const c of tb.columns) {
            if (map[c.name] === undefined) map[c.name] = c.desc;
            else if (map[c.name] !== c.desc && map[c.name].indexOf(c.desc) < 0) map[c.name] = map[c.name] + ' / ' + c.desc;
          }
        }
      }
      this.colDesc = map;
    } catch (e) {
      this.dict = [];
      this.colDesc = {};
    }
  }

  async getDictionary() {
    if (!this.dict.length) await this.refreshDictionary();
    return this.dict;
  }

  columnHelp(name) { return this.colDesc[name] || ''; }

  async refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view && leaf.view.refreshDbs) leaf.view.refreshDbs();
      if (leaf.view && leaf.view.refreshHistory) leaf.view.refreshHistory();
    }
  }

  async activateView() {
    let leaf = null;
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length) leaf = leaves[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) { new Notice(t('noticeRightSidebar')); return; }
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  getView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    return leaves.length ? leaves[0].view : null;
  }

  /**
   * sqlite engine: in-process node:sqlite.
   * Read-only is enforced three ways (readOnly connection + query_only + authorizer);
   * `prepare()` compiles only the first statement, so trailing statements never run.
   */
  executeSqlite(main, dbs, sql) {
    if (!nodeSqlite) {
      return { error: t('errNoSqlite'), columns: [], rows: [], ms: 0 };
    }
    const C = nodeSqlite.constants;
    const allow = new Set([
      C.SQLITE_SELECT, C.SQLITE_READ, C.SQLITE_FUNCTION,
      C.SQLITE_RECURSIVE, C.SQLITE_TRANSACTION, C.SQLITE_SAVEPOINT,
    ]);
    // Deny-by-name for functions that could touch the filesystem, in case a build exposes them.
    const FN_DENY = new Set([
      'load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer',
      'fileio_read', 'fileio_write', 'zipfile',
    ]);
    let db = null;
    const warnings = [];
    try {
      db = new nodeSqlite.DatabaseSync(main.path, { readOnly: true });
      for (const o of dbs) {
        if (o === main || o.engine !== 'sqlite' || !o.alias || !o.path) continue;
        if (!IDENT_RE.test(o.alias)) continue;
        try {
          db.exec(`ATTACH DATABASE 'file:${sqlStr(o.path)}?mode=ro' AS ${o.alias}`);
        } catch (e) {
          warnings.push(t('attachFailed', o.alias, String((e && e.message) || e)));
        }
      }
      db.exec('PRAGMA query_only=1');
      db.setAuthorizer((action, arg1, arg2) => {
        if (action === C.SQLITE_FUNCTION) {
          return (arg2 && FN_DENY.has(String(arg2).toLowerCase())) ? C.SQLITE_DENY : C.SQLITE_OK;
        }
        return allow.has(action) ? C.SQLITE_OK : C.SQLITE_DENY;
      });

      const t0 = Date.now();
      const limit = this.settings.maxRows > 0 ? this.settings.maxRows : 0;
      const norm = (v) => {
        if (typeof v !== 'bigint') return v;
        return (v >= -9007199254740991n && v <= 9007199254740991n) ? Number(v) : v.toString();
      };
      // Stream rows with a cap: `all()` would materialize everything and can exhaust memory.
      const drain = (s) => {
        const out = [];
        let trunc = false;
        for (const r of s.iterate()) {
          if (limit && out.length >= limit) { trunc = true; break; }   // only if another row really exists
          if (!Array.isArray(r)) throw new Error('internal: row is not an array (setReturnArrays missing)');
          out.push(Array.from(r, norm));
        }
        return { out, trunc };
      };
      let stmt = db.prepare(sql);          // first statement only
      stmt.setReturnArrays(true);          // keep column order and duplicate names
      const cols = stmt.columns().map((c) => c.name);
      let drained;
      try {
        drained = drain(stmt);
      } catch (e) {
        // Integer beyond the JS safe range → re-read as BigInt, then normalize.
        if (!/too large/i.test(String((e && e.message) || ''))) throw e;
        stmt = db.prepare(sql);
        stmt.setReturnArrays(true);
        stmt.setReadBigInts(true);
        drained = drain(stmt);
      }
      const ms = Date.now() - t0;
      if (drained.trunc) warnings.push(t('truncated', limit));
      return {
        columns: cols,
        rows: drained.out,
        truncated: drained.trunc,
        ms,
        error: null,
        warning: warnings.length ? warnings.join('; ') : null,
      };
    } catch (e) {
      return { error: String((e && e.message) || e), columns: [], rows: [], ms: 0 };
    } finally {
      if (db) { try { db.close(); } catch (e) { /* ignore */ } }
    }
  }

  async runQuery(sql, alias) {
    const err = (m) => ({ error: m, columns: [], rows: [], ms: 0 });
    const dbs = this.settings.databases || [];
    if (!dbs.length) return err(t('errNoDb'));

    const main = alias ? dbs.find((d) => d.alias === alias) : dbs[0];
    if (!main) return err(t('errUnknownDb', alias));
    if (!main.path) return err(t('errNoPath'));

    // A `.`-prefixed input is a sqlite CLI dot-command, never valid SQL: reject it with a clear
    // message instead of letting the parser fail on it. (`--` comments are fine.)
    if (/^\s*\./.test(sql)) return err(t('errPrefix'));

    // Scan text with literals removed first, then comments: a comment marker inside a string
    // literal must not be able to hide real statements between two literals.
    const scan = String(sql)
      .replace(/'(?:[^']|'')*'/g, "''")
      .replace(/"(?:[^"]|"")*"/g, '""')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ');

    // `prepare()` compiles only the first statement, so anything after `;` is inert — this check
    // exists to say so out loud. The VACUUM guard is a real boundary: the authorizer does not
    // intercept VACUUM INTO, which writes to disk.
    if (/;/.test(scan.replace(/\s*;\s*$/, ''))) return err(t('errSingle'));
    if (/\bVACUUM\b/i.test(scan)) return err(t('errVacuum'));
    if (/\b(ATTACH|DETACH)\b/i.test(scan)) return err(t('errAttach'));

    let res;
    try {
      res = this.executeSqlite(main, dbs, sql);
    } catch (e) {
      res = { error: String((e && e.message) || e), columns: [], rows: [], ms: 0 };
    }
    if (!res.error && this.settings.historyLimit > 0) {
      this.settings.history.unshift({ sql: sql, db: main.alias, ts: Date.now() });
      if (this.settings.history.length > this.settings.historyLimit) {
        this.settings.history.length = this.settings.historyLimit;
      }
      await this.saveSettings();
    }
    return res;
  }
}

module.exports = SuperUsefulSqlPlugin;
