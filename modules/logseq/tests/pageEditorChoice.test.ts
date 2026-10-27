/**
 * Per-page default editor: the `editor:: logseq|native` page property
 * (or frontmatter `editor:`) overrides the take-over settings.
 */

import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import {
  docPageProps,
  editorChoiceFromProps,
  takeOverForFile,
  type BlockEditorSettings,
} from '../src/types';
import { editorChoiceFromExternalText } from '../../doc-tree/src/types';

describe('editorChoiceFromProps', () => {
  it('maps the two known values', () => {
    expect(editorChoiceFromProps({ editor: 'logseq' })).toBe('logseq');
    expect(editorChoiceFromProps({ editor: 'native' })).toBe('native');
  });

  it('matches key and value case-insensitively and trims the value', () => {
    expect(editorChoiceFromProps({ Editor: 'Native' })).toBe('native');
    expect(editorChoiceFromProps({ EDITOR: 'Logseq' })).toBe('logseq');
    expect(editorChoiceFromProps({ editor: '  native ' })).toBe('native');
  });

  it('ignores unknown values, empty values and other keys', () => {
    expect(editorChoiceFromProps({ editor: 'foo' })).toBeNull();
    expect(editorChoiceFromProps({ editor: '' })).toBeNull();
    expect(editorChoiceFromProps({ editor: 'true' })).toBeNull();
    expect(editorChoiceFromProps({ type: 'native' })).toBeNull();
  });

  it('handles missing and non-string props (frontmatter booleans/numbers)', () => {
    expect(editorChoiceFromProps(undefined)).toBeNull();
    expect(editorChoiceFromProps(null)).toBeNull();
    expect(editorChoiceFromProps({})).toBeNull();
    expect(editorChoiceFromProps({ editor: 42 })).toBeNull();
    expect(editorChoiceFromProps({ editor: true })).toBeNull();
    expect(editorChoiceFromProps({ editor: 'LOGSEQ' })).toBe('logseq');
  });
});

describe('takeOverForFile', () => {
  type S = Pick<BlockEditorSettings, 'takeOverByDefault' | 'scopeMode' | 'includedFolders' | 'excludedFolders'>;
  const all: S = {
    takeOverByDefault: true,
    scopeMode: 'all',
    includedFolders: '',
    excludedFolders: 'excluded',
  };
  const foldersIn: S = {
    takeOverByDefault: true,
    scopeMode: 'folders',
    includedFolders: 'notes',
    excludedFolders: '',
  };
  const off: S = { takeOverByDefault: false, scopeMode: 'all', includedFolders: '', excludedFolders: 'excluded' };
  const t = (choice: 'logseq' | 'native' | null, s: S, file: string) =>
    takeOverForFile(choice, s.takeOverByDefault, s.scopeMode, s.includedFolders, s.excludedFolders, file);

  it('editor:: logseq forces the block editor — even with take-over off or outside included folders', () => {
    expect(t('logseq', off, 'anywhere/page.md')).toBe(true);
    expect(t('logseq', { ...foldersIn }, 'elsewhere/page.md')).toBe(true);
    expect(t('logseq', all, 'excluded/page.md')).toBe(true);
  });

  it('editor:: native keeps the native editor — even inside included folders', () => {
    expect(t('native', { ...foldersIn }, 'notes/page.md')).toBe(false);
    expect(t('native', all, 'anywhere/page.md')).toBe(false);
  });

  it('without the property the settings decide exactly as before', () => {
    expect(t(null, off, 'notes/page.md')).toBe(false);
    expect(t(null, all, 'notes/page.md')).toBe(true);
    expect(t(null, all, 'excluded/page.md')).toBe(false);
    expect(t(null, foldersIn, 'notes/page.md')).toBe(true);
    expect(t(null, foldersIn, 'other/page.md')).toBe(false);
  });
});

describe('editorChoiceFromExternalText', () => {
  it('reads frontmatter editor: (Obsidian style)', () => {
    expect(editorChoiceFromExternalText('---\ntitle: x\neditor: native\n---\n# hi')).toBe('native');
    expect(editorChoiceFromExternalText('---\neditor: logseq\n---\nbody')).toBe('logseq');
    expect(editorChoiceFromExternalText('---\nEditor: Native\n---\nbody')).toBe('native');
  });

  it('reads top-of-file Logseq page properties (editor::)', () => {
    expect(editorChoiceFromExternalText('editor:: logseq\ntype:: book\n- a block')).toBe('logseq');
    expect(editorChoiceFromExternalText('editor:: native\n- a block')).toBe('native');
  });

  it('parses CRLF files the same', () => {
    expect(editorChoiceFromExternalText('---\r\ntitle: x\r\neditor: native\r\n---\r\n\r\nbody')).toBe('native');
    expect(editorChoiceFromExternalText('editor:: logseq\r\n- a block')).toBe('logseq');
  });

  it('no property, unknown value, unclosed fence → null', () => {
    expect(editorChoiceFromExternalText('# just a note\n\nsome text')).toBeNull();
    expect(editorChoiceFromExternalText('---\ntitle: x\n---\nbody')).toBeNull();
    expect(editorChoiceFromExternalText('editor:: maybe\n- a block')).toBeNull();
    expect(editorChoiceFromExternalText('---\neditor: native\nno closing fence')).toBeNull();
  });

  it('indented editor:: inside a block is NOT a page property', () => {
    expect(editorChoiceFromExternalText('- a block\n  editor:: logseq')).toBeNull();
  });

  it('a content line ends the page-properties run', () => {
    expect(editorChoiceFromExternalText('some prose\neditor:: logseq')).toBeNull();
  });

  it('frontmatter wins and post-fence editor:: is not consulted (matches docPageProps)', () => {
    expect(editorChoiceFromExternalText('---\ntitle: x\n---\neditor:: native\n- a block')).toBeNull();
    expect(editorChoiceFromExternalText('---\neditor: logseq\n---\neditor:: native\n- a block')).toBe('logseq');
  });
});

describe('docPageProps', () => {
  it('reads the props-only first block (Logseq format)', () => {
    const doc = parseDocument('editor:: native\ntype:: book\n- a block');
    expect(docPageProps(doc)).toEqual({ editor: 'native', type: 'book' });
  });

  it('returns empty for files without page properties', () => {
    expect(docPageProps(parseDocument('- just a block'))).toEqual({});
    expect(docPageProps(parseDocument(''))).toEqual({});
  });

  it('returns empty when the first block is frontmatter (registry covers blocks[0] only)', () => {
    const doc = parseDocument('---\ntitle: x\n---\neditor:: native\n- a block');
    expect(docPageProps(doc)).toEqual({});
    // ...the frontmatter channel carries `editor` instead:
    expect(editorChoiceFromProps({ title: 'x', editor: 'native' })).toBe('native');
  });
});
