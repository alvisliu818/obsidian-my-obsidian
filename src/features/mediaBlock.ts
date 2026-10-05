/**
 * Media blocks (SiYuan parity: 图片块 / 视频块 / 音频块).
 *
 * Inserting one is a file pick, not typing: the modal lists the vault's media
 * files and writes a standard `![[path]]` embed. The block's type (image /
 * video / audio / embed) is then derived from that line by `detectBlockType`,
 * so nothing extra is stored.
 */

import { FuzzySuggestModal, TFile } from 'obsidian';
import type { BlockEditorView } from '../view/BlockEditorView';
import { mediaTypeOf } from '../blocks/blockTypes';

const MEDIA_EXT_RE =
  /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?|mp4|webm|mov|mpe?g|mkv|ogv|m4v|avi|mp3|wav|ogg|oga|m4a|flac|aac|opus|weba)$/i;

/** True when the path looks like something the media picker should offer. */
export function isMediaPath(path: string): boolean {
  return MEDIA_EXT_RE.test(path);
}

/** Fuzzy-pick a vault media file and embed it in the focused block. */
export function openInsertMediaBlock(host: BlockEditorView): void {
  new MediaBlockModal(host).open();
}

class MediaBlockModal extends FuzzySuggestModal<TFile> {
  constructor(private host: BlockEditorView) {
    super(host.app);
    this.setPlaceholder('Insert a media block…');
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((f) => isMediaPath(f.path));
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    insertMediaEmbed(this.host, file);
  }
}

/**
 * Write the embed at the caret, or as a new top-level block when no block is
 * being edited (a media block still belongs to the outline, not to a text row).
 */
export function insertMediaEmbed(host: BlockEditorView, file: TFile): void {
  const text = `![[${file.path}]]`;
  const view = host.focusedView;
  if (view && host.focusedBlock) {
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, to: pos, insert: text },
      selection: { anchor: pos + text.length },
    });
    view.focus();
    return;
  }
  host.insertTopLevelBlock(text, 'list');
}

/** The type a media embed of this file will be rendered as. */
export function mediaBlockType(file: TFile): string {
  return mediaTypeOf(file.path) || 'embed';
}
