/**
 * Rendering engines for Office documents (.docx / .xlsx / .pptx) and for the
 * legacy binary formats (.doc / .xls / .ppt) we can only hand off.
 *
 * Ported from `siyuan-editor/src/office/*`, with one deliberate difference:
 * every engine here is READ-ONLY. In SiYuan the same engines could write back,
 * but an Obsidian vault is the user's primary copy of the file and a partially
 * re-serialized OOXML package is an easy way to corrupt one. Viewing covers
 * the real gap — Obsidian has no Office preview at all — while editing stays
 * with the external app (see `features/openWith.ts`).
 */

/** Extra buttons an engine can contribute to the view's toolbar. */
export interface OfficeToolbarAction {
  label: string;
  /** Inline SVG content; when absent only the text is drawn. */
  svg?: string;
  onClick(): void;
}

export interface OfficeEngine {
  /** Root element the view mounts. */
  readonly root: HTMLElement;
  /** False for legacy binary formats, which can only be opened externally. */
  readonly editable: boolean;
  /** Free DOM and any large buffers. */
  dispose(): void;
  /** Called when the container resizes. */
  resize?(): void;
  toolbarActions?: OfficeToolbarAction[];
}

export type OfficeKind = 'spreadsheet' | 'document' | 'presentation' | 'legacy';

const SPREADSHEET = new Set(['xlsx', 'xlsm', 'xltx', 'xltm', 'csv']);
const DOCUMENT = new Set(['docx', 'docm', 'dotx', 'dotm', 'rtf', 'odt']);
const PRESENTATION = new Set(['pptx', 'ppsx', 'potx', 'pptm', 'ppsm', 'potm', 'odp']);
const LEGACY = new Set(['doc', 'xls', 'ppt']);

/** Map a (dot-less, lower-cased) extension to an engine kind; '' when unknown. */
export function getOfficeKind(ext: string): OfficeKind | '' {
  const e = ext.toLowerCase();
  if (SPREADSHEET.has(e)) return 'spreadsheet';
  if (DOCUMENT.has(e)) return 'document';
  if (PRESENTATION.has(e)) return 'presentation';
  if (LEGACY.has(e)) return 'legacy';
  return '';
}

export const OFFICE_KIND_LABEL: Record<OfficeKind, string> = {
  spreadsheet: '表格',
  document: '文档',
  presentation: '演示文稿',
  legacy: '旧版文档',
};

/** Every extension the office view can take over. */
export const OFFICE_EXTENSIONS: string[] = [
  ...SPREADSHEET,
  ...DOCUMENT,
  ...PRESENTATION,
  ...LEGACY,
];

export function escapeHTML(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Read a vault file as an ArrayBuffer through Obsidian's adapter. */
export async function readVaultBinary(app: {
  vault: { adapter: { readBinary(path: string): Promise<ArrayBuffer> } };
}, path: string): Promise<ArrayBuffer> {
  return app.vault.adapter.readBinary(path);
}
